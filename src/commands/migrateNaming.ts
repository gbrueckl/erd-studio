/**
 * ERD Studio: Migrate to the New File Naming (#182, part 4 of #162).
 *
 * Moves a v5 project's files to the v6 table naming — `logical-models/` →
 * `tables/`, and in each file only the keys the naming renames — as
 * `planNamingMigration` plans it. Prompted, with the whole plan in the
 * dialog; one `WorkspaceEdit`, so Edit > Undo straight after (while an
 * editor is still open; VS Code drops the step once none is) puts every
 * file back, and
 * nothing is written unless VS Code applies it.
 *
 * A table file is moved by file operations only — a rename, or a delete and
 * a create holding its new text — so undoing it restores the old bytes
 * without leaving an unsaved buffer behind. A subject area file is rewritten
 * in place and saved; an undo or redo of it (Edit > Undo) is saved too
 * (`saveMigratedOnUndo`), so the files on disk follow the undo.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { LOGICAL_MODELS_DIR, TABLES_DIR } from '@erd-studio/core';

import { dirtyFiles } from '../providers/dirtyDocuments';
import { saveDocumentByUri } from '../providers/documentSave';
import type { SubjectAreaService } from '../services/domainService';
import type { TableLibraryService } from '../services/logicalModelService';
import { describeNamingMigration, namingMigrationIsEmpty, planNamingMigration } from '../services/namingMigration';
import type { NamingMigrationPlan } from '../services/namingMigration';
import { readNamingMigrationInput } from '../services/namingMigrationFiles';
import { ownWrites } from '../services/ownWriteTracker';
import { telemetry } from '../services/telemetryService';

export const MIGRATE_NAMING_TITLE = 'Migrate to the New File Naming';

/** The one migrate button, on the prompt and in the dialog. */
export const MIGRATE_NAMING_BUTTON = 'Migrate';

export interface MigrateNamingDeps {
  workspaceRoot: string;
  semanticDir: string;
  subjectAreaService: Pick<SubjectAreaService, 'listSubjectAreas'>;
  tableLibraryService: Pick<TableLibraryService, 'listTableFiles' | 'invalidateCache'>;
  /** This extension's version, for "teammates need ERD Studio X or later". */
  version: string;
  /** Runs "Migrate Subject Areas to the Central Table Library" for v4 files; true when it converted them. */
  migrateToV5?: () => Promise<boolean>;
  /** Every file the migration wrote (old and new paths): refresh the views and open canvases. */
  onMigrated: (paths: string[]) => Promise<void>;
  /** Hold open canvases' refreshes while the edit applies; returns the release. */
  holdRefreshes?: () => () => void;
}

/** Subject area files a migration rewrote this session: an undo or redo of one is saved (#182). */
const migratedSubjectAreas = new Set<string>();
/** Folders a migration created (`tables/`, `tables/{layer}/`): removed again when an undo leaves them empty. */
const createdFolders = new Set<string>();
let undoListeners: vscode.Disposable[] = [];

/** Remove each folder a migration created that is empty again (an undo moved its files back). */
function removeEmptiedFolders(): void {
  for (const folder of [...createdFolders].sort((a, b) => b.length - a.length)) {
    try { if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder); } catch { /* gone, or in use again */ }
  }
}

/**
 * Save a migrated subject area file whenever VS Code undoes or redoes it,
 * wherever the undo was typed: the table files move back by file
 * operations, and without this the subject areas would be reverted in
 * memory only, leaving the project half v5 and half v6 on disk. One
 * listener for the session, covering every migration made in it.
 */
function saveMigratedOnUndo(paths: readonly string[], folders: Iterable<string>): void {
  for (const p of paths) migratedSubjectAreas.add(path.resolve(p));
  for (const f of folders) createdFolders.add(path.resolve(f));
  for (const listener of undoListeners) listener.dispose();
  // An undo of the file operations alone (no canvas was open) fires these, not a text change.
  const later = (): void => { setTimeout(removeEmptiedFolders, 50); };
  undoListeners = [
    vscode.workspace.onDidDeleteFiles?.(later),
    vscode.workspace.onDidRenameFiles?.(later),
  ].filter((d): d is vscode.Disposable => !!d);
  undoListeners.push(vscode.workspace.onDidChangeTextDocument((e) => {
    const undoRedo = e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo;
    if (!undoRedo || !migratedSubjectAreas.has(path.resolve(e.document.uri.fsPath))) return;
    // After the rest of the step has landed, as the canvas's own undo flush waits.
    setTimeout(() => {
      // An empty `tables/` left by an undo would read as a layer folder.
      removeEmptiedFolders();
      if (!e.document.isDirty) return;
      void e.document.save().then((saved) => { if (saved) ownWrites.recordWrite(e.document.uri.fsPath); });
    }, 50);
  }));
}

