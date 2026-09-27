// @vitest-environment node
/**
 * The stale-image cleanup sweep and the cron that runs it.
 *
 * What is being defended here is not a feature, it is data. `cleanupStaleImages` blanks
 * `image_url` and `image_urls` on every FINISHED listing - sold, cancelled, hidden, or expired -
 * whose `expires_at` is more than 30 days in the past. The images are base64 inside Postgres, so
 * the row is the only copy and there is no backup. The Worker runs this daily
 * (`scheduled()` in `workers/index.ts`, gated on ENABLE_STALE_IMAGE_CLEANUP).
 *
 * So the assertions below are mostly about what does NOT happen: a live listing, one that
 * finished too recently, or one with no images left is never touched, and any cron other than
 * the daily one - notably the retired every-minute settlement trigger - runs nothing at all.
 *
 * (Ported from the deleted `tests/unit/maintenance.test.ts`, which tested the same function
 * through the dev server's re-export.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';

const mocks = vi.hoisted(() => ({ client: null as any }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mocks.client,
}));

import worker from '../../workers/index';
import {
  AUCTION_STATUS,
  STALE_IMAGE_CLEANUP_BATCH_LIMIT,
  STALE_IMAGE_CLEANUP_ENV,
  STALE_IMAGE_GRACE_MS,
  cleanupStaleImages,
  isStaleImageCleanupEnabled,
} from '../../workers/shared';

const NOW = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;
/** Expired more than 30 days ago: in scope. */
const OLD_EXPIRY = NOW - STALE_IMAGE_GRACE_MS - 1000;
/** Expired, but within the 30-day grace: out of scope. */
const RECENT_EXPIRY = NOW - 1000;

const IMAGE = 'data:image/jpeg;base64,AAAA';

function listingRow(overrides: Record<string, any> = {}) {
  return {
    id: 'auc_1',
    status: AUCTION_STATUS.sold,
    created_at: OLD_EXPIRY - 30 * DAY,
    expires_at: OLD_EXPIRY,
    sold_at: OLD_EXPIRY - 5 * DAY,
    image_url: IMAGE,
    image_urls: [IMAGE],
    image_count: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.client = null;
});

/* ========================================================================== */
/* 1. The gate                                                                */
/* ========================================================================== */

