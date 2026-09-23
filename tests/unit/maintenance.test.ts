// @vitest-environment node
/**
 * The stale-image cleanup gate.
 *
 * What is being defended here is not a feature, it is data. `cleanupStaleImages`
 * blanks `image_url` and `image_urls` on every ended/cancelled/hidden listing whose
 * `end_time` is more than 30 days in the past. The images are base64 inside Postgres,
 * so the row is the only copy and there is no backup. The Worker now runs this sweep
 * daily in production (see `scheduled()` in `workers/index.ts`); this file also covers
 * the local dev-server path (`startStaleImageCleanup`), which stays opt-in via `.env`.
 *
 * So the assertions below are mostly about what does NOT happen: an active listing,
 * or one that ended too recently, or one with no images left, is never touched, and
 * with the flag unset the local repeating sweep never queries the database at all.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  STALE_IMAGE_CLEANUP_BATCH_LIMIT,
  STALE_IMAGE_CLEANUP_ENV,
  STALE_IMAGE_CLEANUP_INTERVAL_MS,
  STALE_IMAGE_GRACE_MS,
  cleanupStaleImages,
  isStaleImageCleanupEnabled,
  startStaleImageCleanup,
} from '../../maintenance';
import { AUCTION_STATUS } from '../../workers/shared';
import { createFakeSupabase } from './helpers/fake-supabase';

const NOW = Date.UTC(2026, 0, 1);
const OLD_END = NOW - STALE_IMAGE_GRACE_MS - 1000;
const RECENT_END = NOW - 1000;

function auctionRow(overrides: Record<string, any> = {}) {
  return {
    id: 'auc_1',
    status: AUCTION_STATUS.ended,
    end_time: OLD_END,
    image_url: 'data:image/jpeg;base64,AAAA',
    image_urls: ['data:image/jpeg;base64,AAAA'],
    image_count: 1,
    ...overrides,
  };
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
/* 2. cleanupStaleImages: the new rule                                        */
/* ========================================================================== */

describe('cleanupStaleImages', () => {
  it('blanks images on an ended listing more than 30 days past end_time', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow()] });

    const cleaned = await cleanupStaleImages(db, NOW);

    expect(cleaned).toBe(1);
    expect(db.rows('auctions')[0]).toMatchObject({ image_url: null, image_urls: [] });
  });

  it('blanks a cancelled listing the same way', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow({ status: AUCTION_STATUS.cancelled })] });

    const cleaned = await cleanupStaleImages(db, NOW);

    expect(cleaned).toBe(1);
  });

  it('blanks a hidden listing the same way', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow({ status: AUCTION_STATUS.hidden })] });

    const cleaned = await cleanupStaleImages(db, NOW);

    expect(cleaned).toBe(1);
  });

  it('never touches an active listing, no matter how old', async () => {
    const db = createFakeSupabase({
      auctions: [auctionRow({ status: AUCTION_STATUS.active, end_time: NOW - 365 * 24 * 60 * 60 * 1000 })],
    });

    const cleaned = await cleanupStaleImages(db, NOW);

    expect(cleaned).toBe(0);
    expect(db.rows('auctions')[0].image_urls).toEqual(['data:image/jpeg;base64,AAAA']);
  });

  it('leaves a listing alone that ended less than 30 days ago', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow({ end_time: RECENT_END })] });

    const cleaned = await cleanupStaleImages(db, NOW);

    expect(cleaned).toBe(0);
    expect(db.rows('auctions')[0].image_urls).toEqual(['data:image/jpeg;base64,AAAA']);
  });

  it('skips an old, ended listing that has no images left', async () => {
    const db = createFakeSupabase({
      auctions: [auctionRow({ image_url: null, image_urls: [], image_count: 0 })],
    });

    const cleaned = await cleanupStaleImages(db, NOW);

    expect(cleaned).toBe(0);
    expect(db.updateFilters('auctions')).toEqual([]);
  });

  it('never selects an image column, only id', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow()] });

    await cleanupStaleImages(db, NOW);

    const selects = db.selectColumns('auctions');
    expect(selects).toContain('id');
    for (const columns of selects) {
      expect(columns).not.toContain('image_url');
      expect(columns).not.toContain('image_urls');
    }
  });

  it('updates by id list rather than re-filtering on status/end_time', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow({ id: 'auc_stale' })] });

    await cleanupStaleImages(db, NOW);

    expect(db.updateFilters('auctions')[0]).toContainEqual({ op: 'in', column: 'id', value: ['auc_stale'] });
  });

  it('returns 0 rather than throwing when the select fails', async () => {
    const db = createFakeSupabase(
      { auctions: [auctionRow()] },
      { errorOn: ({ table, op }) => (table === 'auctions' && op === 'select' ? new Error('boom') : null) },
    );

    await expect(cleanupStaleImages(db, NOW)).resolves.toBe(0);
  });

  it('returns 0 rather than throwing when the update fails', async () => {
    const db = createFakeSupabase(
      { auctions: [auctionRow()] },
      { errorOn: ({ table, op }) => (table === 'auctions' && op === 'update' ? new Error('boom') : null) },
    );

    await expect(cleanupStaleImages(db, NOW)).resolves.toBe(0);
    // The row was never blanked - a failed UPDATE must not be reported as a success.
    expect(db.rows('auctions')[0].image_urls).toEqual(['data:image/jpeg;base64,AAAA']);
  });

  it('cleans several eligible rows and ignores ineligible ones in the same batch', async () => {
    const db = createFakeSupabase({
      auctions: [
        auctionRow({ id: 'auc_a' }),
        auctionRow({ id: 'auc_b', status: AUCTION_STATUS.cancelled }),
        auctionRow({ id: 'auc_active', status: AUCTION_STATUS.active }),
        auctionRow({ id: 'auc_recent', end_time: RECENT_END }),
        auctionRow({ id: 'auc_bare', image_url: null, image_urls: [], image_count: 0 }),
      ],
    });

    const cleaned = await cleanupStaleImages(db, NOW);

    expect(cleaned).toBe(2);
    const byId = Object.fromEntries(db.rows('auctions').map((row: any) => [row.id, row]));
    expect(byId.auc_a.image_urls).toEqual([]);
    expect(byId.auc_b.image_urls).toEqual([]);
    expect(byId.auc_active.image_urls).toEqual(['data:image/jpeg;base64,AAAA']);
    expect(byId.auc_recent.image_urls).toEqual(['data:image/jpeg;base64,AAAA']);
    expect(byId.auc_bare.image_urls).toEqual([]);
  });

  it('caps one run at STALE_IMAGE_CLEANUP_BATCH_LIMIT (100, not 500) to keep the .in() id list short', async () => {
    // PostgREST puts the .in() id list in the request URL, not the body - a batch too large risks
    // an over-long URL. 500 was too many; this pins it at 100.
    expect(STALE_IMAGE_CLEANUP_BATCH_LIMIT).toBe(100);

    const rows = Array.from({ length: STALE_IMAGE_CLEANUP_BATCH_LIMIT + 1 }, (_, index) =>
      auctionRow({ id: `auc_${index}` }),
    );
    const db = createFakeSupabase({ auctions: rows });

    const cleaned = await cleanupStaleImages(db, NOW);

    expect(cleaned).toBe(STALE_IMAGE_CLEANUP_BATCH_LIMIT);
  });
});