export type MigrateNamingOutcome = 'migrated' | 'nothing' | 'refused' | 'cancelled' | 'failed';

/** Why the new naming, for the prompt and the dialog. */
export function namingMigrationReason(version: string): string {
  return 'ERD Studio now says "table" and "subject area", and its files can say so too: the Table Library moves from ' +
    `.erd-studio/${LOGICAL_MODELS_DIR}/ to .erd-studio/${TABLES_DIR}/, and keys such as "domain" and "logical.models" become ` +
    `"subjectArea" and "logical.tables". Teammates need ERD Studio ${version} or later to open the migrated files.`;
}

/** The plan as the user reads it in the dialog. */
function confirmDetail(plan: NamingMigrationPlan, version: string): string {
  return `${namingMigrationReason(version)}\n\n${describeNamingMigration(plan)}\n\n` +
    'Only those keys change; every comment, relationship and other value stays as written. Edit > Undo, straight after, puts every file back; after that, use source control.';
}

/** The command. Never throws: anything unexpected is shown as an error. */
export async function migrateToTableNaming(deps: MigrateNamingDeps): Promise<MigrateNamingOutcome> {
  try {
    return await runMigration(deps);
  } catch (err) {
    console.error('[migrateNaming] failed:', err);
    void vscode.window.showErrorMessage(`${MIGRATE_NAMING_TITLE} failed: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`);
    return 'failed';
  }
}

/** The plan for the project as it is on disk now. */
export function planProjectNamingMigration(deps: Pick<MigrateNamingDeps, 'workspaceRoot' | 'semanticDir' | 'subjectAreaService' | 'tableLibraryService'>): NamingMigrationPlan {
  deps.tableLibraryService.invalidateCache();
  return planNamingMigration(readNamingMigrationInput(deps.workspaceRoot, deps.semanticDir, deps.subjectAreaService, deps.tableLibraryService));
}

async function runMigration(deps: MigrateNamingDeps): Promise<MigrateNamingOutcome> {
  const semanticRoot = path.join(deps.workspaceRoot, deps.semanticDir);
  const abs = (rel: string): string => path.join(semanticRoot, ...rel.split('/'));
  let plan = planProjectNamingMigration(deps);

  // v4 files go through the v5 migration first (its own prompt), and then straight on here (#182).
  if (plan.v4SubjectAreas.length > 0 && plan.refusals.length === 1 && deps.migrateToV5) {
    if (!(await deps.migrateToV5())) return 'cancelled';
    plan = planProjectNamingMigration(deps);
  }
  if (plan.refusals.length > 0) {
    void vscode.window.showWarningMessage(`${MIGRATE_NAMING_TITLE}: nothing was changed.`, { modal: true, detail: describeNamingMigration(plan) });
    return 'refused';
  }
  if (namingMigrationIsEmpty(plan)) {
    void vscode.window.showInformationMessage(`${MIGRATE_NAMING_TITLE}: this project already uses the new file naming.`);
    return 'nothing';
  }

  const touched = [...plan.moves.flatMap((m) => [abs(m.from), abs(m.to)]), ...plan.rewrites.map((r) => abs(r.path))];
  const dirty = dirtyFiles(touched).map((p) => path.relative(deps.workspaceRoot, p).split(path.sep).join('/'));
  if (dirty.length > 0) {
    void vscode.window.showErrorMessage(
      `${MIGRATE_NAMING_TITLE}: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ''} ` +
        `${dirty.length === 1 ? 'has' : 'have'} unsaved edits. Save or revert ${dirty.length === 1 ? 'it' : 'them'}, then migrate. Nothing was changed.`,
    );
    return 'refused';
  }

  const choice = await vscode.window.showInformationMessage(
    'Move this project to the new file naming?',
    { modal: true, detail: confirmDetail(plan, deps.version) },
    MIGRATE_NAMING_BUTTON,
  );
  if (choice !== MIGRATE_NAMING_BUTTON) {
    return 'cancelled';
  }
  // The dialog may have waited: plan again from the files as they are now.
  const again = planProjectNamingMigration(deps);
  if (again.refusals.length > 0 || describeNamingMigration(again) !== describeNamingMigration(plan)
    || dirtyFiles(touched).length > 0) {
    void vscode.window.showWarningMessage(`${MIGRATE_NAMING_TITLE}: the project changed while the dialog was open. Nothing was changed; run it again.`);
    return 'cancelled';
  }
  plan = again;

  const edit = new vscode.WorkspaceEdit();
  const newFolders = new Set<string>();
  for (const move of plan.moves) {
    const to = abs(move.to);
    for (let dir = path.dirname(to); dir.length > semanticRoot.length && !fs.existsSync(dir); dir = path.dirname(dir)) newFolders.add(dir);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (move.text === undefined) {
      edit.renameFile(vscode.Uri.file(abs(move.from)), vscode.Uri.file(to), { overwrite: false });
    } else {
      edit.createFile(vscode.Uri.file(to), { overwrite: false, contents: Buffer.from(move.text, 'utf-8') });
      edit.deleteFile(vscode.Uri.file(abs(move.from)), { ignoreIfNotExists: false });
    }
  }
  const docs: vscode.TextDocument[] = [];
  for (const rewrite of plan.rewrites) {
    // A text edit, never a delete and a create of the same path: VS Code
    // cannot undo that pair (it re-creates the file before deleting it).
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs(rewrite.path)));
    // VS Code keeps a BOM out of the document's text (and writes it back on save).
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), rewrite.text.replace(/^\uFEFF/, ''));
    docs.push(doc);
  }

  // Released (once) before the canvases redraw, or if anything throws first.
  const held = deps.holdRefreshes?.();
  let released = false;
  const release = (): void => { if (!released) { released = true; held?.(); } };
  try {
    return await applyMigration(deps, plan, edit, docs, newFolders, semanticRoot, abs, release);
  } finally {
    release();
  }
}

