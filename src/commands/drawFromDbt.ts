/**
 * **Draw from dbt…** (`erdStudio.drawFromDbt`) — the no-AI route to a first
 * diagram. It reads the dbt project's schema yml and manifest, asks which
 * models to draw (a folder, a connected cluster or a hand-picked list), and
 * writes a LOGICAL draft: one `logical-models/*.yml` per model the library
 * does not have yet, copied from dbt the way the canvas's Add Existing Model
 * copies one, plus a new domain file with `viewConfig: {}` so the canvas lays
 * it out on first open. The physical stage stays derived; nothing here
 * persists it — the draft is a starting point the user asked for and edits.
 *
 * The scopes and the draft come from the pure `src/services/dbtDraft.ts`;
 * the picker is `src/providers/dbtDraftPicker.ts`. Every service is injected
 * so `activate()` wires the real ones and the refreshes stay in extension.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  buildDbtDraft,
  buildDraftSubjectAreaDocument,
  listDraftModels,
  listDraftScopes,
  serializeDraftSubjectAreaDocument,
  suggestSubjectAreaName,
  type DbtDraft,
  type DraftSkipped,
} from '../services/dbtDraft';
import { pickDraftScope } from '../providers/dbtDraftPicker';
import { dirtyFiles } from '../providers/dirtyDocuments';
import { drawnDiagramCopies, routeToLibrary, usesLibraryRelationships } from '../services/libraryRelationships';
import { readSubjectAreaRelationships } from './moveRelationshipsToLibrary';
import { ownWrites } from '../services/ownWriteTracker';
import { SUBJECT_AREA_EDITOR_VIEW_TYPE } from '../services/recoveryService';
import { telemetry } from '../services/telemetryService';
import type { SubjectAreaService } from '../services/domainService';
import type { LayerService } from '../services/layerService';
import { DuplicateKeyWriteRefused, RelationshipsRewriteRefused, type TableLibraryService } from '../services/logicalModelService';
import type { CatalogData } from '../types/catalog';
import type { ManifestData } from '../types/manifest';
import type { YmlData } from '../types/ymlData';

export const DRAW_FROM_DBT_COMMAND = 'erdStudio.drawFromDbt';

const TITLE = 'Draw from dbt';

/**
 * Shown when no model has columns to draw. `listDraftModels` takes a model's
 * columns from its schema yml, else the manifest — which is a compiled copy
 * of the same yml, so running dbt adds none. catalog.json only fills in the
 * types of those columns, never adds one.
 */
export const NO_DBT_MODELS_MESSAGE =
  'No dbt models with columns found. Draw from dbt reads the columns listed in your schema .yml files — ' +
  'add columns: to your models there, then try again.';

export interface DrawFromDbtDeps {
  workspaceRoot: string;
  semanticDir: string;
  /** `model-paths` from dbt_project.yml. */
  modelPaths: readonly string[];
  layerService: Pick<LayerService, 'getValidLayerIds' | 'getCreatableLayers' | 'getAllLayers' | 'saveConfig'>;
  subjectAreaService: Pick<SubjectAreaService, 'listSubjectAreas' | 'countSubjectAreaFileRelationships'>;
  tableLibraryService: Pick<
    TableLibraryService,
    'tableExists' | 'saveTable' | 'serializeTable' | 'groupsByFolder' | 'deleteTable' | 'listTables' | 'getTable' | 'hasUnreadableRelationships' | 'tablePath' | 'getTablesDir'
  >;
  /** Schema yml, manifest and catalog; each may be undefined (no yml, never compiled, no `dbt docs generate`). */
  loadDbt: () => Promise<{ ymlData?: YmlData; manifest?: ManifestData; catalog?: CatalogData }>;
  /** `createDomain`'s rule for a new domain slug in `layer` (undefined = valid). */
  validateDomainName: (value: string, layer: string) => string | undefined;
  /** Every file is written; refresh the tree, model library, context keys and selectors. */
  onWritten: (written: { domainPath: string; modelNames: string[] }) => void;
}

export interface DrawFromDbtResult {
  domainPath: string;
  draft: DbtDraft;
}

/**
 * Run the flow. Resolves undefined when the user cancels, when there is
 * nothing to draw, or when a write fails (each case has already said so).
 * Anything that throws is counted and rethrown.
 */
export async function drawFromDbt(deps: DrawFromDbtDeps): Promise<DrawFromDbtResult | undefined> {
  telemetry.feature('drawStarted');
  try {
    return await runDrawFromDbt(deps);
  } catch (err) {
    telemetry.error('drawFromDbtFailed');
    throw err;
  }
}

