// @vitest-environment node
/**
 * The stale-image cleanup gate.
 *
 * What is being defended here is not a feature, it is data. `cleanupStaleImages`
 * blanks `image_url` and `image_urls` on every listing older than 90 days. The
 * images are base64 inside Postgres, so the row is the only copy and there is no
 * backup; and `.env`, `.dev.vars` and `wrangler.toml` all name the same Supabase
 * project, so there is no separate development database to practise on. It used
 * to run on every `npm run dev`, unprompted.
 *
 * So the assertions below are mostly about what does NOT happen: with the flag
 * unset, the database is not queried at all.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  STALE_IMAGE_CLEANUP_ENV,
  STALE_IMAGE_CLEANUP_INTERVAL_MS,
  STALE_IMAGE_MAX_AGE_MS,
  cleanupStaleImages,
  isStaleImageCleanupEnabled,
  startStaleImageCleanup,
} from '../../maintenance';

const NOW = Date.UTC(2026, 0, 1);
const OLD = NOW - STALE_IMAGE_MAX_AGE_MS - 1000;
const RECENT = NOW - 1000;

/**
 * Just enough Supabase to record what the sweep did, and to fail loudly if it
 * is touched when it should not be.
 */
function fakeSupabase(rows: any[]) {
  const updates: { id: string; patch: any }[] = [];
  let selects = 0;

  const client = {
    updates,
    get selects() {
      return selects;
    },
    from(table: string) {
      expect(table).toBe('auctions');

      return {
        select() {
          selects += 1;
          return {
            lt(_column: string, value: number) {
              return Promise.resolve({
                data: rows.filter((row) => row.created_at < value),
                error: null,
              });
            },
          };
        },
        update(patch: any) {
          return {
            eq(_column: string, id: string) {
              updates.push({ id, patch });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };

  return client;
}

function withImages(id: string, created_at: number) {
  return { id, created_at, image_url: 'data:image/png;base64,AAAA', image_urls: ['data:image/png;base64,AAAA'] };
}

/* ========================================================================== */
/* 1. The gate itself                                                         */
/* ========================================================================== */

describe('isStaleImageCleanupEnabled', () => {
  it('is off when the variable is unset or empty', () => {
    expect(isStaleImageCleanupEnabled({})).toBe(false);
    expect(isStaleImageCleanupEnabled({ [STALE_IMAGE_CLEANUP_ENV]: '' })).toBe(false);
    expect(isStaleImageCleanupEnabled({ [STALE_IMAGE_CLEANUP_ENV]: undefined })).toBe(false);
  });

  it('is off for anything that is not the word true', () => {
    // Anyone who typed one of these was saying "off". A truthy check would read
    // "false" as on, which for an irreversible delete is the wrong way to fail.
    for (const value of ['false', '0', 'no', 'off', 'TRUEISH', 'yes', '1', ' ']) {
      expect(isStaleImageCleanupEnabled({ [STALE_IMAGE_CLEANUP_ENV]: value })).toBe(false);
    }
  });

  it('is on only for "true", in any casing and with surrounding space', () => {
    for (const value of ['true', 'TRUE', 'True', '  true  ']) {
      expect(isStaleImageCleanupEnabled({ [STALE_IMAGE_CLEANUP_ENV]: value })).toBe(true);
    }
  });
});

/* ========================================================================== */
/* 2. Startup: the flag decides, and the default is off                       */
/* ========================================================================== */

describe('startStaleImageCleanup with the flag unset', () => {
  it('does not run the sweep and never touches the database', async () => {
    const supabase = fakeSupabase([withImages('auc_old', OLD)]);
    const setTimer = vi.fn();
    const log = vi.fn();

    const handle = startStaleImageCleanup({ supabase, env: {}, log, setTimer });
    // Let any stray floating promise settle before asserting nothing happened.
    await Promise.resolve();

    expect(handle.enabled).toBe(false);
    expect(handle.timer).toBeNull();
    expect(supabase.selects).toBe(0);
    expect(supabase.updates).toEqual([]);
  });

  it('schedules no repeating timer', async () => {
    const supabase = fakeSupabase([withImages('auc_old', OLD)]);
    const setTimer = vi.fn();

    startStaleImageCleanup({ supabase, env: {}, log: vi.fn(), setTimer });
    await Promise.resolve();

    // The 6-hourly repeat was the other half of the problem: a dev server left
    // running overnight swept again while nobody was watching.
    expect(setTimer).not.toHaveBeenCalled();
  });

  it('logs exactly one line saying it is off and naming the variable', async () => {
    const supabase = fakeSupabase([]);
    const log = vi.fn();

    startStaleImageCleanup({ supabase, env: {}, log, setTimer: vi.fn() });

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;

    // Silence would leave the next maintainer assuming the sweep still runs.
    expect(line).toContain('DISABLED');
    expect(line).toContain(STALE_IMAGE_CLEANUP_ENV);
    expect(line).toContain('90 days');
  });

  it('is off for a developer who set every other variable but not this one', async () => {
    const supabase = fakeSupabase([withImages('auc_old', OLD)]);

    const handle = startStaleImageCleanup({
      supabase,
      env: { SUPABASE_URL: 'https://example.supabase.co', NODE_ENV: 'development' },
      log: vi.fn(),
      setTimer: vi.fn(),
    });
    await Promise.resolve();

    expect(handle.enabled).toBe(false);
    expect(supabase.updates).toEqual([]);
  });
});

describe('startStaleImageCleanup with the flag set', () => {
  it('runs the sweep immediately and schedules the 6-hourly repeat', async () => {
    const supabase = fakeSupabase([withImages('auc_old', OLD)]);
    // Typed parameters so `mock.calls[0][1]` below is the interval, not `never`.
    const setTimer = vi.fn((_handler: () => void, _intervalMs: number) => 'timer-handle');
    const log = vi.fn();

    const handle = startStaleImageCleanup({
      supabase,
      env: { [STALE_IMAGE_CLEANUP_ENV]: 'true' },
      log,
      setTimer,
    });

    expect(handle.enabled).toBe(true);
    expect(handle.timer).toBe('timer-handle');
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer.mock.calls[0][1]).toBe(STALE_IMAGE_CLEANUP_INTERVAL_MS);

    // The startup sweep is fired without being awaited, so drain the microtask
    // queue before asserting on its effect.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(supabase.updates).toEqual([{ id: 'auc_old', patch: { image_url: null, image_urls: '[]' } }]);
  });

  it('warns that the deletion cannot be undone', () => {
    const log = vi.fn();

    startStaleImageCleanup({
      supabase: fakeSupabase([]),
      env: { [STALE_IMAGE_CLEANUP_ENV]: 'true' },
      log,
      setTimer: vi.fn(),
    });

    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('ENABLED');
    expect(line).toContain('cannot be undone');
  });

  it('sweeps again when the scheduled timer fires', async () => {
    const supabase = fakeSupabase([withImages('auc_old', OLD)]);
    let tick: (() => void) | null = null;

    startStaleImageCleanup({
      supabase,
      env: { [STALE_IMAGE_CLEANUP_ENV]: 'true' },
      log: vi.fn(),
      setTimer: (handler) => {
        tick = handler;
        return 'timer-handle';
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(supabase.updates).toHaveLength(1);

    tick!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(supabase.updates).toHaveLength(2);
  });
});

/* ========================================================================== */
/* 3. The sweep itself, unchanged                                             */
/* ========================================================================== */

describe('cleanupStaleImages', () => {
  it('blanks both image columns on listings past 90 days', async () => {
    const supabase = fakeSupabase([withImages('auc_old', OLD)]);

    const cleaned = await cleanupStaleImages(supabase, NOW);

    expect(cleaned).toBe(1);
    expect(supabase.updates).toEqual([{ id: 'auc_old', patch: { image_url: null, image_urls: '[]' } }]);
  });

  it('leaves listings inside the window alone', async () => {
    const supabase = fakeSupabase([withImages('auc_recent', RECENT)]);

    const cleaned = await cleanupStaleImages(supabase, NOW);

    expect(cleaned).toBe(0);
    expect(supabase.updates).toEqual([]);
  });

  it('skips an old listing that has no images left', async () => {
    const supabase = fakeSupabase([{ id: 'auc_bare', created_at: OLD, image_url: null, image_urls: [] }]);

    const cleaned = await cleanupStaleImages(supabase, NOW);

    expect(cleaned).toBe(0);
    expect(supabase.updates).toEqual([]);
  });

  it('returns 0 rather than throwing when the query fails', async () => {
    const broken = {
      from: () => ({
        select: () => ({ lt: () => Promise.resolve({ data: null, error: new Error('boom') }) }),
      }),
    };

    await expect(cleanupStaleImages(broken, NOW)).resolves.toBe(0);
  });
});