/** Apply the built edit, save, record own writes and tidy up; refreshes are held by the caller. */
async function applyMigration(
  deps: MigrateNamingDeps,
  plan: NamingMigrationPlan,
  edit: vscode.WorkspaceEdit,
  docs: vscode.TextDocument[],
  newFolders: Set<string>,
  semanticRoot: string,
  abs: (rel: string) => string,
  release: () => void,
): Promise<MigrateNamingOutcome> {
  const touched = [...plan.moves.flatMap((m) => [abs(m.from), abs(m.to)]), ...plan.rewrites.map((r) => abs(r.path))];
  if (!(await vscode.workspace.applyEdit(edit))) {
    for (const folder of [...newFolders].sort((a, b) => b.length - a.length)) {
      try { fs.rmdirSync(folder); } catch { /* not empty, or already gone */ }
    }
    telemetry.error('editRejected');
    void vscode.window.showErrorMessage(`${MIGRATE_NAMING_TITLE}: VS Code rejected the change; nothing was changed.`);
    return 'failed';
  }
  // Own writes only once the bytes are on disk, so the watchers skip them.
  const unsaved: string[] = [];
  for (const doc of docs) {
    if (await saveDocumentByUri(doc.uri)) ownWrites.recordWrite(doc.uri.fsPath);
    else unsaved.push(path.relative(deps.workspaceRoot, doc.uri.fsPath).split(path.sep).join('/'));
  }
  for (const move of plan.moves) {
    ownWrites.recordWrite(abs(move.to));
    ownWrites.recordDelete(abs(move.from));
  }
  // The folders the moves emptied go, so the project reads as v6 alone.
  const emptied = new Set(plan.moves.map((m) => path.dirname(abs(m.from))));
  for (const folder of [...emptied].sort((a, b) => b.length - a.length)) {
    try { if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder); } catch { /* already gone */ }
  }
  const v5Root = path.join(semanticRoot, LOGICAL_MODELS_DIR);
  try { if (fs.readdirSync(v5Root).length === 0) fs.rmdirSync(v5Root); } catch { /* already gone */ }

  saveMigratedOnUndo(docs.map((d) => d.uri.fsPath), newFolders);
  deps.tableLibraryService.invalidateCache();
  release();
  await deps.onMigrated(touched);
  if (unsaved.length > 0) {
    void vscode.window.showErrorMessage(
      `${MIGRATE_NAMING_TITLE}: could not save ${unsaved.join(', ')}; the change is open in the editor but not on disk. Save it from its tab.`,
    );
  } else {
    const parts = [
      plan.moves.length > 0 ? `${plan.moves.length} table file${plan.moves.length === 1 ? '' : 's'} moved to ${TABLES_DIR}/` : '',
      plan.rewrites.length > 0 ? `${plan.rewrites.length} subject area${plan.rewrites.length === 1 ? '' : 's'} updated` : '',
    ].filter(Boolean);
    void vscode.window.showInformationMessage(`Migrated to the new file naming: ${parts.join(', ')}. Edit > Undo, straight away, puts every file back.`);
  }
  return 'migrated';
}