async function runDrawFromDbt(deps: DrawFromDbtDeps): Promise<DrawFromDbtResult | undefined> {
  const { workspaceRoot, semanticDir, layerService, subjectAreaService, tableLibraryService } = deps;

  const { ymlData, manifest, catalog } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Reading your dbt project…' },
    () => deps.loadDbt(),
  );
  // #113: no manifest (never compiled, or removed) — `loadDbt` passes undefined then.
  if (!manifest) { telemetry.featureOnce('manifestMissingDraw'); }

  const layerIds = layerService.getValidLayerIds();
  const source = { ymlData, manifest, projectRoot: workspaceRoot, modelPaths: deps.modelPaths, layerIds };
  const models = listDraftModels(source);
  if (models.length === 0) {
    telemetry.feature('drawNoModels');
    void vscode.window.showInformationMessage(NO_DBT_MODELS_MESSAGE);
    return undefined;
  }
  const pick = await pickDraftScope(listDraftScopes(source), { models, title: TITLE });
  if (!pick) { telemetry.feature('drawCancelScope'); return undefined; }

  // Layer: the one the dbt folder names (marts → gold, …) when it is a layer
  // here; otherwise ask, unless there is only one to choose.
  const creatable = layerService.getCreatableLayers();
  if (creatable.length === 0) {
    telemetry.feature('drawNoLayers');
    void vscode.window.showErrorMessage('No layers are configured for new diagrams. Add a layer first.');
    return undefined;
  }
  let layer = creatable.find((l) => l.id === pick.scope.suggestedLayer)?.id;
  if (!layer && creatable.length === 1) { layer = creatable[0].id; }
  if (!layer) {
    const choice = await vscode.window.showQuickPick(
      creatable.map((l) => ({ label: l.label, description: l.id === l.label.toLowerCase() ? undefined : l.id, id: l.id })),
      { title: TITLE, placeHolder: 'Which layer is this diagram for?', ignoreFocusOut: true },
    );
    if (!choice) { telemetry.feature('drawCancelLayer'); return undefined; }
    layer = choice.id;
  }
  const layerLabel = creatable.find((l) => l.id === layer)?.label ?? layer;

  const existingDomains = subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir);
  const suggested = suggestSubjectAreaName(pick.scope, existingDomains.filter((d) => d.layer === layer).map((d) => d.domain));
  const chosenLayer = layer;
  const name = await vscode.window.showInputBox({
    title: TITLE,
    prompt: `Name the diagram. It is saved in the ${layerLabel} layer.`,
    value: suggested,
    ignoreFocusOut: true,
    validateInput: (value: string) => deps.validateDomainName(value, chosenLayer),
  });
  if (!name) { telemetry.feature('drawCancelName'); return undefined; }
  const slug = name.trim();

  const draft = buildDbtDraft({
    modelNames: pick.modelNames,
    ymlData,
    manifest,
    catalog,
    libraryHas: (n) => tableLibraryService.tableExists(n),
  });
  if (draft.modelNames.length === 0) {
    telemetry.feature('drawNothingDrawable');
    void vscode.window.showWarningMessage(`${TITLE}: none of the chosen models could be drawn. ${describeSkipped(draft.skipped)}`);
    return undefined;
  }

  const layerDir = path.join(workspaceRoot, semanticDir, chosenLayer);
  const domainPath = path.join(layerDir, `${slug}.json`);
  if (fs.existsSync(domainPath)) {
    void vscode.window.showErrorMessage(`A diagram named "${slug}" already exists in the ${layerLabel} layer.`);
    return undefined;
  }

  // Decided once, before the first file lands: an empty library would
  // otherwise read as "flat" after one top-level write. A flat library stays
  // flat; one already grouped by layer gets this layer's folder.
  // Relationships go to their from-models' library files when the project
  // keeps them there (#126) — decided, like the folder, before any write.
  // A model file it would write that is open with unsaved edits stops the
  // draw before anything is written, as a canvas edit does.
  let folder: string | undefined;
  let routed: { kept: DbtDraft['relationships']; changed: DbtDraft['newModels'] };
  let dirty: string[];
  try {
    folder = tableLibraryService.groupsByFolder(new Set(layerService.getValidLayerIds())) ? chosenLayer : undefined;
    routed = usesLibraryRelationships(
      tableLibraryService.listTables(),
      subjectAreaService.countSubjectAreaFileRelationships(workspaceRoot, semanticDir),
      tableLibraryService.hasUnreadableRelationships(),
    )
      ? routeToLibrary(draft.relationships, draft.newModels, (n) => tableLibraryService.getTable(n),
        drawnDiagramCopies(readSubjectAreaRelationships(subjectAreaService, workspaceRoot, semanticDir)))
      : { kept: draft.relationships, changed: [] };
    dirty = dirtyFiles([
      ...draft.newModels.map((m) => tableLibraryService.tablePath(m.name, folder)),
      ...routed.changed.map((m) => tableLibraryService.tablePath(m.name)),
    ]);
    // Throws DuplicateKeyWriteRefused for a library file that is read but may
    // not be written (#164), or RelationshipsRewriteRefused, before the diagram
    // is on disk rather than after.
    for (const model of routed.changed) tableLibraryService.serializeTable(model);
  } catch (err) {
    if (err instanceof DuplicateKeyWriteRefused || err instanceof RelationshipsRewriteRefused) {
      void vscode.window.showErrorMessage(`${TITLE}: ${err.message} Nothing was changed.`);
      return undefined;
    }
    telemetry.error('drawFromDbtFailed');
    void vscode.window.showErrorMessage(
      `${TITLE} could not read the Table Library to plan the diagram: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`,
    );
    return undefined;
  }
  if (dirty.length > 0) {
    const libraryRoot = path.dirname(tableLibraryService.getTablesDir());
    const file = path.relative(libraryRoot, dirty[0]).split(path.sep).join('/');
    void vscode.window.showErrorMessage(
      `${TITLE}: ${file} has unsaved changes. Save or revert it, then try again. Nothing was changed.`,
    );
    return undefined;
  }

  // Writes start here. A project with no ERD folder yet gets the default
  // layers.json first, exactly as Set Up Semantic Domains Directory writes it.
  const written: string[] = [];
  try {
    if (!fs.existsSync(path.join(workspaceRoot, semanticDir))) {
      await layerService.saveConfig(layerService.getAllLayers());
    }
    fs.mkdirSync(layerDir, { recursive: true });

    for (const model of draft.newModels) {
      tableLibraryService.saveTable(model, folder);
      written.push(model.name);
    }

    const doc = buildDraftSubjectAreaDocument({
      domain: slug,
      layer: chosenLayer,
      description: `Drawn from dbt: ${pick.scope.label}.`,
      modelNames: draft.modelNames,
      relationships: routed.kept,
    });
    fs.writeFileSync(domainPath, serializeDraftSubjectAreaDocument(doc), { encoding: 'utf-8', flag: 'wx' });
    ownWrites.recordWrite(domainPath);
    // Existing library models that gained a relationship, once the diagram is on disk.
    for (const model of routed.changed) {
      if (!draft.newModels.includes(model)) tableLibraryService.saveTable(model);
    }
  } catch (err) {
    // Leave no orphan model files behind a domain that was never written.
    for (const modelName of written) {
      try { tableLibraryService.deleteTable(modelName); } catch { /* best effort */ }
    }
    const exists = err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST';
    if (!exists) { telemetry.error('drawWriteFailed'); }
    const msg = exists
      ? `A diagram named "${slug}" already exists in the ${layerLabel} layer.`
      : `${TITLE} could not write the diagram: ${err instanceof Error ? err.message : String(err)}`;
    void vscode.window.showErrorMessage(msg);
    return undefined;
  }

  deps.onWritten({ domainPath, modelNames: written });
  telemetry.feature('drawFromDbt');

  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(domainPath), SUBJECT_AREA_EDITOR_VIEW_TYPE);

  const notice = describeDraftNotice(draft);
  if (notice) { void vscode.window.showInformationMessage(notice); }
  return { domainPath, draft };
}

