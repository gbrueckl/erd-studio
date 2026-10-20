/**
 * The words for a command that failed (#189): whose problem it is, and what
 * to do next. A failure the user can act on (a folder they may not write, a
 * full disk, a diagram file with a mistake in it) is said in plain words; any
 * other failure is ERD Studio's, so the user is told so, never shown the raw
 * exception, and offered Send Feedback with that exception in the report,
 * redacted.
 *
 * vscode-free, so the commands' choices are unit-tested without a host and
 * the canvas's #186 wording is shared rather than copied.
 */

import * as path from 'path';

import { SubjectAreaFileError, SubjectAreaValidationError, type JsonSyntaxProblem } from '@erd-studio/core';

import { redactPaths, type FeedbackKind } from '../types/feedback';

/** The button that opens Send Feedback prefilled with the failure. */
export const SEND_FEEDBACK_BUTTON = 'Send Feedback';

/** What `erdStudio.reportBug` accepts as its prefill. */
export interface FeedbackPrefill {
  kind: FeedbackKind;
  title: string;
  description: string;
}

/**
 * The sentence for a failure that is ERD Studio's, not the user's: what was
 * happening (`while …`) and what it left behind (`so nothing was …`).
 */
export function oursMessage(title: string, doing: string, outcome: string): string {
  return `${title} hit a problem in ERD Studio ${doing}, so ${outcome}. This isn't something you did. Please send us a report.`;
}

/**
 * Send Feedback's prefill for a failure that is ours: the raw exception, which
 * the toast never shows, with every local path reduced to its shape.
 */
export function feedbackPrefill(title: string, doing: string, err: unknown): FeedbackPrefill {
  const raw = err instanceof Error ? err.message : String(err);
  return {
    kind: 'bug',
    title: `${title} failed`,
    description: redactPaths(`${title} hit a problem ${doing}.\n\nError: ${raw}`),
  };
}

/** Why a write failed, as far as the user can do something about it. */
export type WriteFailure = 'permission' | 'disk-full' | 'other';

/**
 * Node's errno codes (`fs`) and VS Code's `FileSystemError` codes
 * (`workspace.fs`, which reports EACCES as `NoPermissions`). A
 * `FileSystemError` for a full disk carries no code of its own, only the
 * errno in its message.
 */
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'NoPermissions']);
const DISK_FULL_CODES = new Set(['ENOSPC', 'EDQUOT']);

export function classifyWriteFailure(err: unknown): WriteFailure {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  if (PERMISSION_CODES.has(code)) return 'permission';
  if (DISK_FULL_CODES.has(code)) return 'disk-full';
  const message = err instanceof Error ? err.message : '';
  if (/\b(?:ENOSPC|EDQUOT)\b/.test(message)) return 'disk-full';
  if (/\b(?:EACCES|EPERM|EROFS)\b/.test(message)) return 'permission';
  return 'other';
}

/** The file a Node `fs` error names (`err.path`), when it names one. */
export function failedPath(err: unknown): string | undefined {
  const p = err && typeof err === 'object' && 'path' in err ? (err as { path: unknown }).path : undefined;
  return typeof p === 'string' && p.length > 0 ? p : undefined;
}

/** `filePath` relative to `root` with `/` separators; the base name when it is outside `root`. */
export function projectRelative(root: string, filePath: string): string {
  const rel = path.relative(root, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return path.basename(filePath);
  return rel.split(path.sep).join('/');
}

/** What a located JSON mistake looks like, in words (#186). */
const JSON_MISTAKE_HINTS: Record<JsonSyntaxProblem, string> = {
  'trailing-comma': 'there is a comma after the last item, before a closing } or ]',
  'missing-comma': 'a comma is missing after this value',
  truncated: 'the file stops before the JSON is complete, so a closing } or ] may be missing',
  unexpected: 'the text there is not valid JSON',
};

/**
 * The plain sentence for a domain file that is not valid JSON (#186): where
 * the mistake is, by line and column, rather than the parser's wording and
 * character offset. `shown` is the project-relative path.
 */
export function describeJsonMistake(shown: string, err: Pick<SubjectAreaFileError, 'line' | 'column' | 'syntaxProblem'>): string {
  if (err.line === undefined || err.column === undefined || err.syntaxProblem === undefined) {
    return `${shown} is not valid JSON.`;
  }
  return `${shown} has a mistake at line ${err.line}, column ${err.column}: ${JSON_MISTAKE_HINTS[err.syntaxProblem]}.`;
}

/** A diagram file the user has to fix, in words, and whether opening it helps. */
export interface DiagramFileProblem {
  /** Ends without a full stop: it follows "the diagram file has a problem: ". */
  reason: string;
  /** Open File is offered: the file is there to open. */
  openable: boolean;
  line?: number;
  column?: number;
}

/**
 * Why a diagram file could not be read, for a failure that is the file's
 * (core's `SubjectAreaFileError` / `SubjectAreaValidationError`), else
 * undefined. A message that names the file names it as `shown`.
 */
export function describeDiagramFileProblem(err: unknown, filePath: string, shown: string): DiagramFileProblem | undefined {
  if (err instanceof SubjectAreaFileError) {
    switch (err.reason) {
      case 'missing':
        return { reason: 'it was deleted or renamed', openable: false };
      case 'unreadable':
        return { reason: 'ERD Studio could not read it. Check that the file is not locked or blocked by permissions', openable: false };
      case 'empty':
        return { reason: 'it has no content', openable: true };
      case 'invalid-json': {
        if (err.mergeConflict) {
          return {
            reason: `it has unresolved git merge conflicts${err.line !== undefined ? `, first at line ${err.line}` : ''}. Keep one side of each conflict, then try again`,
            openable: true,
            ...(err.line !== undefined ? { line: err.line } : {}),
          };
        }
        const where = err.line !== undefined && err.column !== undefined && err.syntaxProblem !== undefined
          ? `there is a mistake at line ${err.line}, column ${err.column}: ${JSON_MISTAKE_HINTS[err.syntaxProblem]}`
          : 'it is not valid JSON';
        return {
          reason: where,
          openable: true,
          ...(err.line !== undefined ? { line: err.line } : {}),
          ...(err.column !== undefined ? { column: err.column } : {}),
        };
      }
    }
  }
  if (err instanceof SubjectAreaValidationError) {
    // Core's sentence names the file by its absolute path.
    const reason = redactPaths(err.message.split(filePath).join(shown)).replace(/\.\s*$/, '');
    return { reason, openable: true };
  }
  return undefined;
}
