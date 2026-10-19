/**
 * "A newer ERD Studio fixes this": the known-fixes registry and the decision
 * whether to tell the user to update.
 *
 * The registry is `telemetry/known-fixes.json`, served by the telemetry Worker
 * at `GET /known-fixes` (format in `telemetry/README.md`). Each entry names an
 * error code from {@link ERROR_CODES}, the first release with the fix and one
 * plain line saying what changed. When an error code is recorded on a version
 * older than an entry's `fixedIn`, the user is offered the update.
 *
 * Pure and vscode-free: storage, the network, the clock and the notification
 * are all injected by `knownFixesService.ts`, so every rule here is unit-tested
 * without an extension host. The request carries nothing about the user — no
 * query, no id, no version, no error code: the whole registry is fetched and
 * matched on the machine, so the server cannot tell which error happened.
 */

import { compareVersions, isVersionOlder, redactPaths } from '../types/feedback';
import { ERROR_CODES, type TelemetryErrorCode } from './telemetryPayload';

export interface KnownFix {
  code: TelemetryErrorCode;
  /** First release with the fix, `major.minor.patch`. */
  fixedIn: string;
  /** One plain sentence about what the fix changes for the user. */
  summary: string;
  /** The GitHub issue it fixed, when there was one. */
  issue?: number;
}

/** Longest `summary` accepted: one line of a notification. */
export const KNOWN_FIX_SUMMARY_MAX = 140;

/** A cached registry is used for this long before it is fetched again. */
export const KNOWN_FIXES_CACHE_MS = 24 * 60 * 60 * 1000;

/** The fetch is abandoned after this long. */
export const KNOWN_FIXES_TIMEOUT_MS = 3_000;

/** Upper bound on entries read from a response, so a runaway file costs nothing. */
export const KNOWN_FIXES_MAX_ENTRIES = 500;

const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Why `entry` is not a valid registry entry, or `null` when it is. The unit
 * test holds every entry of `telemetry/known-fixes.json` to this, and the
 * extension drops any fetched entry it rejects, so one bad entry can never
 * produce a wrong prompt or stop the others from working.
 */
export function knownFixProblem(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'not an object';
  const e = entry as Record<string, unknown>;
  if (typeof e.code !== 'string' || !KNOWN_CODES.has(e.code)) return 'code is not an ERROR_CODES key';
  if (typeof e.fixedIn !== 'string' || !SEMVER.test(e.fixedIn)) return 'fixedIn is not major.minor.patch';
  if (typeof e.summary !== 'string') return 'summary is not text';
  const summary = e.summary.trim();
  if (!summary) return 'summary is empty';
  if (summary.length > KNOWN_FIX_SUMMARY_MAX) return `summary is longer than ${KNOWN_FIX_SUMMARY_MAX} characters`;
  if (CONTROL_CHARS.test(summary)) return 'summary has a line break or control character';
  if (redactPaths(summary) !== summary) return 'summary contains a file path';
  if (e.issue !== undefined && !(typeof e.issue === 'number' && Number.isInteger(e.issue) && e.issue > 0)) {
    return 'issue is not a positive whole number';
  }
  return null;
}

/**
 * The valid entries of a fetched or cached registry, rebuilt field by field
 * (unknown keys dropped). Anything that is not an array is an empty registry.
 */
export function parseKnownFixes(raw: unknown): KnownFix[] {
  if (!Array.isArray(raw)) return [];
  const out: KnownFix[] = [];
  for (const entry of raw.slice(0, KNOWN_FIXES_MAX_ENTRIES)) {
    if (knownFixProblem(entry) !== null) continue;
    const e = entry as Record<string, unknown>;
    out.push({
      code: e.code as TelemetryErrorCode,
      fixedIn: e.fixedIn as string,
      summary: (e.summary as string).trim(),
      ...(typeof e.issue === 'number' ? { issue: e.issue } : {}),
    });
  }
  return out;
}

/**
 * The fix to offer for `code` on the `running` version, or `null`.
 *
 * Several entries may name one code (a second cause fixed later). Of those the
 * running version lacks, the **newest** wins: updating installs the latest
 * release, which carries every one of them, and the newest summary is the most
 * likely to describe what is still going wrong.
 */
export function fixFor(fixes: readonly KnownFix[], code: string, running: string): KnownFix | null {
  if (!SEMVER.test(running)) return null;
  let best: KnownFix | null = null;
  for (const fix of fixes) {
    if (fix.code !== code || !isVersionOlder(running, fix.fixedIn)) continue;
    if (!best || compareVersions(fix.fixedIn, best.fixedIn) > 0) best = fix;
  }
  return best;
}

