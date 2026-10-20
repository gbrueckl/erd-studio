/**
 * ERD Studio: Move Relationships to Model Library (issue #126).
 *
 * The opt-in for an existing project: every relationship its v5 domain files
 * hold is stored once, in the `logical-models/*.yml` of the model holding the
 * foreign key, and taken out of the domain files. A library entry already
 * stored on its "one" side (a `one-to-many`) is moved to that model too
 * (#133), so a new fact never means editing its dimensions. A relationship the domains define in different
 * ways (cardinality, role, or which end of a one-to-one holds the key) is
 * settled by the user — one QuickPick per conflict, naming the diagrams behind
 * each version — or left as it is in each diagram. Prompted.
 *
 * Disk is the one source of truth, and the files are written directly — not
 * through a WorkspaceEdit. 1.6.6 edited them through VS Code's documents and
 * then saved each one; on a large project VS Code had already disposed some of
 * those documents ("Document has been closed"), and an in-memory copy older
 * than disk refused to save ("File Modified Since"), so the move left every
 * file open and unsaved, or half applied. Now each new text is computed from
 * the file's current bytes with the surgical edits in `minimalEdits` (only the
 * relationships change), a file open with unsaved edits stops the move before
 * anything is written, and the writes are all-or-nothing: if one fails, every
 * file already written is put back.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { VALID_CARDINALITIES, linkKey, normaliseCompositeKey, normaliseRelationshipRole, normaliseSubjectAreaDocument, parseTableText } from '@erd-studio/core';
import { dirtyFiles } from '../providers/dirtyDocuments';
import {
  applyMoveToTable,
  describeConflictDefinition,
  describeLeftAlone,
  describeMovePlan,
  moveTargets,
  planMoveToLibrary,
  resolveConflict,
} from '../services/libraryRelationships';
import type { ConflictDefinition } from '../services/libraryRelationships';
import type { DbtKeyIndex } from '@erd-studio/core';
import { relationshipsRewriteLoses, setSubjectAreaRelationships, setYamlRelationships } from '../services/minimalEdits';
import { ownWrites } from '../services/ownWriteTracker';
import { telemetry } from '../services/telemetryService';
import { checkLibraryRewrite, moveUsage } from '../services/relationshipHealth';
import { detectSubjectAreaFormat } from '../types/semantic';
import type { Relationship, SemanticTable } from '../types/semantic';
import type { SubjectAreaService } from '../services/domainService';
import type { TableLibraryService } from '../services/logicalModelService';

const TITLE = 'Move Relationships to Table Library';

export interface MoveRelationshipsDeps {
  workspaceRoot: string;
  semanticDir: string;
  subjectAreaService: Pick<SubjectAreaService, 'listSubjectAreas'>;
  tableLibraryService: Pick<TableLibraryService, 'getTable' | 'listTables' | 'tablePath' | 'invalidateCache' | 'getTablesDir'>
    & Partial<Pick<TableLibraryService, 'findTableNameIgnoringCase' | 'hasTablesLibrary' | 'isTableNamingFile'>>;
  /** Refresh the trees, open canvases and selectors once the files are written. */
  onWritten: (domainPaths: string[]) => Promise<void>;
  /** Test seam: how one file is written. Defaults to {@link writeFileAtomic}. */
  writeFile?: (filePath: string, text: string) => void;
  /** dbt's key evidence (#133 L1), loaded once before planning. Without it, only key flags count. */
  loadDbtKeyIndex?: () => Promise<DbtKeyIndex>;
}

/** A v5 or v6 domain file's models and own relationships, as read from disk (v6 under its v5 keys, #182). */
export interface SubjectAreaRelationships {
  /** `{layer}/{domain}`, as the user knows it. */
  label: string;
  filePath: string;
  models: string[];
  relationships: Relationship[];
}

