// @vitest-environment node
/**
 * The fixed-price listing lifecycle, end to end through `worker.fetch`:
 * browse (live only), detail (any non-hidden status, `expired` derived), create (price + TTL),
 * edit, mark sold, cancel, the caller's own listings, the removed bidding routes, and the
 * generic 500 body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeSupabase, FakeSupabase, FakeSupabaseOptions } from './helpers/fake-supabase';

// The Worker builds its Supabase client at request time, so the client the
// tests inspect has to come back from createClient().
const mocks = vi.hoisted(() => ({ client: null as any }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mocks.client,
}));

import worker from '../../workers/index';
import {
  DAY_MS,
  LISTING_CATEGORIES,
  decodeAuctionCursor,
  deriveListingStatus,
  encodeAuctionCursor,
  mapListingRow,
  parseListingPrice,
} from '../../workers/shared';

const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'test-secret' };

const SELLER = { id: 'usr_seller', name: 'Seller', username: 'seller', token: 'tok_seller' };
const OTHER = { id: 'usr_other', name: 'Other', username: 'other', token: 'tok_other' };

const NOW = Date.now();
const FUTURE = NOW + 10 * DAY_MS;
const PAST = NOW - 1000;

function listingRow(overrides: Record<string, any> = {}) {
  return {
    id: 'auc_1',
    title: 'Vintage lamp',
    description: 'A lamp',
    phone_number: '0100000000',
    price: 100,
    seller_id: SELLER.id,
    seller_name: SELLER.name,
    status: 'active',
    category: 'General',
    image_url: 'data:image/png;base64,aaa',
    image_urls: ['data:image/png;base64,aaa', 'data:image/png;base64,bbb'],
    image_count: 2,
    created_at: NOW - 1000,
    expires_at: FUTURE,
    sold_at: null,
    ...overrides,
  };
}

function seed(auctions: Record<string, any>[], options: FakeSupabaseOptions = {}): FakeSupabase {
  const db = createFakeSupabase({ users: [SELLER, OTHER], auctions }, options);
  mocks.client = db;
  return db;
}

async function call(method: string, path: string, options: { token?: string; body?: any; rawBody?: string; env?: any } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  return worker.fetch(
    new Request(`https://msa-auction.test${path}`, {
      method,
      headers,
      body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    }),
    options.env ?? ENV,
  );
}

async function callJson(method: string, path: string, options: { token?: string; body?: any; rawBody?: string; env?: any } = {}) {
  const response = await call(method, path, options);
  return { status: response.status, body: (await response.json()) as any };
}

/** The exact key set of an `AuctionItem` on a read route (no phone, no images). */
const READ_KEYS = [
  'category',
  'createdAt',
  'description',
  'expiresAt',
  'id',
  'imageCount',
  'price',
  'sellerId',
  'sellerName',
  'soldAt',
  'status',
  'title',
];

const REMOVED_FIELDS = [
  'startingPrice',
  'currentPrice',
  'highestBidderId',
  'highestBidderName',
  'durationMinutes',
  'startTime',
  'endTime',
  'bids',
  'winnerId',
  'winnerName',
  'winningBid',
];

const NEW_LISTING = {
  title: 'Desk lamp',
  description: 'Still works',
  phoneNumber: '0100000001',
  price: 50,
  category: 'Electronics',
  imageUrls: ['data:image/png;base64,ccc'],
};