/** The one-line note after drawing — only when something was left out. */
export function describeDraftNotice(draft: Pick<DbtDraft, 'modelNames' | 'skipped' | 'truncated'>): string | undefined {
  const overLimit = draft.skipped.filter((s) => s.reason === 'over-limit').length;
  const other = draft.skipped.filter((s) => SKIP_REASONS_WORTH_NAMING.has(s.reason));
  const parts: string[] = [];
  if (draft.truncated && overLimit > 0) {
    parts.push(
      `Drew the ${draft.modelNames.length} best-connected tables and left ${overLimit} out to keep the diagram readable. ` +
        'Add more from the canvas.',
    );
  }
  if (other.length > 0) { parts.push(describeSkipped(other)); }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** A repeated pick or the cap is not worth a sentence; these are. */
const SKIP_REASONS_WORTH_NAMING = new Set<DraftSkipped['reason']>(['invalid-name', 'not-found', 'disabled']);

function describeSkipped(skipped: readonly DraftSkipped[]): string {
  const relevant = skipped.filter((s) => SKIP_REASONS_WORTH_NAMING.has(s.reason));
  if (relevant.length === 0) { return ''; }
  const names = relevant.slice(0, 3).map((s) => s.name).join(', ');
  const more = relevant.length > 3 ? ` and ${relevant.length - 3} more` : '';
  return `Skipped ${names}${more}: disabled in dbt, missing columns, or a name ERD Studio cannot use.`;
}