/** Every readable v5 and v6 domain file's models and `logical.relationships`. */
export function readSubjectAreaRelationships(
  subjectAreaService: Pick<SubjectAreaService, 'listSubjectAreas'>,
  workspaceRoot: string,
  semanticDir: string,
): SubjectAreaRelationships[] {
  const domains: SubjectAreaRelationships[] = [];
  for (const summary of subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir)) {
    try {
      const file = JSON.parse(fs.readFileSync(summary.filePath, 'utf-8')) as Record<string, unknown>;
      const format = detectSubjectAreaFormat(file);
      if (format !== 'v5' && format !== 'v6') continue;
      const raw = format === 'v6' ? normaliseSubjectAreaDocument(file) : file;
      const logical = raw.logical as { models?: unknown; relationships?: unknown } | undefined;
      const models = (Array.isArray(logical?.models) ? logical!.models : []).filter((m): m is string => typeof m === 'string');
      const relationships = (Array.isArray(logical?.relationships) ? logical!.relationships : [])
        .filter((r): r is Relationship => !!r && typeof r === 'object'
          && ['fromModel', 'fromColumn', 'toModel', 'toColumn'].every((k) => typeof (r as Record<string, unknown>)[k] === 'string'))
        // An unrecognised cardinality is drawn as many-to-one (core's parseRelationships);
        // the move stores what the diagram shows, never the typo.
        .map((r) => (VALID_CARDINALITIES.has(r.cardinality) ? r : { ...r, cardinality: 'many-to-one' as const }))
        .map(({ role, compositeKey, ...r }) => {
          const label = normaliseRelationshipRole(role);
          const key = normaliseCompositeKey(compositeKey);
          return { ...r, ...(label ? { role: label } : {}), ...(key ? { compositeKey: key } : {}) };
        });
      domains.push({ label: `${summary.layer}/${summary.domain}`, filePath: summary.filePath, models, relationships });
    } catch {
      // An unreadable domain keeps its relationships.
    }
  }
  return domains;
}

/**
 * Write `text` to `filePath` atomically: a unique temp file in the same folder,
 * then a rename over the target, so a reader never sees half a file.
 */
export function writeFileAtomic(filePath: string, text: string): void {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, text, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* the temp file may not exist */ }
    throw err;
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Refuse when any of `filePaths` is open with unsaved edits — the user's work
 * in progress; writing under it would leave VS Code holding a copy that no
 * longer matches disk. Returns true (and has told the user) when refused.
 */
function refuseIfDirty(filePaths: Iterable<string>, relPath: (filePath: string) => string): boolean {
  const dirty = dirtyFiles(filePaths).map(relPath);
  if (dirty.length === 0) return false;
  telemetry.error('relMoveDirtyFiles');
  const shown = dirty.slice(0, 5).join(', ') + (dirty.length > 5 ? ` and ${dirty.length - 5} more` : '');
  void vscode.window.showErrorMessage(
    `${TITLE}: ${dirty.length === 1 ? 'a file it would change has' : `${dirty.length} files it would change have`} unsaved edits — ${shown}. ` +
    'Save or revert these first, then run the move again. Nothing was changed.',
  );
  return true;
}

/**
 * The command. Never throws: anything unexpected is shown as an error and
 * counted, so neither the palette nor the canvas offer can swallow it.
 */
export async function moveRelationshipsToLibrary(deps: MoveRelationshipsDeps): Promise<void> {
  try {
    await runMove(deps);
  } catch (err) {
    telemetry.error('relMoveFailed');
    console.error('[moveRelationshipsToLibrary] failed:', err);
    void vscode.window.showErrorMessage(`${TITLE} failed: ${errorText(err)}`);
  }
}

