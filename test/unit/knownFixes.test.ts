/**
 * knownFixes — matching, version comparison, once per code per version, the
 * 24-hour cache and silent failure. Every dependency is injected, so these
 * run without an extension host or a network.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  KNOWN_FIXES_CACHE_MS,
  KnownFixesChecker,
  fixFor,
  knownFixMessage,
  parseKnownFixes,
  updatePendingReload,
  type CachedKnownFixes,
  type KnownFix,
  type KnownFixChoice,
  type KnownFixesDeps,
  type ShownKnownFixes,
} from '../../src/services/knownFixes';

const FIX: KnownFix = { code: 'domainLoadJson', fixedIn: '1.7.0', summary: 'Diagrams with a merge conflict now explain the conflict.' };

describe('fixFor', () => {
  it('offers a fix only to versions older than fixedIn', () => {
    expect(fixFor([FIX], 'domainLoadJson', '1.6.9')).toBe(FIX);
    expect(fixFor([FIX], 'domainLoadJson', '1.7.0')).toBeNull();
    expect(fixFor([FIX], 'domainLoadJson', '1.8.0')).toBeNull();
  });

  it('compares versions numerically, not as text', () => {
    const fix = { ...FIX, fixedIn: '1.10.0' };
    expect(fixFor([fix], 'domainLoadJson', '1.9.0')).toBe(fix);
    expect(fixFor([fix], 'domainLoadJson', '1.10.1')).toBeNull();
  });

  it('matches only the same code', () => {
    expect(fixFor([FIX], 'domainLoad', '1.0.0')).toBeNull();
  });

  it('picks the newest fix the running version lacks', () => {
    const later = { ...FIX, fixedIn: '1.9.0', summary: 'Later.' };
    expect(fixFor([FIX, later], 'domainLoadJson', '1.6.0')).toBe(later);
    expect(fixFor([later, FIX], 'domainLoadJson', '1.6.0')).toBe(later);
    expect(fixFor([FIX, later], 'domainLoadJson', '1.7.5')).toBe(later);
  });

  it('offers nothing when the running version is not a release number', () => {
    expect(fixFor([FIX], 'domainLoadJson', '')).toBeNull();
    expect(fixFor([FIX], 'domainLoadJson', '0.0.0-test')).toBeNull();
  });
});

describe('parseKnownFixes', () => {
  it('keeps valid entries, drops invalid ones and unknown keys', () => {
    const parsed = parseKnownFixes([
      { ...FIX, extra: 'x', issue: 9 },
      { code: 'nope', fixedIn: '1.0.0', summary: 'x' },
      'garbage',
    ]);
    expect(parsed).toEqual([{ ...FIX, issue: 9 }]);
  });

  it('reads anything that is not an array as empty', () => {
    expect(parseKnownFixes({ fixes: [FIX] })).toEqual([]);
    expect(parseKnownFixes(undefined)).toEqual([]);
  });
});

describe('knownFixMessage', () => {
  it('names the fixed version, the summary and the running version', () => {
    expect(knownFixMessage(FIX, '1.6.9')).toBe(
      "ERD Studio 1.7.0 fixes this: Diagrams with a merge conflict now explain the conflict. You're on 1.6.9.",
    );
  });

  it('ends a summary without punctuation with a full stop', () => {
    expect(knownFixMessage({ ...FIX, summary: 'Diagrams open' }, '1.6.9')).toContain('fixes this: Diagrams open. You');
  });
});

describe('updatePendingReload', () => {
  it('is true only for an installed newer version that has the fix', () => {
    expect(updatePendingReload(['1.6.9', '1.7.0'], '1.6.9', '1.7.0')).toBe(true);
    expect(updatePendingReload(['1.6.9', '1.6.10'], '1.6.9', '1.7.0')).toBe(false);
    expect(updatePendingReload(['1.6.9'], '1.6.9', '1.7.0')).toBe(false);
    expect(updatePendingReload([], '1.6.9', '1.7.0')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

interface Harness {
  deps: KnownFixesDeps;
  fetch: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  openExtension: ReturnType<typeof vi.fn>;
  reloadWindow: ReturnType<typeof vi.fn>;
  store: { cache?: CachedKnownFixes; shown?: ShownKnownFixes };
  clock: { now: number };
}

function harness(options: {
  version?: string;
  registry?: unknown;
  fetchImpl?: () => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  choice?: KnownFixChoice;
  enabled?: boolean;
  installed?: string[];
  store?: Harness['store'];
} = {}): Harness {
  const store = options.store ?? {};
  const clock = { now: 1_000_000 };
  const fetch = vi.fn(options.fetchImpl ?? (async () => ({ ok: true, json: async () => options.registry ?? [FIX] })));
  const notify = vi.fn(async () => options.choice ?? 'dismissed');
  const openExtension = vi.fn(async () => {});
  const reloadWindow = vi.fn(async () => {});
  const deps: KnownFixesDeps = {
    version: options.version ?? '1.6.9',
    enabled: () => options.enabled ?? true,
    url: () => 'https://telemetry.example/known-fixes',
    fetch,
    now: () => clock.now,
    getCache: () => store.cache,
    setCache: v => {
      store.cache = v;
    },
    getShown: () => store.shown,
    setShown: v => {
      store.shown = v;
    },
    installedVersions: () => options.installed ?? [],
    notify,
    openExtension,
    reloadWindow,
  };
  return { deps, fetch, notify, openExtension, reloadWindow, store, clock };
}

describe('KnownFixesChecker', () => {
  it('fetches the whole registry with no query and shows the matching fix', async () => {
    const h = harness();
    await new KnownFixesChecker(h.deps).run('domainLoadJson');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][0]).toBe('https://telemetry.example/known-fixes');
    expect(h.notify).toHaveBeenCalledWith(knownFixMessage(FIX, '1.6.9'), false);
  });

  it('opens the extension on Update and reloads on Reload Window', async () => {
    const update = harness({ choice: 'update' });
    await new KnownFixesChecker(update.deps).run('domainLoadJson');
    expect(update.openExtension).toHaveBeenCalledTimes(1);
    expect(update.reloadWindow).not.toHaveBeenCalled();

    const reload = harness({ choice: 'reload', installed: ['1.6.9', '1.7.0'] });
    await new KnownFixesChecker(reload.deps).run('domainLoadJson');
    expect(reload.notify).toHaveBeenCalledWith(expect.any(String), true);
    expect(reload.reloadWindow).toHaveBeenCalledTimes(1);
    expect(reload.openExtension).not.toHaveBeenCalled();
  });

  it('does nothing on Not now', async () => {
    const h = harness({ choice: 'dismissed' });
    await new KnownFixesChecker(h.deps).run('domainLoadJson');
    expect(h.openExtension).not.toHaveBeenCalled();
    expect(h.reloadWindow).not.toHaveBeenCalled();
  });

  it('shows nothing when the running version already has the fix', async () => {
    const h = harness({ version: '1.7.0' });
    await new KnownFixesChecker(h.deps).run('domainLoadJson');
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.store.shown).toBeUndefined();
  });

  it('shows a code at most once per running version, across sessions', async () => {
    const store: Harness['store'] = {};
    const first = harness({ store });
    await new KnownFixesChecker(first.deps).run('domainLoadJson');
    expect(first.notify).toHaveBeenCalledTimes(1);

    const sameVersion = harness({ store });
    await new KnownFixesChecker(sameVersion.deps).run('domainLoadJson');
    expect(sameVersion.notify).not.toHaveBeenCalled();

    // A different running version (say 1.6.10, still before the fix) asks again.
    const nextVersion = harness({ store, version: '1.6.10' });
    await new KnownFixesChecker(nextVersion.deps).run('domainLoadJson');
    expect(nextVersion.notify).toHaveBeenCalledTimes(1);
    expect(store.shown).toEqual({ version: '1.6.10', codes: ['domainLoadJson'] });
  });

  it('shows each code once even when it is recorded repeatedly at the same time', async () => {
    const h = harness();
    const checker = new KnownFixesChecker(h.deps);
    await Promise.all([checker.run('domainLoadJson'), checker.run('domainLoadJson'), checker.run('domainLoadJson')]);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('fetches once per session, however many codes are recorded', async () => {
    const other: KnownFix = { code: 'saveFailed', fixedIn: '1.7.0', summary: 'Saves work.' };
    const h = harness({ registry: [FIX, other] });
    const checker = new KnownFixesChecker(h.deps);
    await Promise.all([checker.run('domainLoadJson'), checker.run('saveFailed'), checker.run('layersInvalid')]);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it('uses a cache younger than 24 hours and refetches an older one', async () => {
    const fresh = harness({ store: { cache: { fetchedAt: 1_000_000 - 1000, fixes: [FIX] } } });
    await new KnownFixesChecker(fresh.deps).run('domainLoadJson');
    expect(fresh.fetch).not.toHaveBeenCalled();
    expect(fresh.notify).toHaveBeenCalledTimes(1);

    const stale = harness({ store: { cache: { fetchedAt: 1_000_000 - KNOWN_FIXES_CACHE_MS, fixes: [] } } });
    await new KnownFixesChecker(stale.deps).run('domainLoadJson');
    expect(stale.fetch).toHaveBeenCalledTimes(1);
    expect(stale.store.cache).toEqual({ fetchedAt: 1_000_000, fixes: [FIX] });
    expect(stale.notify).toHaveBeenCalledTimes(1);
  });

  it('refetches a cache dated in the future (a clock that moved back)', async () => {
    const h = harness({ store: { cache: { fetchedAt: 1_000_000 + 5000, fixes: [] } } });
    await new KnownFixesChecker(h.deps).run('domainLoadJson');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a network error', async () => Promise.reject(new Error('offline'))],
    ['a 503', async () => ({ ok: false, json: async () => [FIX] })],
    ['a body that is not JSON', async () => ({ ok: true, json: async () => Promise.reject(new SyntaxError('bad')) })],
  ])('swallows %s silently, falling back to a stale cache', async (_label, fetchImpl) => {
    const none = harness({ fetchImpl });
    await expect(new KnownFixesChecker(none.deps).run('domainLoadJson')).resolves.toBeUndefined();
    expect(none.notify).not.toHaveBeenCalled();
    expect(none.store.cache).toBeUndefined();

    const stale = harness({ fetchImpl, store: { cache: { fetchedAt: 0, fixes: [FIX] } } });
    await new KnownFixesChecker(stale.deps).run('domainLoadJson');
    expect(stale.notify).toHaveBeenCalledTimes(1);
    expect(stale.store.cache?.fetchedAt).toBe(0);
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        fetchImpl: () => new Promise((_resolve, reject) => {
          const signal = (h.fetch.mock.calls[0][1] as { signal: AbortSignal }).signal;
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      });
      const done = new KnownFixesChecker(h.deps).run('domainLoadJson');
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(done).resolves.toBeUndefined();
      expect(h.notify).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a failed fetch within the session', async () => {
    const h = harness({ fetchImpl: async () => Promise.reject(new Error('offline')) });
    const checker = new KnownFixesChecker(h.deps);
    await checker.run('domainLoadJson');
    await checker.run('saveFailed');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('does nothing — not even a fetch — when the setting is off', async () => {
    const h = harness({ enabled: false });
    await new KnownFixesChecker(h.deps).run('domainLoadJson');
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('never fetches with an empty URL', async () => {
    const h = harness();
    h.deps.url = () => '';
    await new KnownFixesChecker(h.deps).run('domainLoadJson');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('check() never throws, even when the notification does', async () => {
    const h = harness();
    h.deps.notify = () => Promise.reject(new Error('ui gone'));
    expect(() => new KnownFixesChecker(h.deps).check('domainLoadJson')).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('treats a failing installed-versions scan as none', async () => {
    const h = harness();
    h.deps.installedVersions = () => {
      throw new Error('EACCES');
    };
    await new KnownFixesChecker(h.deps).run('domainLoadJson');
    expect(h.notify).toHaveBeenCalledWith(expect.any(String), false);
  });
});