/** The notification text. */
export function knownFixMessage(fix: KnownFix, running: string): string {
  const summary = /[.!?]$/.test(fix.summary) ? fix.summary : `${fix.summary}.`;
  return `ERD Studio ${fix.fixedIn} fixes this: ${summary} You're on ${running}.`;
}

/**
 * Whether a version at least `fixedIn` is already installed but not running
 * (an update waiting for a reload), from the installed versions the host found.
 */
export function updatePendingReload(installed: readonly string[], running: string, fixedIn: string): boolean {
  return installed.some(v => SEMVER.test(v) && compareVersions(v, running) > 0 && !isVersionOlder(v, fixedIn));
}

/** The registry as cached in globalState. */
export interface CachedKnownFixes {
  fetchedAt: number;
  fixes: KnownFix[];
}

/** Which codes have been offered, and on which running version. */
export interface ShownKnownFixes {
  version: string;
  codes: string[];
}

/** The answer the user gave the notification. */
export type KnownFixChoice = 'update' | 'reload' | 'dismissed';

export interface KnownFixesDeps {
  /** The running extension version. */
  version: string;
  /** Whether the check may run at all (`erdStudio.checkKnownFixes`). */
  enabled(): boolean;
  /** The registry URL, already through `safeBaseUrl`; `''` means never fetch. */
  url(): string;
  fetch(url: string, init: { signal: AbortSignal }): Promise<{ ok: boolean; json(): Promise<unknown> }>;
  now(): number;
  getCache(): CachedKnownFixes | undefined;
  setCache(value: CachedKnownFixes): void;
  getShown(): ShownKnownFixes | undefined;
  setShown(value: ShownKnownFixes): void;
  /** Versions of this extension installed on disk (may include the running one). */
  installedVersions(): readonly string[];
  /** Show the notification; resolves with what the user picked. */
  notify(message: string, pendingReload: boolean): Promise<KnownFixChoice>;
  openExtension(): Promise<void>;
  reloadWindow(): Promise<void>;
}

/**
 * Checks recorded error codes against the registry. Never throws and never
 * blocks the caller: {@link KnownFixesChecker.check} returns at once and does
 * its work in the background; every failure is dropped silently.
 */
export class KnownFixesChecker {
  /** One registry load per session, shared by every code checked. */
  private loading: Promise<KnownFix[]> | null = null;
  /** Codes already looked at in this session. */
  private readonly checked = new Set<string>();

  constructor(private readonly deps: KnownFixesDeps) {}

  check(code: TelemetryErrorCode): void {
    void this.run(code).catch(() => {});
  }

  /** The same as {@link check}, awaitable — for tests. */
  async run(code: TelemetryErrorCode): Promise<void> {
    if (this.checked.has(code) || !this.deps.enabled()) return;
    this.checked.add(code);
    if (this.alreadyShown(code)) return;

    const fix = fixFor(await this.registry(), code, this.deps.version);
    // Asked again after the await: two codes may have resolved together, or
    // another window may have shown this one meanwhile.
    if (!fix || this.alreadyShown(code)) return;
    this.markShown(code);

    const pending = updatePendingReload(safeList(() => this.deps.installedVersions()), this.deps.version, fix.fixedIn);
    const choice = await this.deps.notify(knownFixMessage(fix, this.deps.version), pending);
    if (choice === 'reload') await this.deps.reloadWindow();
    else if (choice === 'update') await this.deps.openExtension();
  }

  private alreadyShown(code: string): boolean {
    const shown = this.deps.getShown();
    return shown?.version === this.deps.version && shown.codes.includes(code);
  }

  /** Per running version: an update (or downgrade) starts the list again. */
  private markShown(code: string): void {
    const shown = this.deps.getShown();
    const codes = shown?.version === this.deps.version ? shown.codes : [];
    this.deps.setShown({ version: this.deps.version, codes: [...codes, code] });
  }

  private registry(): Promise<KnownFix[]> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<KnownFix[]> {
    const cached = this.deps.getCache();
    const now = this.deps.now();
    if (cached && now - cached.fetchedAt >= 0 && now - cached.fetchedAt < KNOWN_FIXES_CACHE_MS) {
      return parseKnownFixes(cached.fixes);
    }
    const fetched = await this.fetchRegistry();
    if (fetched) {
      this.deps.setCache({ fetchedAt: now, fixes: fetched });
      return fetched;
    }
    // Offline or refused: a stale copy is better than none, and nothing is
    // retried until the next session.
    return parseKnownFixes(cached?.fixes);
  }

  private async fetchRegistry(): Promise<KnownFix[] | null> {
    const url = this.deps.url();
    if (!url) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), KNOWN_FIXES_TIMEOUT_MS);
    try {
      const response = await this.deps.fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      return parseKnownFixes(await response.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeList(read: () => readonly string[]): readonly string[] {
  try {
    return read();
  } catch {
    return [];
  }
}