async function runMove(deps: MoveRelationshipsDeps): Promise<void> {
  const { workspaceRoot, semanticDir, subjectAreaService, tableLibraryService } = deps;
  const writeFile = deps.writeFile ?? writeFileAtomic;
  telemetry.feature('relMoveStarted');
  // Read the library fresh: a cached copy may predate an edit made on disk.
  tableLibraryService.invalidateCache();
  const domains = readSubjectAreaRelationships(subjectAreaService, workspaceRoot, semanticDir)
    .filter((d) => d.relationships.length > 0);

  // One object per model, whatever the spelling an entry uses (#133 L4):
  // `Dim_Customer` reaches dim_customer.yml on a case-sensitive file system,
  // and both spellings in one plan edit the same copy.
  const models = new Map<string, SemanticTable | null>();
  const libraryModel = (name: string): SemanticTable | null => {
    const key = name.toLowerCase();
    if (!models.has(key)) models.set(key, tableLibraryService.getTable(tableLibraryService.findTableNameIgnoringCase?.(name) ?? name));
    return models.get(key) ?? null;
  };
  /** The model's file, by its real name. */
  const pathOf = (name: string): string => tableLibraryService.tablePath(libraryModel(name)?.name ?? name);
  const libraryRoot = path.dirname(tableLibraryService.getTablesDir());
  const relPath = (filePath: string): string => path.relative(libraryRoot, filePath).split(path.sep).join('/');
  const fileOf = (model: string): string => relPath(pathOf(model));
  // A file whose relationships list holds comments, YAML anchors or unreadable entries is
  // never rewritten: re-rendering the list would lose them.
  const lockedFiles = new Map<string, boolean>();
  const locked = (name: string): boolean => {
    if (!lockedFiles.has(name)) {
      let loses = false;
      try {
        loses = relationshipsRewriteLoses(fs.readFileSync(pathOf(name), 'utf-8'));
      } catch {
        // Unreadable: the plan already leaves a model with no readable file alone.
      }
      lockedFiles.set(name, loses);
    }
    return lockedFiles.get(name)!;
  };
  // dbt's tests orient links between models that flag no key (#133 L1).
  const dbt = deps.loadDbtKeyIndex ? await deps.loadDbtKeyIndex().catch(() => undefined) : undefined;
  let plan = planMoveToLibrary(domains, libraryModel, tableLibraryService.listTables(), locked, { dbt });
  if (plan.removeFromDomains.size === 0 && plan.conflicts.length === 0 && plan.rehome.length === 0) {
    telemetry.feature('relMoveNothingToMove');
    const leftAlone = describeLeftAlone(plan, fileOf);
    if (leftAlone.length > 0) {
      void vscode.window.showInformationMessage(
        `${TITLE}: nothing was moved.`,
        { modal: true, detail: leftAlone.join('\n').replace(/^\n/, '') },
      );
      return;
    }
    void vscode.window.showInformationMessage(
      `${TITLE}: nothing to move — ${domains.length === 0
        ? 'no diagram file holds a relationship of its own, and every relationship in the Table Library is stored with the table holding the foreign key.'
        : 'every relationship in the diagram files starts at a table with no readable file in logical-models/.'}`,
    );
    return;
  }
  // Checked before asking anything, so nobody settles conflicts only to be
  // turned away; checked again before writing, in case a file was edited
  // while the dialog was open.
  const candidates = [
    ...plan.toLibrary.map((r) => pathOf(r.fromModel)),
    // A conflict lands at either end, depending on the cardinality picked.
    ...plan.conflicts.flatMap((c) => [c.relationship.fromModel, c.relationship.toModel]).map(pathOf),
    ...plan.rehome.flatMap((r) => [r.from, r.to.fromModel]).map(pathOf),
    ...domains
      .filter((d) => plan.removeFromDomains.has(d.label) || plan.conflicts.some((c) => c.definitions.some((def) => def.domains.includes(d.label))))
      .map((d) => d.filePath),
  ];
  if (refuseIfDirty(candidates, relPath)) return;

  const onlyRehome = plan.removeFromDomains.size === 0 && plan.conflicts.length === 0;
  const choice = await vscode.window.showInformationMessage(
    onlyRehome
      ? 'Store each relationship with the table that holds the foreign key?'
      : 'Define each relationship once, in the Table Library?',
    {
      modal: true,
      detail: `${describeMovePlan(plan, fileOf)}\n\nThe move saves the files directly — use git (or your source control) to undo it.`,
    },
    plan.conflicts.length > 0 ? 'Continue' : 'Move Relationships',
  );
  if (choice !== 'Continue' && choice !== 'Move Relationships') {
    telemetry.feature('relMoveCancelled');
    return;
  }

  // Each conflict is the user's to settle: which version every diagram draws.
  const conflicts = plan.conflicts;
  if (conflicts.length > 0) telemetry.feature('relMoveConflictShown');
  for (const [index, conflict] of conflicts.entries()) {
    const { fromModel, fromColumn, toModel, toColumn } = conflict.relationship;
    const picked = await vscode.window.showQuickPick(
      [
        ...conflict.definitions.map((d) => ({
          label: describeConflictDefinition(d),
          description: `as in ${d.domains.join(', ')}`,
          detail: `Saved once in ${fileOf(d.relationship.fromModel)}; every diagram with ${fromModel} and ${toModel} draws it this way.`,
          definition: d as ConflictDefinition | undefined,
        })),
        {
          label: 'Leave it as it is in each diagram',
          description: 'decide later',
          detail: 'It stays in the diagram files. Run this command again to settle it.',
          definition: undefined,
        },
      ],
      {
        title: `Conflict ${index + 1} of ${conflicts.length}: ${fromModel}.${fromColumn} ↔ ${toModel}.${toColumn}`,
        placeHolder: 'The diagrams draw this link differently. Which version should every diagram use? (Esc cancels the move)',
        ignoreFocusOut: true,
      },
    );
    if (!picked) {
      telemetry.feature('relMoveCancelled');
      void vscode.window.showInformationMessage(`${TITLE}: cancelled — nothing was changed.`);
      return;
    }
    if (picked.definition) plan = resolveConflict(plan, conflict, picked.definition);
  }
  if (plan.removeFromDomains.size === 0 && plan.rehome.length === 0) {
    telemetry.feature('relMoveCancelled');
    void vscode.window.showInformationMessage(`${TITLE}: nothing was changed.`);
    return;
  }

  // The plan is final. Every new text is computed from the file's bytes on
  // disk now — after the modal and the QuickPicks, which may have taken a
  // while — changing only its relationships.
  const writes: Array<{ filePath: string; original: string; text: string }> = [];
  // Every target file as read and as it will be written, for the self-check below.
  const readModels: SemanticTable[] = [];
  const nextModels: SemanticTable[] = [];
  for (const target of moveTargets(plan)) {
    const name = libraryModel(target)?.name ?? target;
    const filePath = tableLibraryService.tablePath(name);
    const original = fs.readFileSync(filePath, 'utf-8');
    if (relationshipsRewriteLoses(original)) {
      throw new Error(`${relPath(filePath)} changed while the dialog was open (its relationships list now has comments, YAML anchors or entries it cannot read). Nothing was changed.`);
    }
    const model = parseTableText(original, name);
    if (!model) throw new Error(`${relPath(filePath)} could not be read as a table file.`);
    const copy: SemanticTable = { ...model, relationships: model.relationships ? [...model.relationships] : undefined };
    readModels.push(model);
    nextModels.push(copy);
    if (!applyMoveToTable(plan, copy)) continue;
    // A file in `tables/` is written in the v6 naming (#182); otherwise in whichever the file uses.
    const text = setYamlRelationships(original, copy.relationships ?? [], tableLibraryService.isTableNamingFile?.(filePath) || undefined);
    if (text !== original) writes.push({ filePath, original, text });
  }
  const domainPaths: string[] = [];
  for (const domain of domains) {
    const keys = plan.removeFromDomains.get(domain.label);
    if (!keys) continue;
    const original = fs.readFileSync(domain.filePath, 'utf-8');
    const parsed = JSON.parse(original) as Record<string, unknown>;
    // A v6 file (#182) is read under its v5 keys; setSubjectAreaRelationships writes it back in v6.
    const raw = (detectSubjectAreaFormat(parsed) === 'v6' ? normaliseSubjectAreaDocument(parsed) : parsed) as { logical?: { relationships?: unknown } };
    const current = Array.isArray(raw.logical?.relationships) ? raw.logical!.relationships as Relationship[] : [];
    const isRelationship = (r: unknown): r is Relationship => !!r && typeof r === 'object'
      && ['fromModel', 'fromColumn', 'toModel', 'toColumn'].every((k) => typeof (r as Record<string, unknown>)[k] === 'string');
    const kept = current.filter((r) => !isRelationship(r) || !keys.has(linkKey(r)));
    if (kept.length === current.length) continue;
    const text = setSubjectAreaRelationships(original, kept);
    if (text === original) continue;
    writes.push({ filePath: domain.filePath, original, text });
    domainPaths.push(domain.filePath);
  }

  if (refuseIfDirty(writes.map((w) => w.filePath), relPath)) return;

  // Self-check of the planned rewrite (#133 telemetry): recorded and logged, never blocking it.
  const broken = checkLibraryRewrite(readModels, nextModels, [...plan.toLibrary, ...plan.rehome.map((r) => r.to)]);
  if (broken.length > 0) {
    telemetry.relationshipInvariants(broken);
    console.warn(`[moveRelationshipsToLibrary] relationship self-check: ${broken.join(', ')}`);
  }

  // All or nothing: if one write fails, every file already written is put back.
  const written: typeof writes = [];
  for (const write of writes) {
    try {
      writeFile(write.filePath, write.text);
    } catch (err) {
      const unrestored: string[] = [];
      for (const done of written.reverse()) {
        try {
          writeFile(done.filePath, done.original);
          ownWrites.recordWrite(done.filePath);
        } catch {
          unrestored.push(relPath(done.filePath));
        }
      }
      tableLibraryService.invalidateCache();
      telemetry.error('relMoveWriteFailed');
      if (unrestored.length > 0) telemetry.error('relMoveRestoreFailed');
      void vscode.window.showErrorMessage(
        `${TITLE}: could not write ${relPath(write.filePath)} (${errorText(err)}). ` +
        (unrestored.length === 0
          ? 'Every file was put back as it was; nothing was changed.'
          : `These files could not be put back and are half moved: ${unrestored.join(', ')}. Restore them from source control.`),
      );
      return;
    }
    written.push(write);
    // Recorded once the bytes are on disk (the tracker stats the file), so
    // the watchers skip this write; the caller issues the refreshes.
    ownWrites.recordWrite(write.filePath);
  }

  tableLibraryService.invalidateCache();
  try {
    await deps.onWritten(domainPaths);
  } catch (err) {
    // The files are written; a failed refresh must not report the move as failed.
    console.error('[moveRelationshipsToLibrary] refresh after the move failed:', err);
  }

  const moved = plan.toLibrary.length;
  const turned = plan.rehome.length;
  const left = plan.conflicts.length + plan.skippedNoModel.length;
  const unsettled = plan.disagreements.length + plan.lockedFiles.length;
  telemetry.feature('relMoveCompleted');
  if (left + unsettled > 0) telemetry.feature('relMoveLeftover');
  telemetry.relationshipUsage(moveUsage(plan));
  const parts = [
    ...(moved > 0 || !turned ? [`Moved ${moved} relationship${moved === 1 ? '' : 's'} into the Table Library — each is now defined once.`] : []),
    ...(turned > 0 ? [`${turned} relationship${turned === 1 ? ' is' : 's are'} now stored with the table holding the foreign key.`] : []),
  ];
  void vscode.window.showInformationMessage(
    parts.join(' ') +
    (left > 0 ? ` ${left} stayed in the diagram files; run this command again to settle ${left === 1 ? 'it' : 'them'}.` : '') +
    (unsettled > 0 ? ' Some were left as they are for you to fix by hand, as the preview listed.' : ''),
  );
}