beforeEach(() => {
  mocks.client = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ========================================================================== */
/* 1. Status derivation                                                       */
/* ========================================================================== */

describe('deriveListingStatus', () => {
  it('derives expired from a stored-active row whose expires_at has passed', () => {
    expect(deriveListingStatus({ status: 'active', expires_at: NOW + 1 }, NOW)).toBe('active');
    expect(deriveListingStatus({ status: 'active', expires_at: NOW }, NOW)).toBe('expired');
    expect(deriveListingStatus({ status: 'active', expires_at: NOW - 1 }, NOW)).toBe('expired');
  });

  it('treats a NULL expiry as expired, matching SQL (NULL > now is not true)', () => {
    expect(deriveListingStatus({ status: 'active', expires_at: null }, NOW)).toBe('expired');
  });

  it('accepts expires_at as a bigint-in-a-string', () => {
    expect(deriveListingStatus({ status: 'active', expires_at: String(NOW + 1000) }, NOW)).toBe('active');
  });

  it('passes sold / cancelled / hidden through regardless of expiry', () => {
    for (const status of ['sold', 'cancelled', 'hidden']) {
      expect(deriveListingStatus({ status, expires_at: NOW - DAY_MS }, NOW)).toBe(status);
      expect(deriveListingStatus({ status, expires_at: NOW + DAY_MS }, NOW)).toBe(status);
    }
  });

  it('reads a legacy "ended" row (between migrations 006 and 007) as sold or expired', () => {
    expect(deriveListingStatus({ status: 'ended', sold_at: NOW - 5 }, NOW)).toBe('sold');
    expect(deriveListingStatus({ status: 'ended', sold_at: null }, NOW)).toBe('expired');
  });
});

/* ========================================================================== */
/* 2. GET /api/auctions - live listings only                                  */
/* ========================================================================== */

describe('GET /api/auctions', () => {
  it('shows only active, unexpired listings - not sold, cancelled, hidden, expired or legacy ended', async () => {
    seed([
      listingRow({ id: 'auc_live' }),
      listingRow({ id: 'auc_sold', status: 'sold', sold_at: PAST }),
      listingRow({ id: 'auc_cancelled', status: 'cancelled' }),
      listingRow({ id: 'auc_hidden', status: 'hidden' }),
      listingRow({ id: 'auc_expired', expires_at: PAST }),
      listingRow({ id: 'auc_no_expiry', expires_at: null }),
      listingRow({ id: 'auc_ended', status: 'ended' }),
    ]);

    const result = await callJson('GET', '/api/auctions');

    expect(result.status).toBe(200);
    expect(result.body.auctions.map((auction: any) => auction.id)).toEqual(['auc_live']);
    expect(result.body.nextCursor).toBeNull();
  });

  it('filters IN SQL on status = active AND expires_at > now', async () => {
    const db = seed([listingRow()]);

    await callJson('GET', '/api/auctions');

    const listSelect = db.operations.find((op) => op.op === 'select' && op.table === 'auctions');
    expect(listSelect?.filters).toContainEqual({ op: 'eq', column: 'status', value: 'active' });
    const expiry = listSelect?.filters.find((filter) => filter.column === 'expires_at');
    expect(expiry?.op).toBe('gt');
    expect(Math.abs(Number(expiry?.value) - NOW)).toBeLessThan(60_000);
  });

  it('returns the new AuctionItem shape and none of the removed bid fields', async () => {
    seed([listingRow({ price: '150.00' })]);

    const auction = (await callJson('GET', '/api/auctions')).body.auctions[0];

    expect(Object.keys(auction).sort()).toEqual(READ_KEYS);
    expect(auction).toMatchObject({
      id: 'auc_1',
      title: 'Vintage lamp',
      price: 150,
      status: 'active',
      sellerId: SELLER.id,
      sellerName: SELLER.name,
      category: 'General',
      imageCount: 2,
      createdAt: NOW - 1000,
      expiresAt: FUTURE,
      soldAt: null,
    });
    for (const field of REMOVED_FIELDS) {
      expect(auction).not.toHaveProperty(field);
    }
  });

  it('never selects image payload or phone_number columns for the public list', async () => {
    // fake-supabase does not project rows by the column list (real PostgREST does), so this
    // checks the query actually sent.
    const db = seed([listingRow()]);

    const result = await callJson('GET', '/api/auctions', { token: OTHER.token });

    expect(JSON.stringify(result.body)).not.toContain('base64');
    expect(result.body.auctions[0]).not.toHaveProperty('phoneNumber');
    const listColumns = db.selectColumns('auctions')[0] ?? '';
    expect(listColumns.split(',')).not.toContain('image_urls');
    expect(listColumns.split(',')).not.toContain('image_url');
    expect(listColumns.split(',')).not.toContain('phone_number');
    for (const column of ['price', 'expires_at', 'sold_at', 'created_at', 'image_count']) {
      expect(listColumns.split(',')).toContain(column);
    }
  });

  it('falls back to counting image_urls when image_count is absent', async () => {
    seed([listingRow({ image_count: undefined })]);

    expect((await callJson('GET', '/api/auctions')).body.auctions[0].imageCount).toBe(2);
  });
});

describe('GET /api/auctions - keyset pagination (newest first)', () => {
  function page(size: number) {
    return Array.from({ length: size }, (_, index) =>
      listingRow({ id: `auc_${String(index).padStart(3, '0')}`, created_at: NOW - 100_000 + index }),
    );
  }

  it('defaults to 24 per page and hands back a cursor', async () => {
    seed(page(30));

    const result = await callJson('GET', '/api/auctions');

    expect(result.body.auctions).toHaveLength(24);
    expect(typeof result.body.nextCursor).toBe('string');
  });

  it('walks the whole set with the cursor, with no gaps and no repeats', async () => {
    seed(page(30));

    const first = await callJson('GET', '/api/auctions?limit=12');
    const second = await callJson('GET', `/api/auctions?limit=12&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    const third = await callJson('GET', `/api/auctions?limit=12&cursor=${encodeURIComponent(second.body.nextCursor)}`);

    expect(first.body.auctions).toHaveLength(12);
    expect(second.body.auctions).toHaveLength(12);
    expect(third.body.auctions).toHaveLength(6);
    expect(third.body.nextCursor).toBeNull();

    const seen = [...first.body.auctions, ...second.body.auctions, ...third.body.auctions].map((a: any) => a.id);
    expect(new Set(seen).size).toBe(30);
  });

  it('orders newest created first', async () => {
    seed([
      listingRow({ id: 'auc_old', created_at: NOW - 9000 }),
      listingRow({ id: 'auc_new', created_at: NOW - 1000 }),
      listingRow({ id: 'auc_mid', created_at: NOW - 5000 }),
    ]);

    const result = await callJson('GET', '/api/auctions');

    expect(result.body.auctions.map((auction: any) => auction.id)).toEqual(['auc_new', 'auc_mid', 'auc_old']);
  });

  it('breaks a created_at tie on id, so equal timestamps still page cleanly', async () => {
    seed([
      listingRow({ id: 'auc_a', created_at: NOW }),
      listingRow({ id: 'auc_b', created_at: NOW }),
      listingRow({ id: 'auc_c', created_at: NOW }),
    ]);

    const first = await callJson('GET', '/api/auctions?limit=2');
    const second = await callJson('GET', `/api/auctions?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);

    expect(first.body.auctions.map((a: any) => a.id)).toEqual(['auc_c', 'auc_b']);
    expect(second.body.auctions.map((a: any) => a.id)).toEqual(['auc_a']);
  });

  it('keeps non-live listings out of every page', async () => {
    seed([
      listingRow({ id: 'auc_a', created_at: NOW - 1 }),
      listingRow({ id: 'auc_b', created_at: NOW - 2, status: 'sold' }),
      listingRow({ id: 'auc_c', created_at: NOW - 3, expires_at: PAST }),
      listingRow({ id: 'auc_d', created_at: NOW - 4 }),
    ]);

    const first = await callJson('GET', '/api/auctions?limit=1');
    const next = await callJson('GET', `/api/auctions?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);

    expect(first.body.auctions.map((a: any) => a.id)).toEqual(['auc_a']);
    expect(next.body.auctions.map((a: any) => a.id)).toEqual(['auc_d']);
    expect(next.body.nextCursor).toBeNull();
  });

  it('clamps limit to 60 and ignores junk values', async () => {
    seed(page(70));

    expect((await callJson('GET', '/api/auctions?limit=500')).body.auctions).toHaveLength(60);
    expect((await callJson('GET', '/api/auctions?limit=abc')).body.auctions).toHaveLength(24);
  });

  it('rejects a tampered cursor instead of silently returning page one', async () => {
    seed(page(5));

    for (const cursor of ['not-a-real-cursor', encodeAuctionCursor('1.5', 'auc_1'), btoa('123:auc_1")or(id.gt.')]) {
      const result = await callJson('GET', `/api/auctions?cursor=${encodeURIComponent(cursor)}`);
      expect(result.status, cursor).toBe(400);
      expect(result.body.code).toBe('INVALID_CURSOR');
    }
  });

  it('round-trips a cursor as <created_at>:<id>', () => {
    expect(decodeAuctionCursor(encodeAuctionCursor(1_700_000_000_123, 'auc_1_ab'))).toEqual({
      createdAt: 1_700_000_000_123,
      id: 'auc_1_ab',
    });
  });
});

/* ========================================================================== */
/* 3. GET /api/auctions/:id                                                   */
/* ========================================================================== */

describe('GET /api/auctions/:id', () => {
  it('carries no image data, reports imageCount, and never selects image columns', async () => {
    const db = seed([listingRow()]);

    const result = await callJson('GET', '/api/auctions/auc_1');

    expect(result.status).toBe(200);
    expect(result.body.auction).not.toHaveProperty('imageUrls');
    expect(result.body.auction.imageCount).toBe(2);
    expect(JSON.stringify(result.body)).not.toContain('base64');
    const columns = (db.selectColumns('auctions')[0] ?? '').split(',');
    expect(columns).not.toContain('image_urls');
    expect(columns).not.toContain('image_url');
  });

  it('omits phoneNumber for an anonymous caller and includes it for a signed-in one', async () => {
    seed([listingRow()]);

    const anonymous = await callJson('GET', '/api/auctions/auc_1');
    expect(anonymous.body.auction).not.toHaveProperty('phoneNumber');
    expect(Object.keys(anonymous.body.auction).sort()).toEqual(READ_KEYS);

    const signedIn = await callJson('GET', '/api/auctions/auc_1', { token: OTHER.token });
    expect(signedIn.body.auction.phoneNumber).toBe('0100000000');
  });

  it('answers a Bearer token that does not resolve with 401 SESSION_EXPIRED, not as anonymous', async () => {
    seed([listingRow()]);

    for (const token of ['tok_rotated_by_another_login', '   ']) {
      const response = await worker.fetch(
        new Request('https://msa-auction.test/api/auctions/auc_1', { headers: { authorization: `Bearer ${token}` } }),
        ENV,
      );
      const body = (await response.json()) as any;
      expect(response.status, JSON.stringify(token)).toBe(401);
      expect(body.code).toBe('SESSION_EXPIRED');
      expect(JSON.stringify(body)).not.toContain('0100000000');
    }
  });

  it('treats a request with no Authorization header, or a non-Bearer one, as anonymous', async () => {
    seed([listingRow()]);

    const none = await call('GET', '/api/auctions/auc_1');
    expect(none.status).toBe(200);

    const basic = await worker.fetch(
      new Request('https://msa-auction.test/api/auctions/auc_1', { headers: { authorization: 'Basic abc' } }),
      ENV,
    );
    expect(basic.status).toBe(200);
    expect(((await basic.json()) as any).auction).not.toHaveProperty('phoneNumber');
  });

  it('still returns a sold listing, with status sold and soldAt', async () => {
    seed([listingRow({ status: 'sold', sold_at: NOW - 500 })]);

    const result = await callJson('GET', '/api/auctions/auc_1');

    expect(result.status).toBe(200);
    expect(result.body.auction).toMatchObject({ status: 'sold', soldAt: NOW - 500 });
  });

  it('derives status expired for a stored-active listing past its expiry', async () => {
    seed([listingRow({ expires_at: PAST })]);

    const result = await callJson('GET', '/api/auctions/auc_1');

    expect(result.status).toBe(200);
    expect(result.body.auction).toMatchObject({ status: 'expired', expiresAt: PAST });
  });

  it('writes nothing - there is no lazy settle any more', async () => {
    const db = seed([listingRow({ expires_at: PAST })]);

    await callJson('GET', '/api/auctions/auc_1');

    expect(db.operations.filter((op) => op.op !== 'select')).toEqual([]);
    expect(db.rows('auctions')[0].status).toBe('active');
  });

  it('404s an unknown id', async () => {
    seed([listingRow()]);

    const result = await callJson('GET', '/api/auctions/auc_nope');

    expect(result.status).toBe(404);
    expect(result.body.code).toBe('AUCTION_NOT_FOUND');
  });
});

describe('GET /api/auctions/:id/images', () => {
  it('returns the images with a public cache header and no auth', async () => {
    seed([listingRow()]);

    const response = await call('GET', '/api/auctions/auc_1/images');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(await response.json()).toEqual({
      imageUrls: ['data:image/png;base64,aaa', 'data:image/png;base64,bbb'],
    });
  });

  it('404s for an unknown listing', async () => {
    seed([listingRow()]);

    const result = await callJson('GET', '/api/auctions/auc_nope/images');

    expect(result.status).toBe(404);
    expect(result.body.code).toBe('AUCTION_NOT_FOUND');
  });
});

/* ========================================================================== */
/* 4. POST /api/auctions                                                      */
/* ========================================================================== */

describe('POST /api/auctions', () => {
  it('creates an active listing at a fixed price that expires LISTING_TTL_DAYS (default 30) from now', async () => {
    const db = seed([]);

    const before = Date.now();
    const result = await callJson('POST', '/api/auctions', { token: SELLER.token, body: NEW_LISTING });
    const after = Date.now();

    expect(result.status).toBe(201);
    const auction = result.body.auction;
    expect(auction).toMatchObject({
      title: 'Desk lamp',
      price: 50,
      status: 'active',
      sellerId: SELLER.id,
      sellerName: SELLER.name,
      category: 'Electronics',
      phoneNumber: '0100000001',
      imageUrls: ['data:image/png;base64,ccc'],
      imageUrl: 'data:image/png;base64,ccc',
      soldAt: null,
    });
    expect(auction.expiresAt - auction.createdAt).toBe(30 * DAY_MS);
    expect(auction.createdAt).toBeGreaterThanOrEqual(before);
    expect(auction.createdAt).toBeLessThanOrEqual(after);
    for (const field of REMOVED_FIELDS) {
      expect(auction).not.toHaveProperty(field);
    }

    const row = db.rows('auctions')[0];
    expect(row).toMatchObject({ price: 50, status: 'active', sold_at: null, expires_at: auction.expiresAt });
    for (const legacy of ['starting_price', 'current_price', 'end_time', 'bids', 'winner_id', 'duration_minutes']) {
      expect(row).not.toHaveProperty(legacy);
    }
  });

  it('honours LISTING_TTL_DAYS from the env, and falls back to 30 on junk', async () => {
    seed([]);
    const seven = await callJson('POST', '/api/auctions', {
      token: SELLER.token,
      body: NEW_LISTING,
      env: { ...ENV, LISTING_TTL_DAYS: '7' },
    });
    expect(seven.body.auction.expiresAt - seven.body.auction.createdAt).toBe(7 * DAY_MS);

    seed([]);
    const junk = await callJson('POST', '/api/auctions', {
      token: SELLER.token,
      body: NEW_LISTING,
      env: { ...ENV, LISTING_TTL_DAYS: '0' },
    });
    expect(junk.body.auction.expiresAt - junk.body.auction.createdAt).toBe(30 * DAY_MS);
  });

  it('requires authentication', async () => {
    const db = seed([]);

    const result = await callJson('POST', '/api/auctions', { body: NEW_LISTING });

    expect(result.status).toBe(401);
    expect(db.rows('auctions')).toHaveLength(0);
  });

  it('refuses an old auction-style body (startingPrice / durationMinutes, no price)', async () => {
    seed([]);
    const { price: _price, ...withoutPrice } = NEW_LISTING;

    const result = await callJson('POST', '/api/auctions', {
      token: SELLER.token,
      body: { ...withoutPrice, startingPrice: 50, durationMinutes: 60 },
    });

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_PRICE');
  });

  it('answers a malformed JSON body with 400 INVALID_PAYLOAD, not a 500', async () => {
    seed([]);

    const result = await callJson('POST', '/api/auctions', { token: SELLER.token, rawBody: '{"title": ' });

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_PAYLOAD');
  });
});

describe('POST /api/auctions - the listing cap counts LIVE listings only', () => {
  function sellerRows(count: number, overrides: Record<string, any>, idPrefix: string) {
    return Array.from({ length: count }, (_, index) => listingRow({ id: `${idPrefix}${index}`, ...overrides }));
  }

  it('does not count sold, cancelled or expired listings', async () => {
    seed([
      ...sellerRows(10, { status: 'sold', sold_at: PAST }, 'auc_sold_'),
      ...sellerRows(10, { status: 'cancelled' }, 'auc_gone_'),
      ...sellerRows(10, { expires_at: PAST }, 'auc_expired_'),
      ...sellerRows(19, {}, 'auc_live_'),
    ]);

    const result = await callJson('POST', '/api/auctions', { token: SELLER.token, body: NEW_LISTING });

    expect(result.status).toBe(201);
  });

  it('blocks a seller at the cap on live listings, and says so', async () => {
    const db = seed(sellerRows(20, {}, 'auc_live_'));

    const result = await callJson('POST', '/api/auctions', { token: SELLER.token, body: NEW_LISTING });

    expect(result.status).toBe(429);
    expect(result.body.code).toBe('LISTING_LIMIT_REACHED');
    expect(result.body.error).toContain('20 active listings');
    expect(db.rows('auctions')).toHaveLength(20);
  });

  it('counts in SQL on seller_id, status = active and expires_at > now', async () => {
    const db = seed(sellerRows(3, {}, 'auc_live_'));

    await callJson('POST', '/api/auctions', { token: SELLER.token, body: NEW_LISTING });

    const count = db.operations.find(
      (op) => op.op === 'select' && op.table === 'auctions' && op.filters.some((filter) => filter.column === 'seller_id'),
    );
    expect(count?.filters).toContainEqual({ op: 'eq', column: 'seller_id', value: SELLER.id });
    expect(count?.filters).toContainEqual({ op: 'eq', column: 'status', value: 'active' });
    expect(count?.filters.some((filter) => filter.op === 'gt' && filter.column === 'expires_at')).toBe(true);
  });
});

describe('listing validation (F7)', () => {
  async function create(overrides: Record<string, any>) {
    seed([]);
    return callJson('POST', '/api/auctions', { token: SELLER.token, body: { ...NEW_LISTING, ...overrides } });
  }

  it('price: must be > 0, <= 100000, and whole pence', async () => {
    for (const price of [0, -5, 100000.01, 12.345, 0.001, 'abc', '', null, true, Number.NaN, 1e309]) {
      const result = await create({ price });
      expect(result.status, String(price)).toBe(400);
      expect(result.body.code, String(price)).toBe('INVALID_PRICE');
    }
  });

  it('price: accepts pence that binary floating point cannot represent, and numeric strings', async () => {
    for (const [price, stored] of [
      [19.99, 19.99],
      [0.01, 0.01],
      [100000, 100000],
      ['12.50', 12.5],
      [1.1, 1.1],
    ] as const) {
      const result = await create({ price });
      expect(result.status, String(price)).toBe(201);
      expect(result.body.auction.price).toBe(stored);
    }
  });

  it('parseListingPrice rounds to exact pence', () => {
    expect(parseListingPrice(0.1 + 0.2)).toBe(0.3);
    expect(parseListingPrice(19.99)).toBe(19.99);
    expect(parseListingPrice(19.999)).toBeNull();
  });

  it('title: max 100 characters (after trimming)', async () => {
    expect((await create({ title: 'a'.repeat(100) })).status).toBe(201);
    expect((await create({ title: `  ${'a'.repeat(100)}  ` })).status).toBe(201);

    const tooLong = await create({ title: 'a'.repeat(101) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('TITLE_TOO_LONG');
  });

  it('description: max 2000 characters', async () => {
    expect((await create({ description: 'd'.repeat(2000) })).status).toBe(201);

    const tooLong = await create({ description: 'd'.repeat(2001) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('DESCRIPTION_TOO_LONG');
  });

  it('phoneNumber: max 30 characters', async () => {
    expect((await create({ phoneNumber: '+44 7700 900000' })).status).toBe(201);

    const tooLong = await create({ phoneNumber: '0'.repeat(31) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('PHONE_TOO_LONG');
  });

  it('category: must be one of the allowed categories; absent means General', async () => {
    for (const category of LISTING_CATEGORIES) {
      expect((await create({ category })).status, category).toBe(201);
    }

    for (const category of ['Home', 'All', 'electronics', '<script>']) {
      const result = await create({ category });
      expect(result.status, category).toBe(400);
      expect(result.body.code, category).toBe('INVALID_CATEGORY');
    }

    const { category: _category, ...withoutCategory } = NEW_LISTING;
    seed([]);
    const defaulted = await callJson('POST', '/api/auctions', { token: SELLER.token, body: withoutCategory });
    expect(defaulted.status).toBe(201);
    expect(defaulted.body.auction.category).toBe('General');
  });

  it('still requires title, description and phone number', async () => {
    const result = await create({ title: '   ' });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('MISSING_FIELDS');
  });
});

/* ========================================================================== */
/* 5. PATCH /api/auctions/:id                                                 */
/* ========================================================================== */

describe('PATCH /api/auctions/:id', () => {
  it('updates the editable fields, including price, and never touches expires_at', async () => {
    const db = seed([listingRow()]);

    const result = await callJson('PATCH', '/api/auctions/auc_1', {
      token: SELLER.token,
      body: { title: 'Nicer lamp', description: 'Much nicer', category: 'Collectibles', price: 250 },
    });

    expect(result.status).toBe(200);
    expect(result.body.auction).toMatchObject({
      title: 'Nicer lamp',
      description: 'Much nicer',
      category: 'Collectibles',
      price: 250,
      expiresAt: FUTURE,
      phoneNumber: '0100000000',
      status: 'active',
    });
    expect(result.body.auction.imageUrls).toHaveLength(2);

    const row = db.rows('auctions')[0];
    expect(row).toMatchObject({ price: 250, expires_at: FUTURE, phone_number: '0100000000' });
    expect(row.image_urls).toHaveLength(2);
    expect(db.operations.find((op) => op.op === 'update')?.payload).not.toHaveProperty('expires_at');
  });

  it('ignores an attempt to move expires_at, status or sold_at through the body', async () => {
    const db = seed([listingRow()]);

    await callJson('PATCH', '/api/auctions/auc_1', {
      token: SELLER.token,
      body: { title: 'Renamed', expiresAt: NOW + 365 * DAY_MS, expires_at: 1, status: 'sold', soldAt: NOW },
    });

    expect(db.rows('auctions')[0]).toMatchObject({ title: 'Renamed', expires_at: FUTURE, status: 'active', sold_at: null });
  });

  it('rejects the edit when the caller is not the seller', async () => {
    const db = seed([listingRow()]);

    const result = await callJson('PATCH', '/api/auctions/auc_1', { token: OTHER.token, body: { title: 'Mine now' } });

    expect(result.status).toBe(403);
    expect(result.body.code).toBe('NOT_LISTING_OWNER');
    expect(db.rows('auctions')[0].title).toBe('Vintage lamp');
  });

  it('requires authentication, and 404s an unknown listing', async () => {
    seed([listingRow()]);
    expect((await callJson('PATCH', '/api/auctions/auc_1', { body: { title: 'x' } })).status).toBe(401);

    const missing = await callJson('PATCH', '/api/auctions/auc_missing', { token: SELLER.token, body: { title: 'x' } });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('AUCTION_NOT_FOUND');
  });

  it('refuses to edit a sold, cancelled or expired listing', async () => {
    for (const overrides of [{ status: 'sold', sold_at: PAST }, { status: 'cancelled' }, { expires_at: PAST }]) {
      const db = seed([listingRow(overrides)]);

      const result = await callJson('PATCH', '/api/auctions/auc_1', { token: SELLER.token, body: { title: 'x' } });

      expect(result.status, JSON.stringify(overrides)).toBe(409);
      expect(result.body.code).toBe('LISTING_NOT_EDITABLE');
      expect(db.rows('auctions')[0].title).toBe('Vintage lamp');
    }
  });

  it('guards the write on status = active, expires_at > now and the seller id', async () => {
    const db = seed([listingRow()]);

    await callJson('PATCH', '/api/auctions/auc_1', { token: SELLER.token, body: { title: 'x' } });

    const filters = db.updateFilters('auctions')[0];
    expect(filters).toContainEqual({ op: 'eq', column: 'status', value: 'active' });
    expect(filters).toContainEqual({ op: 'eq', column: 'seller_id', value: SELLER.id });
    expect(filters.some((filter) => filter.op === 'gt' && filter.column === 'expires_at')).toBe(true);
  });

  it('answers 409 when the listing sells between the read and the write (zero rows updated)', async () => {
    let db: FakeSupabase;
    db = seed([listingRow()], {
      beforeUpdate: () => {
        Object.assign(db.rows('auctions')[0], { status: 'sold', sold_at: NOW });
      },
    });

    const result = await callJson('PATCH', '/api/auctions/auc_1', { token: SELLER.token, body: { title: 'x' } });

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('LISTING_NOT_EDITABLE');
    expect(result.body.error).toContain('sold');
    expect(db.rows('auctions')[0].title).toBe('Vintage lamp');
  });

  it('reuses the creation validator (price, required fields, images, lengths)', async () => {
    const cases: [Record<string, any>, string][] = [
      [{ price: 0 }, 'INVALID_PRICE'],
      [{ price: 12.345 }, 'INVALID_PRICE'],
      [{ title: '   ' }, 'MISSING_FIELDS'],
      [{ title: 't'.repeat(101) }, 'TITLE_TOO_LONG'],
      [{ imageUrls: ['a', 'b', 'c', 'd'] }, 'TOO_MANY_IMAGES'],
      [{ category: 'Home' }, 'INVALID_CATEGORY'],
    ];

    for (const [body, code] of cases) {
      seed([listingRow()]);
      const result = await callJson('PATCH', '/api/auctions/auc_1', { token: SELLER.token, body });
      expect(result.status, code).toBe(400);
      expect(result.body.code, code).toBe(code);
    }
  });

  it('lets a legacy listing be edited without tripping on fields the seller did not change', async () => {
    // A pre-v1 row: category outside today's list, and a title longer than today's cap.
    const legacyTitle = 'L'.repeat(140);
    const db = seed([listingRow({ category: 'Home', title: legacyTitle })]);

    const result = await callJson('PATCH', '/api/auctions/auc_1', { token: SELLER.token, body: { price: 80 } });

    expect(result.status).toBe(200);
    expect(db.rows('auctions')[0]).toMatchObject({ price: 80, category: 'Home', title: legacyTitle });
  });

  it('ignores a startingPrice field from an old client', async () => {
    const db = seed([listingRow()]);

    const result = await callJson('PATCH', '/api/auctions/auc_1', { token: SELLER.token, body: { startingPrice: 999 } });

    expect(result.status).toBe(200);
    expect(db.rows('auctions')[0].price).toBe(100);
  });
});

/* ========================================================================== */
/* 6. POST /api/auctions/:id/sold                                             */
/* ========================================================================== */

describe('POST /api/auctions/:id/sold', () => {
  it('lets the seller mark a live listing sold: status sold, sold_at set, off the browse page', async () => {
    const db = seed([listingRow(), listingRow({ id: 'auc_2', created_at: NOW - 2000 })]);

    const before = Date.now();
    const result = await callJson('POST', '/api/auctions/auc_1/sold', { token: SELLER.token });

    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.auction).toMatchObject({ id: 'auc_1', status: 'sold' });
    expect(result.body.auction.soldAt).toBeGreaterThanOrEqual(before);

    const row = db.rows('auctions').find((entry: any) => entry.id === 'auc_1');
    expect(row.status).toBe('sold');
    expect(row.sold_at).toBe(result.body.auction.soldAt);
    // Expiry is untouched - selling is not an edit of the listing's life.
    expect(row.expires_at).toBe(FUTURE);

    const list = await callJson('GET', '/api/auctions');
    expect(list.body.auctions.map((auction: any) => auction.id)).toEqual(['auc_2']);

    const byId = await callJson('GET', '/api/auctions/auc_1');
    expect(byId.status).toBe(200);
    expect(byId.body.auction.status).toBe('sold');
  });

  it('refuses anyone but the seller with 403, and changes nothing', async () => {
    const db = seed([listingRow()]);

    const result = await callJson('POST', '/api/auctions/auc_1/sold', { token: OTHER.token });

    expect(result.status).toBe(403);
    expect(result.body.code).toBe('NOT_LISTING_OWNER');
    expect(db.rows('auctions')[0]).toMatchObject({ status: 'active', sold_at: null });
    expect(db.operations.filter((op) => op.op === 'update')).toEqual([]);
  });

  it('answers 409 on a listing that is already sold, and keeps the original sold_at', async () => {
    const db = seed([listingRow({ status: 'sold', sold_at: NOW - 5000 })]);

    const result = await callJson('POST', '/api/auctions/auc_1/sold', { token: SELLER.token });

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('LISTING_NOT_EDITABLE');
    expect(db.rows('auctions')[0].sold_at).toBe(NOW - 5000);
  });

  it('answers 409 on a cancelled or expired listing', async () => {
    for (const overrides of [{ status: 'cancelled' }, { expires_at: PAST }]) {
      const db = seed([listingRow(overrides)]);

      const result = await callJson('POST', '/api/auctions/auc_1/sold', { token: SELLER.token });

      expect(result.status, JSON.stringify(overrides)).toBe(409);
      expect(result.body.code).toBe('LISTING_NOT_EDITABLE');
      expect(db.rows('auctions')[0].sold_at).toBeNull();
    }
  });

  it('answers 409 when the guarded UPDATE matches zero rows (cancelled mid-request)', async () => {
    let db: FakeSupabase;
    db = seed([listingRow()], {
      beforeUpdate: () => {
        db.rows('auctions')[0].status = 'cancelled';
      },
    });

    const result = await callJson('POST', '/api/auctions/auc_1/sold', { token: SELLER.token });

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('LISTING_NOT_EDITABLE');
    expect(db.rows('auctions')[0]).toMatchObject({ status: 'cancelled', sold_at: null });
  });

  it('guards the write on status = active, expires_at > now and the seller id', async () => {
    const db = seed([listingRow()]);

    await callJson('POST', '/api/auctions/auc_1/sold', { token: SELLER.token });

    const filters = db.updateFilters('auctions')[0];
    expect(filters).toContainEqual({ op: 'eq', column: 'status', value: 'active' });
    expect(filters).toContainEqual({ op: 'eq', column: 'seller_id', value: SELLER.id });
    expect(filters.some((filter) => filter.op === 'gt' && filter.column === 'expires_at')).toBe(true);
  });

  it('requires authentication, and 404s an unknown listing', async () => {
    seed([listingRow()]);

    const anonymous = await callJson('POST', '/api/auctions/auc_1/sold');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe('UNAUTHORIZED');

    const missing = await callJson('POST', '/api/auctions/auc_missing/sold', { token: SELLER.token });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('AUCTION_NOT_FOUND');
  });
});

/* ========================================================================== */
/* 7. DELETE /api/auctions/:id                                                */
/* ========================================================================== */

describe('DELETE /api/auctions/:id', () => {
  it('soft-cancels the listing: off the browse page, still fetchable by id as cancelled', async () => {
    const db = seed([listingRow(), listingRow({ id: 'auc_2', created_at: NOW - 2000 })]);

    const deleted = await callJson('DELETE', '/api/auctions/auc_1', { token: SELLER.token });

    expect(deleted.status).toBe(200);
    expect(deleted.body.success).toBe(true);
    expect(deleted.body.auction.status).toBe('cancelled');
    expect(db.rows('auctions')).toHaveLength(2);

    const list = await callJson('GET', '/api/auctions');
    expect(list.body.auctions.map((auction: any) => auction.id)).toEqual(['auc_2']);

    const byId = await callJson('GET', '/api/auctions/auc_1');
    expect(byId.body.auction).toMatchObject({ id: 'auc_1', status: 'cancelled' });
  });

  it('rejects a cancel from someone other than the seller', async () => {
    const db = seed([listingRow()]);

    const result = await callJson('DELETE', '/api/auctions/auc_1', { token: OTHER.token });

    expect(result.status).toBe(403);
    expect(result.body.code).toBe('NOT_LISTING_OWNER');
    expect(db.rows('auctions')[0].status).toBe('active');
  });

  it('answers 409 on a listing that is not live (sold, already cancelled, expired)', async () => {
    for (const overrides of [{ status: 'sold', sold_at: PAST }, { status: 'cancelled' }, { expires_at: PAST }]) {
      const db = seed([listingRow(overrides)]);

      const result = await callJson('DELETE', '/api/auctions/auc_1', { token: SELLER.token });

      expect(result.status, JSON.stringify(overrides)).toBe(409);
      expect(result.body.code).toBe('LISTING_NOT_EDITABLE');
      expect(db.rows('auctions')[0].status).toBe(overrides.status ?? 'active');
    }
  });

  it('answers 409 - not a false success - when the guarded UPDATE matches zero rows', async () => {
    let db: FakeSupabase;
    db = seed([listingRow()], {
      beforeUpdate: () => {
        Object.assign(db.rows('auctions')[0], { status: 'sold', sold_at: NOW });
      },
    });

    const result = await callJson('DELETE', '/api/auctions/auc_1', { token: SELLER.token });

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('LISTING_NOT_EDITABLE');
    expect(db.rows('auctions')[0].status).toBe('sold');
  });

  it('guards the write and asks for the updated rows back', async () => {
    const db = seed([listingRow()]);

    await callJson('DELETE', '/api/auctions/auc_1', { token: SELLER.token });

    const update = db.operations.find((op) => op.op === 'update');
    expect(update?.payload).toEqual({ status: 'cancelled' });
    expect(update?.columns).toContain('id');
    expect(update?.filters).toContainEqual({ op: 'eq', column: 'status', value: 'active' });
    expect(update?.filters.some((filter) => filter.op === 'gt' && filter.column === 'expires_at')).toBe(true);
  });

  it('requires authentication', async () => {
    const db = seed([listingRow()]);

    const result = await callJson('DELETE', '/api/auctions/auc_1');

    expect(result.status).toBe(401);
    expect(db.rows('auctions')[0].status).toBe('active');
  });
});

/* ========================================================================== */
/* 8. GET /api/users/me/activity                                              */
/* ========================================================================== */

describe('GET /api/users/me/activity', () => {
  it("returns only the caller's own listings, every status including hidden, newest first", async () => {
    seed([
      listingRow({ id: 'auc_live', created_at: NOW - 1 }),
      listingRow({ id: 'auc_sold', status: 'sold', sold_at: PAST, created_at: NOW - 2 }),
      listingRow({ id: 'auc_hidden', status: 'hidden', created_at: NOW - 3 }),
      listingRow({ id: 'auc_expired', expires_at: PAST, created_at: NOW - 4 }),
      listingRow({ id: 'auc_cancelled', status: 'cancelled', created_at: NOW - 5 }),
      listingRow({ id: 'auc_theirs', seller_id: OTHER.id, seller_name: OTHER.name }),
    ]);

    const result = await callJson('GET', '/api/users/me/activity', { token: SELLER.token });

    expect(result.status).toBe(200);
    expect(Object.keys(result.body)).toEqual(['listings']);
    expect(result.body.listings.map((listing: any) => [listing.id, listing.status])).toEqual([
      ['auc_live', 'active'],
      ['auc_sold', 'sold'],
      ['auc_hidden', 'hidden'],
      ['auc_expired', 'expired'],
      ['auc_cancelled', 'cancelled'],
    ]);
  });

  it('filters on seller_id IN SQL rather than scanning the table', async () => {
    const db = seed([listingRow(), listingRow({ id: 'auc_theirs', seller_id: OTHER.id })]);

    await callJson('GET', '/api/users/me/activity', { token: SELLER.token });

    const selects = db.operations.filter((op) => op.op === 'select' && op.table === 'auctions');
    expect(selects).toHaveLength(1);
    expect(selects[0].filters).toContainEqual({ op: 'eq', column: 'seller_id', value: SELLER.id });
  });

  it('carries the phone number (own data) but no image payload', async () => {
    const db = seed([listingRow()]);

    const listing = (await callJson('GET', '/api/users/me/activity', { token: SELLER.token })).body.listings[0];

    expect(listing.phoneNumber).toBe('0100000000');
    expect(listing.imageCount).toBe(2);
    expect(listing).not.toHaveProperty('imageUrls');
    const columns = (db.selectColumns('auctions')[0] ?? '').split(',');
    expect(columns).not.toContain('image_urls');
    expect(columns).not.toContain('image_url');
  });

  it('requires authentication', async () => {
    seed([listingRow()]);

    expect((await callJson('GET', '/api/users/me/activity')).status).toBe(401);
    expect((await callJson('GET', '/api/users/me/activity', { token: 'tok_nobody' })).body.code).toBe('SESSION_EXPIRED');
  });
});

/* ========================================================================== */
/* 9. Removed routes                                                          */
/* ========================================================================== */

describe('the bidding routes are gone', () => {
  it('POST /api/auctions/:id/bids and GET /api/notifications answer 404 NOT_FOUND', async () => {
    const db = seed([listingRow()]);

    const bid = await callJson('POST', '/api/auctions/auc_1/bids', { token: OTHER.token, body: { amount: 500 } });
    expect(bid.status).toBe(404);
    expect(bid.body.code).toBe('NOT_FOUND');

    const notifications = await callJson('GET', '/api/notifications', { token: OTHER.token });
    expect(notifications.status).toBe(404);
    expect(notifications.body.code).toBe('NOT_FOUND');

    expect(db.operations.filter((op) => op.op === 'update')).toEqual([]);
  });
});

/* ========================================================================== */
/* 10. F13: a 500 never carries the database's own error text                 */
/* ========================================================================== */

describe('500 responses', () => {
  const DB_ERROR = {
    message: 'column auctions.secret_col does not exist',
    code: '42703',
    details: 'relation "public.auctions"',
    hint: 'Perhaps you meant to reference the column "auctions.price".',
  };

  it('return a generic message and the route code, and log the real error server-side', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.client = createFakeSupabase(
      { users: [SELLER], auctions: [listingRow()] },
      { errorOn: ({ table }) => (table === 'auctions' ? DB_ERROR : null) },
    );

    const result = await callJson('GET', '/api/auctions');

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'Failed to load auctions. [Code: FETCH_AUCTIONS_FAILED]', code: 'FETCH_AUCTIONS_FAILED' });
    const wire = JSON.stringify(result.body);
    for (const leak of ['secret_col', '42703', 'relation', 'Perhaps', 'public.auctions']) {
      expect(wire).not.toContain(leak);
    }
    expect(JSON.stringify(logged.mock.calls)).toContain('secret_col');
  });

  it('applies to the authenticated write routes too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.client = createFakeSupabase(
      { users: [SELLER], auctions: [listingRow()] },
      { errorOn: ({ table, op }) => (table === 'auctions' && op === 'update' ? DB_ERROR : null) },
    );

    const result = await callJson('POST', '/api/auctions/auc_1/sold', { token: SELLER.token });

    expect(result.status).toBe(500);
    expect(result.body.code).toBe('MARK_SOLD_FAILED');
    expect(JSON.stringify(result.body)).not.toContain('secret_col');
  });
});

/* ========================================================================== */
/* 11. The row mapper                                                         */
/* ========================================================================== */

describe('mapListingRow', () => {
  it('coerces a numeric-string price and bigint-string timestamps to numbers', () => {
    const mapped = mapListingRow(
      listingRow({ price: '19.99', created_at: String(NOW), expires_at: String(FUTURE), sold_at: null }),
      { now: NOW },
    );

    expect(mapped).toMatchObject({ price: 19.99, createdAt: NOW, expiresAt: FUTURE, soldAt: null });
  });

  it('includes phoneNumber only when asked, never because the row happens to carry it', () => {
    expect(mapListingRow(listingRow(), { now: NOW })).not.toHaveProperty('phoneNumber');
    expect(mapListingRow(listingRow(), { now: NOW, includePhone: true }).phoneNumber).toBe('0100000000');
  });
});

/* ========================================================================== */
/* 12. Per-listing Open Graph tags                                             */
/* ========================================================================== */

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>MSA Auction</title>
    <meta name="description" content="Real-time online auction platform." />
    <meta property="og:title" content="MSA Auction" />
    <meta property="og:description" content="Real-time online auction platform." />
    <meta property="og:type" content="website" />
    <meta property="og:image" content="/MSA_Logo.png" />
    <meta name="twitter:card" content="summary_large_image" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

function assetsEnv(overrides: { fetch?: () => Promise<Response> } = {}) {
  return {
    ...ENV,
    ASSETS: {
      fetch:
        overrides.fetch ??
        (async () => new Response(SHELL, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })),
    },
  };
}

async function fetchShare(path: string, env: any) {
  const response = await worker.fetch(new Request(`https://msa-auction.test${path}`), env);
  return { response, html: await response.text() };
}

describe('GET /auction/:id - Open Graph injection', () => {
  it('escapes a title containing a double quote and a <script> tag', async () => {
    seed([
      listingRow({
        title: 'Genuine "Vintage" <script>alert(1)</script> lamp',
        description: 'Hand-made & "signed" <b>rare</b>',
        price: 250,
      }),
    ]);

    const { response, html } = await fetchShare('/auction/auc_1', assetsEnv());

    expect(response.status).toBe(200);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('"Vintage"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;Vintage&quot;');
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(html).toContain('<script type="module" src="/src/main.tsx">');
  });

  it('shows the fixed asking price and "For sale", replacing the shell tags rather than duplicating them', async () => {
    seed([listingRow({ title: 'Vintage lamp', price: '250.00' })]);

    const { html } = await fetchShare('/auction/auc_1', assetsEnv());

    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('<title>Vintage lamp - £250 | MSA Auction</title>');
    expect(html).toContain('content="For sale at £250. A lamp"');
    expect(html).not.toContain('Bidding');
    expect(html.match(/property="og:image"/g)).toHaveLength(1);
    expect(html).toContain('<meta property="og:image" content="https://msa-auction.test/MSA_Logo.png" />');
    expect(html).toContain('<meta property="og:url" content="https://msa-auction.test/auction/auc_1" />');
  });

  it('treats $-patterns in listing text literally ($`, $&, $\', $$ are not replacement tokens)', async () => {
    const title = "Lamp $` and $& and $' and $$ deal";
    seed([listingRow({ title, description: 'Desc $`', price: 10 })]);

    const { html } = await fetchShare('/auction/auc_1', assetsEnv());

    // Escaped only for HTML (the apostrophe), otherwise verbatim - not expanded into page text.
    expect(html).toContain('<title>Lamp $` and $&amp; and $&#39; and $$ deal - £10 | MSA Auction</title>');
    // `$\`` would have spliced everything before </head> in again: exactly one doctype, one <head>.
    expect(html.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(html.match(/<head>/g)).toHaveLength(1);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/<\/head>/g)).toHaveLength(1);
  });

  it('shows pence as two digits', async () => {
    seed([listingRow({ price: 12.5 })]);

    const { html } = await fetchShare('/auction/auc_1', assetsEnv());

    expect(html).toContain('<title>Vintage lamp - £12.50 | MSA Auction</title>');
  });

  it('labels a sold and an expired listing as such', async () => {
    seed([listingRow({ status: 'sold', sold_at: PAST, price: 40 })]);
    expect((await fetchShare('/auction/auc_1', assetsEnv())).html).toContain('content="Sold at £40.');

    seed([listingRow({ expires_at: PAST, price: 40 })]);
    expect((await fetchShare('/auction/auc_1', assetsEnv())).html).toContain('content="No longer listed at £40.');
  });

  it('serves the unmodified shell when the listing does not exist, or the lookup throws', async () => {
    seed([listingRow()]);
    expect((await fetchShare('/auction/auc_missing', assetsEnv())).html).toBe(SHELL);

    mocks.client = createFakeSupabase(
      { users: [SELLER], auctions: [listingRow()] },
      { errorOn: ({ table }) => (table === 'auctions' ? { message: 'connection reset', code: 'PGRST000' } : null) },
    );
    expect((await fetchShare('/auction/auc_1', assetsEnv())).html).toBe(SHELL);
  });

  it('leaves non-HTML assets and other SPA routes alone', async () => {
    seed([listingRow()]);

    const json = await fetchShare(
      '/auction/auc_1',
      assetsEnv({ fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }),
    );
    expect(json.html).toBe('{}');

    expect((await fetchShare('/about', assetsEnv())).html).toBe(SHELL);
  });
});