/* ========================================================================== */
/* 3. Startup: the flag decides, and the default is off                       */
/* ========================================================================== */

describe('startStaleImageCleanup with the flag unset', () => {
  it('does not run the sweep and never touches the database', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow()] });
    const setTimer = vi.fn();
    const log = vi.fn();

    const handle = startStaleImageCleanup({ supabase: db, env: {}, log, setTimer });
    await Promise.resolve();

    expect(handle.enabled).toBe(false);
    expect(handle.timer).toBeNull();
    expect(db.operations).toEqual([]);
  });

  it('schedules no repeating timer', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow()] });
    const setTimer = vi.fn();

    startStaleImageCleanup({ supabase: db, env: {}, log: vi.fn(), setTimer });
    await Promise.resolve();

    expect(setTimer).not.toHaveBeenCalled();
  });

  it('logs exactly one line saying it is off and naming the variable', async () => {
    const db = createFakeSupabase({ auctions: [] });
    const log = vi.fn();

    startStaleImageCleanup({ supabase: db, env: {}, log, setTimer: vi.fn() });

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;

    expect(line).toContain('DISABLED');
    expect(line).toContain(STALE_IMAGE_CLEANUP_ENV);
    expect(line).toContain('30 days');
  });

  it('is off for a developer who set every other variable but not this one', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow()] });

    const handle = startStaleImageCleanup({
      supabase: db,
      env: { SUPABASE_URL: 'https://example.supabase.co', NODE_ENV: 'development' },
      log: vi.fn(),
      setTimer: vi.fn(),
    });
    await Promise.resolve();

    expect(handle.enabled).toBe(false);
    expect(db.operations).toEqual([]);
  });
});

describe('startStaleImageCleanup with the flag set', () => {
  it('runs the sweep immediately and schedules the 6-hourly repeat', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow()] });
    const setTimer = vi.fn((_handler: () => void, _intervalMs: number) => 'timer-handle');
    const log = vi.fn();

    const handle = startStaleImageCleanup({
      supabase: db,
      env: { [STALE_IMAGE_CLEANUP_ENV]: 'true' },
      log,
      setTimer,
    });

    expect(handle.enabled).toBe(true);
    expect(handle.timer).toBe('timer-handle');
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer.mock.calls[0][1]).toBe(STALE_IMAGE_CLEANUP_INTERVAL_MS);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.rows('auctions')[0]).toMatchObject({ image_url: null, image_urls: [] });
  });

  it('warns that the deletion cannot be undone', () => {
    const log = vi.fn();

    startStaleImageCleanup({
      supabase: createFakeSupabase({ auctions: [] }),
      env: { [STALE_IMAGE_CLEANUP_ENV]: 'true' },
      log,
      setTimer: vi.fn(),
    });

    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('ENABLED');
    expect(line).toContain('cannot be undone');
  });

  it('sweeps again when the scheduled timer fires', async () => {
    const db = createFakeSupabase({ auctions: [auctionRow()] });
    let tick: (() => void) | null = null;

    startStaleImageCleanup({
      supabase: db,
      env: { [STALE_IMAGE_CLEANUP_ENV]: 'true' },
      log: vi.fn(),
      setTimer: (handler) => {
        tick = handler;
        return 'timer-handle';
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.rows('auctions')[0].image_urls).toEqual([]);

    tick!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Idempotent: the row has no images left on the second pass, so nothing
    // further happens to it, but the sweep itself ran again without throwing.
    expect(db.rows('auctions')[0].image_urls).toEqual([]);
  });
});