describe('isStaleImageCleanupEnabled', () => {
  it('is off when the variable is unset or empty', () => {
    expect(isStaleImageCleanupEnabled({})).toBe(false);
    expect(isStaleImageCleanupEnabled(undefined)).toBe(false);
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
/* 2. What counts as finished                                                 */
/* ========================================================================== */

describe('cleanupStaleImages', () => {
  it('blanks images on a SOLD listing more than 30 days past its expiry', async () => {
    const db = createFakeSupabase({ auctions: [listingRow()] });

    const cleaned = await cleanupStaleImages(db, NOW);

    expect(cleaned).toBe(1);
    expect(db.rows('auctions')[0]).toMatchObject({ image_url: null, image_urls: [] });
  });

  it('blanks a cancelled listing the same way', async () => {
    const db = createFakeSupabase({ auctions: [listingRow({ status: AUCTION_STATUS.cancelled, sold_at: null })] });

    expect(await cleanupStaleImages(db, NOW)).toBe(1);
  });

  it('blanks an admin-hidden listing the same way (hidden was in scope before v1 too)', async () => {
    const db = createFakeSupabase({ auctions: [listingRow({ status: AUCTION_STATUS.hidden, sold_at: null })] });

    expect(await cleanupStaleImages(db, NOW)).toBe(1);
  });

  it('blanks an EXPIRED listing - stored active, expiry long past - which a status filter would miss', async () => {
    const db = createFakeSupabase({ auctions: [listingRow({ status: AUCTION_STATUS.active, sold_at: null })] });

    expect(await cleanupStaleImages(db, NOW)).toBe(1);
    expect(db.rows('auctions')[0].image_urls).toEqual([]);
  });

  it('blanks a legacy pre-v1 "ended" row once its expiry (its old end_time) is 30 days gone', async () => {
    const db = createFakeSupabase({ auctions: [listingRow({ status: 'ended', sold_at: null })] });

    expect(await cleanupStaleImages(db, NOW)).toBe(1);
  });

  it('never touches a LIVE listing, however old the listing itself is', async () => {
    const db = createFakeSupabase({
      auctions: [
        listingRow({
          status: AUCTION_STATUS.active,
          created_at: NOW - 365 * DAY,
          expires_at: NOW + DAY,
          sold_at: null,
        }),
      ],
    });

    const cleaned = await cleanupStaleImages(db, NOW);

    expect(cleaned).toBe(0);
    expect(db.rows('auctions')[0].image_urls).toEqual([IMAGE]);
    expect(db.updateFilters('auctions')).toEqual([]);
  });

  it('leaves a listing alone that finished less than 30 days ago', async () => {
    for (const status of [AUCTION_STATUS.sold, AUCTION_STATUS.cancelled, AUCTION_STATUS.hidden, AUCTION_STATUS.active]) {
      const db = createFakeSupabase({ auctions: [listingRow({ status, expires_at: RECENT_EXPIRY })] });

      expect(await cleanupStaleImages(db, NOW), status).toBe(0);
      expect(db.rows('auctions')[0].image_urls).toEqual([IMAGE]);
    }
  });

  it('measures a sold listing from its expiry, not its sale date - never earlier than the old policy', async () => {
    // Sold 40 days ago but only expired 10 days ago: the photos stay for another 20 days.
    const db = createFakeSupabase({
      auctions: [listingRow({ sold_at: NOW - 40 * DAY, expires_at: NOW - 10 * DAY })],
    });

    expect(await cleanupStaleImages(db, NOW)).toBe(0);
  });

  it('skips a listing that has no images left', async () => {
    const db = createFakeSupabase({ auctions: [listingRow({ image_url: null, image_urls: [], image_count: 0 })] });

    expect(await cleanupStaleImages(db, NOW)).toBe(0);
    expect(db.updateFilters('auctions')).toEqual([]);
  });

  it('skips a row with no expires_at at all rather than guessing', async () => {
    const db = createFakeSupabase({ auctions: [listingRow({ expires_at: null })] });

    expect(await cleanupStaleImages(db, NOW)).toBe(0);
  });

  it('never selects an image column, only id', async () => {
    const db = createFakeSupabase({ auctions: [listingRow()] });

    await cleanupStaleImages(db, NOW);

    const selects = db.selectColumns('auctions');
    expect(selects).toContain('id');
    for (const columns of selects) {
      expect(columns).not.toContain('image_url');
    }
  });

  it('updates by id list AND re-asserts the expiry cutoff, so a row whose expiry moved is left alone', async () => {
    const db = createFakeSupabase({ auctions: [listingRow({ id: 'auc_stale' })] });

    await cleanupStaleImages(db, NOW);

    const filters = db.updateFilters('auctions')[0];
    expect(filters).toContainEqual({ op: 'in', column: 'id', value: ['auc_stale'] });
    expect(filters).toContainEqual({ op: 'lt', column: 'expires_at', value: NOW - STALE_IMAGE_GRACE_MS });
  });

  it('returns 0 rather than throwing when the select fails', async () => {
    const db = createFakeSupabase(
      { auctions: [listingRow()] },
      { errorOn: ({ table, op }) => (table === 'auctions' && op === 'select' ? new Error('boom') : null) },
    );

    await expect(cleanupStaleImages(db, NOW)).resolves.toBe(0);
  });

  it('returns 0 rather than throwing when the update fails, and reports nothing cleaned', async () => {
    const db = createFakeSupabase(
      { auctions: [listingRow()] },
      { errorOn: ({ table, op }) => (table === 'auctions' && op === 'update' ? new Error('boom') : null) },
    );

    await expect(cleanupStaleImages(db, NOW)).resolves.toBe(0);
    expect(db.rows('auctions')[0].image_urls).toEqual([IMAGE]);
  });

  it('cleans several eligible rows and ignores ineligible ones in the same batch', async () => {
    const db = createFakeSupabase({
      auctions: [
        listingRow({ id: 'auc_sold' }),
        listingRow({ id: 'auc_cancelled', status: AUCTION_STATUS.cancelled }),
        listingRow({ id: 'auc_expired', status: AUCTION_STATUS.active, sold_at: null }),
        listingRow({ id: 'auc_live', status: AUCTION_STATUS.active, expires_at: NOW + DAY, sold_at: null }),
        listingRow({ id: 'auc_recent', expires_at: RECENT_EXPIRY }),
        listingRow({ id: 'auc_bare', image_url: null, image_urls: [], image_count: 0 }),
      ],
    });

    const cleaned = await cleanupStaleImages(db, NOW);

    expect(cleaned).toBe(3);
    const byId = Object.fromEntries(db.rows('auctions').map((row: any) => [row.id, row]));
    expect(byId.auc_sold.image_urls).toEqual([]);
    expect(byId.auc_cancelled.image_urls).toEqual([]);
    expect(byId.auc_expired.image_urls).toEqual([]);
    expect(byId.auc_live.image_urls).toEqual([IMAGE]);
    expect(byId.auc_recent.image_urls).toEqual([IMAGE]);
  });

  it('caps one run at STALE_IMAGE_CLEANUP_BATCH_LIMIT (100) to keep the .in() id list short', async () => {
    expect(STALE_IMAGE_CLEANUP_BATCH_LIMIT).toBe(100);

    const rows = Array.from({ length: STALE_IMAGE_CLEANUP_BATCH_LIMIT + 1 }, (_, index) =>
      listingRow({ id: `auc_${index}` }),
    );
    const db = createFakeSupabase({ auctions: rows });

    expect(await cleanupStaleImages(db, NOW)).toBe(STALE_IMAGE_CLEANUP_BATCH_LIMIT);
  });
});

/* ========================================================================== */
/* 3. scheduled(): only the daily cron does anything                          */
/* ========================================================================== */

describe('scheduled()', () => {
  const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'test-secret' };
  const ENABLED = { ...ENV, ENABLE_STALE_IMAGE_CLEANUP: 'true' };

  function seedStale() {
    // Real clock here: scheduled() uses Date.now(), so "stale" is relative to now.
    const now = Date.now();
    const db = createFakeSupabase({
      auctions: [
        listingRow({ id: 'auc_stale', expires_at: now - STALE_IMAGE_GRACE_MS - DAY }),
        listingRow({ id: 'auc_live', status: AUCTION_STATUS.active, expires_at: now + DAY, sold_at: null }),
      ],
    });
    mocks.client = db;
    return db;
  }

  it('the daily 03:00 cron blanks stale images and leaves live listings alone', async () => {
    const db = seedStale();

    await worker.scheduled({ cron: '0 3 * * *' }, ENABLED, { waitUntil: () => {} });

    const byId = Object.fromEntries(db.rows('auctions').map((row: any) => [row.id, row]));
    expect(byId.auc_stale).toMatchObject({ image_url: null, image_urls: [] });
    expect(byId.auc_live.image_urls).toEqual([IMAGE]);
  });

  it('the retired every-minute settlement cron does NOTHING, even with cleanup enabled', async () => {
    const db = seedStale();

    await worker.scheduled({ cron: '* * * * *' }, ENABLED, { waitUntil: () => {} });

    expect(db.operations).toEqual([]);
    expect(db.rows('auctions').every((row: any) => row.image_urls.length === 1)).toBe(true);
  });

  it('a manual test fire with no cron field does nothing', async () => {
    const db = seedStale();

    await worker.scheduled({}, ENABLED, { waitUntil: () => {} });

    expect(db.operations).toEqual([]);
  });

  it('the daily cron does nothing when ENABLE_STALE_IMAGE_CLEANUP is not "true"', async () => {
    const db = seedStale();

    await worker.scheduled({ cron: '0 3 * * *' }, ENV, { waitUntil: () => {} });

    expect(db.operations).toEqual([]);
  });

  it('never settles anything: no status or sold_at is written by any cron', async () => {
    const db = seedStale();

    await worker.scheduled({ cron: '0 3 * * *' }, ENABLED, { waitUntil: () => {} });

    for (const payload of db.operations.filter((op) => op.op === 'update').map((op) => op.payload)) {
      expect(Object.keys(payload).sort()).toEqual(['image_url', 'image_urls']);
    }
  });
});
