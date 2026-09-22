// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeSupabase, FakeSupabase, FakeSupabaseOptions } from './helpers/fake-supabase';

// The Worker builds its Supabase client at request time, so the client the
// tests inspect has to come back from createClient().
const mocks = vi.hoisted(() => ({ client: null as any }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mocks.client,
}));

import worker from '../../workers/index';

const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'test-secret' };

const BIDDER = { id: 'usr_bidder', name: 'Bidder', username: 'bidder', token: 'tok_good' };

function auctionRow(overrides: Record<string, any> = {}) {
  const now = Date.now();
  return {
    id: 'auc_1',
    title: 'Vintage lamp',
    description: 'A lamp',
    phone_number: '0100000000',
    starting_price: 100,
    current_price: 100,
    seller_id: 'usr_seller',
    seller_name: 'Seller',
    highest_bidder_id: null,
    highest_bidder_name: null,
    duration_minutes: 60,
    start_time: now - 1000,
    end_time: now + 3_600_000,
    status: 'active',
    category: 'General',
    image_url: 'data:image/png;base64,x',
    image_urls: ['data:image/png;base64,x'],
    bids: [],
    winner_id: null,
    winner_name: null,
    winning_bid: null,
    created_at: now - 1000,
  };
}

function seed(auctionOverrides: Record<string, any> = {}, options: FakeSupabaseOptions = {}): FakeSupabase {
  const db = createFakeSupabase(
    {
      users: [BIDDER],
      auctions: [{ ...auctionRow(), ...auctionOverrides }],
    },
    options,
  );
  mocks.client = db;
  return db;
}

function bidRequest(body: any, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  return new Request('https://msa-auction.test/api/auctions/auc_1/bids', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function placeBid(body: any, token?: string) {
  const response = await worker.fetch(bidRequest(body, token), ENV);
  return { status: response.status, body: await response.json() as any };
}

describe('POST /api/auctions/:id/bids - authentication', () => {
  beforeEach(() => {
    mocks.client = null;
  });

  it('rejects a bid with no Authorization header as UNAUTHORIZED', async () => {
    const db = seed();

    const result = await placeBid({ userId: 'usr_anyone', userName: 'Anyone', amount: 500 });

    expect(result.status).toBe(401);
    expect(result.body.code).toBe('UNAUTHORIZED');
    expect(result.body.error).toContain('Authentication required to place a bid.');
    expect(db.rows('auctions')[0].bids).toHaveLength(0);
  });

  it('rejects a non-Bearer Authorization header as UNAUTHORIZED', async () => {
    seed();

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/auctions/auc_1/bids', {
        method: 'POST',
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
        body: JSON.stringify({ amount: 500 }),
      }),
      ENV,
    );

    expect(response.status).toBe(401);
    expect((await response.json() as any).code).toBe('UNAUTHORIZED');
  });

  it('rejects a token that resolves to no user as SESSION_EXPIRED', async () => {
    const db = seed();

    const result = await placeBid({ amount: 500 }, 'tok_stale');

    expect(result.status).toBe(401);
    expect(result.body.code).toBe('SESSION_EXPIRED');
    expect(result.body.error).toContain('Your session has expired. Please sign in again.');
    expect(db.rows('auctions')[0].bids).toHaveLength(0);
  });

  it('records the token holder as the bidder and ignores userId/userName in the body', async () => {
    const db = seed();

    const result = await placeBid({ userId: 'usr_victim', userName: 'Victim', amount: 250 }, 'tok_good');

    expect(result.status).toBe(200);
    expect(result.body.bid).toMatchObject({ userId: 'usr_bidder', userName: 'Bidder', amount: 250 });

    const row = db.rows('auctions')[0];
    expect(row.bids[0]).toMatchObject({ userId: 'usr_bidder', userName: 'Bidder' });
    expect(row.highest_bidder_id).toBe('usr_bidder');
    expect(row.current_price).toBe(250);
  });

  it('still blocks bidding on your own listing when the body spoofs another userId', async () => {
    const db = seed({ seller_id: BIDDER.id, seller_name: BIDDER.name });

    const result = await placeBid({ userId: 'usr_someone_else', userName: 'Someone', amount: 250 }, 'tok_good');

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('CANNOT_BID_OWN_LISTING');
    expect(db.rows('auctions')[0].bids).toHaveLength(0);
  });
});

describe('POST /api/auctions/:id/bids - optimistic lock', () => {
  beforeEach(() => {
    mocks.client = null;
  });

  it('guards the update on the current_price it read', async () => {
    const db = seed();

    await placeBid({ amount: 250 }, 'tok_good');

    expect(db.updateFilters('auctions')[0]).toContainEqual({ op: 'eq', column: 'current_price', value: 100 });
  });

  it('uses .is(current_price, null) when the row has a null current_price', async () => {
    const db = seed({ current_price: null });

    const result = await placeBid({ amount: 250 }, 'tok_good');

    expect(result.status).toBe(200);
    expect(db.updateFilters('auctions')[0]).toContainEqual({ op: 'is', column: 'current_price', value: null });
    expect(db.rows('auctions')[0].current_price).toBe(250);
  });

  it('retries and succeeds when another bid lands between the read and the write', async () => {
    let db: FakeSupabase;
    db = seed({}, {
      beforeUpdate: ({ table, attempt }) => {
        if (table !== 'auctions' || attempt !== 1) return;
        // A rival bid of £150 commits first.
        const row = db.rows('auctions')[0];
        row.current_price = 150;
        row.highest_bidder_id = 'usr_rival';
        row.highest_bidder_name = 'Rival';
        row.bids = [{ id: 'bid_rival', auctionId: 'auc_1', userId: 'usr_rival', userName: 'Rival', amount: 150, timestamp: Date.now() }];
      },
    });

    const result = await placeBid({ amount: 250 }, 'tok_good');

    expect(result.status).toBe(200);
    expect(db.updateAttempts).toBe(2);

    const row = db.rows('auctions')[0];
    expect(row.current_price).toBe(250);
    expect(row.highest_bidder_id).toBe('usr_bidder');
    // The rival's bid survived - it was not clobbered by our write.
    expect(row.bids.map((b: any) => b.userId)).toEqual(['usr_bidder', 'usr_rival']);
  });

  it('returns BID_TOO_LOW with the updated price when the winning rival bid beats ours', async () => {
    let db: FakeSupabase;
    db = seed({}, {
      beforeUpdate: ({ table, attempt }) => {
        if (table !== 'auctions' || attempt !== 1) return;
        const row = db.rows('auctions')[0];
        row.current_price = 300;
        row.highest_bidder_id = 'usr_rival';
        row.bids = [{ id: 'bid_rival', auctionId: 'auc_1', userId: 'usr_rival', userName: 'Rival', amount: 300, timestamp: Date.now() }];
      },
    });

    const result = await placeBid({ amount: 250 }, 'tok_good');

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('BID_TOO_LOW');
    expect(result.body.error).toContain('300');
    expect(db.rows('auctions')[0].current_price).toBe(300);
  });

  it('gives up with 409 BID_CONFLICT after 3 failed attempts', async () => {
    let db: FakeSupabase;
    db = seed({}, {
      beforeUpdate: ({ table }) => {
        if (table !== 'auctions') return;
        // A rival commits a tiny raise before every one of our writes.
        const row = db.rows('auctions')[0];
        row.current_price = Number(row.current_price) + 1;
        row.bids = [
          { id: `bid_rival_${row.current_price}`, auctionId: 'auc_1', userId: 'usr_rival', userName: 'Rival', amount: row.current_price, timestamp: Date.now() },
        ];
      },
    });

    const result = await placeBid({ amount: 500 }, 'tok_good');

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('BID_CONFLICT');
    expect(result.body.error).toContain('Another bid landed at the same moment. Please try again.');
    expect(db.updateAttempts).toBe(3);
    expect(db.rows('auctions')[0].highest_bidder_id).not.toBe('usr_bidder');
  });
});

describe('POST /api/auctions/:id/bids - listing status guard', () => {
  beforeEach(() => {
    mocks.client = null;
  });

  it('rejects a bid on a cancelled listing', async () => {
    const db = seed({ status: 'cancelled' });

    const result = await placeBid({ amount: 500 }, 'tok_good');

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('AUCTION_ENDED');
    expect(db.rows('auctions')[0].bids).toHaveLength(0);
  });

  it('rejects a bid on an admin-hidden listing', async () => {
    const db = seed({ status: 'hidden' });

    const result = await placeBid({ amount: 500 }, 'tok_good');

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('AUCTION_ENDED');
    expect(db.rows('auctions')[0].bids).toHaveLength(0);
  });

  it('rejects a bid, rather than 500ing, when the listing is cancelled and its bid_version bumped between the read and the write', async () => {
    let db: FakeSupabase;
    db = seed({ bid_version: 0 }, {
      beforeUpdate: ({ table, attempt }) => {
        if (table !== 'auctions' || attempt !== 1) return;
        // Mirrors what DELETE /api/auctions/:id actually does: flips status AND
        // bumps bid_version in the same write, exactly so this in-flight bid
        // loses its lock instead of landing on a listing just withdrawn.
        const row = db.rows('auctions')[0];
        row.status = 'cancelled';
        row.bid_version = 1;
      },
    });

    const result = await placeBid({ amount: 500 }, 'tok_good');

    // The guarded UPDATE matches zero rows (bid_version and status both moved), so the loop
    // re-reads, sees the now-cancelled row, and answers a normal 400 - never a 500.
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('AUCTION_ENDED');
    expect(db.rows('auctions')[0].bids).toHaveLength(0);
    expect(db.updateFilters('auctions')[0]).toContainEqual({ op: 'eq', column: 'status', value: 'active' });
  });
});

/**
 * These exercise the guard that migration 004 introduces: `auctions.bid_version`,
 * a monotonic integer, in place of the old `.eq('current_price', ...)`.
 *
 * The seed rows here carry `bid_version`, standing for a database where 004 has
 * run. The rows in the suites above deliberately do NOT, standing for a Worker
 * deployed ahead of the migration - which is why those still assert the old
 * price predicate.
 *
 * The pence test below is the one that matters. It fails against the old float
 * guard, because `tests/unit/helpers/fake-supabase.ts` now models `eq` on a
 * money column as the PostgREST text round-trip rather than a JS `===`.
 */
describe('POST /api/auctions/:id/bids - bid_version guard', () => {
  beforeEach(() => {
    mocks.client = null;
  });

  it('accepts a pence bid, and another pence bid on top of it', async () => {
    const db = seed({ bid_version: 0 });

    // £150.10 - no exact binary representation. Under the old float guard the
    // SECOND of these cannot reliably match its own guard.
    const first = await placeBid({ amount: 150.1 }, 'tok_good');

    expect(first.status).toBe(200);
    expect(first.body.bid.amount).toBe(150.1);
    expect(db.rows('auctions')[0].current_price).toBe(150.1);
    expect(db.rows('auctions')[0].bid_version).toBe(1);

    const second = await placeBid({ amount: 150.2 }, 'tok_good');

    expect(second.status).toBe(200);
    expect(second.body.bid.amount).toBe(150.2);

    const row = db.rows('auctions')[0];
    expect(row.current_price).toBe(150.2);
    expect(row.bid_version).toBe(2);
    expect(row.bids.map((b: any) => b.amount)).toEqual([150.2, 150.1]);
    // Both landed first time. No retry, so no spurious BID_CONFLICT.
    expect(db.updateAttempts).toBe(2);
  });

  it('guards the update on bid_version and not on the money column', async () => {
    const db = seed({ bid_version: 7 });

    const result = await placeBid({ amount: 250 }, 'tok_good');

    expect(result.status).toBe(200);

    const filters = db.updateFilters('auctions')[0];
    expect(filters).toContainEqual({ op: 'eq', column: 'bid_version', value: 7 });
    expect(filters).not.toContainEqual({ op: 'eq', column: 'current_price', value: 100 });
    expect(db.rows('auctions')[0].bid_version).toBe(8);
  });

  it('rejects a stale writer: the second bidder retries and the first bid survives', async () => {
    let db: FakeSupabase;
    db = seed({ bid_version: 0 }, {
      beforeUpdate: ({ table, attempt }) => {
        if (table !== 'auctions' || attempt !== 1) return;
        // A rival's bid commits in the window between our read and our write,
        // so the version we read is already stale by the time we write.
        const row = db.rows('auctions')[0];
        row.current_price = 150.1;
        row.bid_version = 1;
        row.highest_bidder_id = 'usr_rival';
        row.highest_bidder_name = 'Rival';
        row.bids = [
          { id: 'bid_rival', auctionId: 'auc_1', userId: 'usr_rival', userName: 'Rival', amount: 150.1, timestamp: Date.now() },
        ];
      },
    });

    const result = await placeBid({ amount: 250 }, 'tok_good');

    expect(result.status).toBe(200);
    expect(db.updateAttempts).toBe(2);

    // First write guarded on the pre-bid version and matched nothing; the retry
    // re-read and guarded on the version the rival left behind.
    expect(db.updateFilters('auctions')[0]).toContainEqual({ op: 'eq', column: 'bid_version', value: 0 });
    expect(db.updateFilters('auctions')[1]).toContainEqual({ op: 'eq', column: 'bid_version', value: 1 });

    const row = db.rows('auctions')[0];
    expect(row.current_price).toBe(250);
    expect(row.highest_bidder_id).toBe('usr_bidder');
    expect(row.bid_version).toBe(2);
    // The rival's entry was not clobbered by a write that never saw it.
    expect(row.bids.map((b: any) => b.userId)).toEqual(['usr_bidder', 'usr_rival']);
    expect(row.bids.map((b: any) => b.amount)).toEqual([250, 150.1]);
  });

  it('uses the version guard for a first bid on a null current_price', async () => {
    const db = seed({ current_price: null, bid_version: 0 });

    const result = await placeBid({ amount: 250 }, 'tok_good');

    expect(result.status).toBe(200);
    expect(db.updateFilters('auctions')[0]).toContainEqual({ op: 'eq', column: 'bid_version', value: 0 });
    expect(db.rows('auctions')[0].current_price).toBe(250);
    expect(db.rows('auctions')[0].bid_version).toBe(1);
  });

  it('falls back to the price guard, and writes no bid_version, before migration 004', async () => {
    // No `bid_version` on the row at all - the column does not exist yet.
    const db = seed();

    const result = await placeBid({ amount: 250 }, 'tok_good');

    expect(result.status).toBe(200);

    const filters = db.updateFilters('auctions')[0];
    expect(filters).toContainEqual({ op: 'eq', column: 'current_price', value: 100 });
    expect(filters.some((f) => f.column === 'bid_version')).toBe(false);

    // Naming a column PostgREST does not know about would fail the whole UPDATE
    // with PGRST204, so the payload must not carry one.
    const update = db.operations.find((o) => o.table === 'auctions' && o.op === 'update');
    expect(update?.payload).not.toHaveProperty('bid_version');
    expect(db.rows('auctions')[0]).not.toHaveProperty('bid_version');
  });
});

/**
 * Migration 004 changes the WIRE FORMAT as well as the storage. PostgREST
 * serialises a Postgres `numeric` as a JSON string ("400.00"), because a JSON
 * number cannot carry arbitrary precision. Every money field the API returns
 * has to survive that.
 */
describe('numeric money columns arrive as strings after migration 004', () => {
  beforeEach(() => {
    mocks.client = null;
  });

  it('returns numbers for every money field when the row holds numeric strings', async () => {
    const now = Date.now();
    seed({
      seller_id: BIDDER.id,
      seller_name: BIDDER.name,
      status: 'ended',
      end_time: now - 1000,
      starting_price: '100.00',
      current_price: '400.50',
      winning_bid: '400.50',
      winner_id: 'usr_rival',
      winner_name: 'Rival',
      bid_version: 3,
      bids: [{ id: 'bid_1', auctionId: 'auc_1', userId: 'usr_rival', userName: 'Rival', amount: 400.5, timestamp: now - 2000 }],
    });

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/users/me/activity', { headers: { authorization: 'Bearer tok_good' } }),
      ENV,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    const listing = body.listings[0];

    expect(listing.startingPrice).toBe(100);
    expect(listing.currentPrice).toBe(400.5);
    // This one regressed without a coercion: it used to pass the raw value
    // through, which was a number only because the column was float8.
    expect(listing.winningBid).toBe(400.5);
    expect(typeof listing.winningBid).toBe('number');
  });

  it('keeps a null winning_bid as null rather than coercing it to 0', async () => {
    seed({ seller_id: BIDDER.id, seller_name: BIDDER.name, winning_bid: null });

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/users/me/activity', { headers: { authorization: 'Bearer tok_good' } }),
      ENV,
    );

    const body = await response.json() as any;
    expect(body.listings[0].winningBid).toBeNull();
  });

  it('accepts a bid against a row whose current_price is a numeric string', async () => {
    const db = seed({ current_price: '150.10', bid_version: 0 });

    const result = await placeBid({ amount: 150.2 }, 'tok_good');

    expect(result.status).toBe(200);
    expect(db.rows('auctions')[0].current_price).toBe(150.2);
    expect(db.rows('auctions')[0].bid_version).toBe(1);
  });
});

describe('fake-supabase money eq round-trip', () => {
  beforeEach(() => {
    mocks.client = null;
  });

  it('fails an eq on a money value with no exact binary representation', async () => {
    const db = createFakeSupabase({ auctions: [{ id: 'auc_1', current_price: 150.1 }] });

    // Same JS number, read straight off the row - a JS `===` would match. The
    // text round-trip does not, which is the whole point.
    const { data } = await db.from('auctions').select('*').eq('current_price', 150.1);

    expect(data).toEqual([]);
  });

  it('still matches an eq on an exactly representable money value', async () => {
    const db = createFakeSupabase({ auctions: [{ id: 'auc_1', current_price: 150.5 }] });

    const { data } = await db.from('auctions').select('*').eq('current_price', 150.5);

    expect(data).toHaveLength(1);
  });

  it('leaves eq on a non-money column alone', async () => {
    const db = createFakeSupabase({ auctions: [{ id: 'auc_1', end_time: 150.1 }] });

    const { data } = await db.from('auctions').select('*').eq('end_time', 150.1);

    expect(data).toHaveLength(1);
  });
});

describe('authenticated read endpoints', () => {
  beforeEach(() => {
    mocks.client = null;
  });

  it('rejects GET /api/users/me/activity without a Bearer token', async () => {
    seed();

    const response = await worker.fetch(new Request('https://msa-auction.test/api/users/me/activity'), ENV);

    expect(response.status).toBe(401);
    expect((await response.json() as any).code).toBe('UNAUTHORIZED');
  });

  it('rejects GET /api/notifications with an unknown token as SESSION_EXPIRED', async () => {
    seed();

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/notifications', { headers: { authorization: 'Bearer tok_stale' } }),
      ENV,
    );

    expect(response.status).toBe(401);
    expect((await response.json() as any).code).toBe('SESSION_EXPIRED');
  });

  it('never selects an image column for /api/users/me/activity or /api/notifications', async () => {
    const db = seed();

    await worker.fetch(
      new Request('https://msa-auction.test/api/users/me/activity', { headers: { authorization: 'Bearer tok_good' } }),
      ENV,
    );
    await worker.fetch(
      new Request('https://msa-auction.test/api/notifications', { headers: { authorization: 'Bearer tok_good' } }),
      ENV,
    );

    for (const columns of db.selectColumns('auctions')) {
      expect(columns).not.toContain('image_urls');
      expect(columns).not.toContain('image_url,');
    }
  });

  it('reports imageCount instead of image data on /api/users/me/activity', async () => {
    const db = seed({ image_count: 1 });
    db.rows('auctions')[0].seller_id = BIDDER.id;

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/users/me/activity', { headers: { authorization: 'Bearer tok_good' } }),
      ENV,
    );
    const body = await response.json() as any;

    expect(body.listings[0].imageCount).toBe(1);
    expect(body.listings[0]).not.toHaveProperty('imageUrls');
    expect(body.listings[0]).not.toHaveProperty('imageUrl');
  });

  it('returns listings, bids, and wins in the camelCase auction shape', async () => {
    const now = Date.now();
    const db = seed();
    db.rows('auctions').push({
      ...auctionRow(),
      id: 'auc_mine',
      seller_id: BIDDER.id,
      seller_name: BIDDER.name,
      created_at: now,
    });
    db.rows('auctions')[0].bids = [
      { id: 'bid_1', auctionId: 'auc_1', userId: BIDDER.id, userName: BIDDER.name, amount: 150, timestamp: now },
    ];

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/users/me/activity', {
        headers: { authorization: 'Bearer tok_good' },
      }),
      ENV,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.listings.map((a: any) => a.id)).toEqual(['auc_mine']);
    expect(body.bids.map((a: any) => a.id)).toEqual(['auc_1']);
    expect(body.wins).toEqual([]);
    expect(body.listings[0]).toMatchObject({ sellerId: BIDDER.id, startingPrice: 100, phoneNumber: '0100000000' });
  });

  it('derives an outbid notification with a stable id', async () => {
    const now = Date.now();
    const db = seed({
      current_price: 300,
      highest_bidder_id: 'usr_rival',
      highest_bidder_name: 'Rival',
      bids: [
        { id: 'bid_2', auctionId: 'auc_1', userId: 'usr_rival', userName: 'Rival', amount: 300, timestamp: now },
        { id: 'bid_1', auctionId: 'auc_1', userId: BIDDER.id, userName: BIDDER.name, amount: 150, timestamp: now - 5000 },
      ],
    });

    const response = await worker.fetch(
      new Request('https://msa-auction.test/api/notifications', { headers: { authorization: 'Bearer tok_good' } }),
      ENV,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      id: `outbid_auc_1_${now}`,
      type: 'outbid',
      auctionId: 'auc_1',
      auctionTitle: 'Vintage lamp',
      amount: 300,
      timestamp: now,
    });
    expect(db.rows('auctions')[0].status).toBe('active');
  });
});

describe('scheduled settle', () => {
  beforeEach(() => {
    mocks.client = null;
  });

  it('settles ended auctions on the cron trigger', async () => {
    const now = Date.now();
    const db = seed({
      end_time: now - 1000,
      current_price: 400,
      highest_bidder_id: 'usr_rival',
      highest_bidder_name: 'Rival',
      bids: [{ id: 'bid_1', auctionId: 'auc_1', userId: 'usr_rival', userName: 'Rival', amount: 400, timestamp: now - 2000 }],
    });

    await worker.scheduled({ cron: '* * * * *' }, ENV, { waitUntil: () => {} });

    expect(db.rows('auctions')[0]).toMatchObject({
      status: 'ended',
      winner_id: 'usr_rival',
      winner_name: 'Rival',
      winning_bid: 400,
    });
  });

  it('does NOT lazily settle on GET /api/auctions any more - that ride-along was the list route\'s single biggest source of load', async () => {
    const now = Date.now();
    const db = seed({
      end_time: now - 1000,
      current_price: 400,
      bids: [{ id: 'bid_1', auctionId: 'auc_1', userId: 'usr_rival', userName: 'Rival', amount: 400, timestamp: now - 2000 }],
    });

    const response = await worker.fetch(new Request('https://msa-auction.test/api/auctions'), ENV);
    const body = await response.json() as any;

    // The row is left exactly as the cron will find it - still 'active' past its end_time.
    expect(db.rows('auctions')[0].status).toBe('active');
    // The list still reports it correctly for display purposes: the client derives "ended" from
    // end_time itself (see AuctionCard/AuctionDetailModal's own countdown), so a stale `status`
    // field here is not user-visible.
    expect(body.auctions[0].status).toBe('active');
  });

  it('settles a past-end_time auction lazily on GET /api/auctions/:id (kept on the detail route)', async () => {
    const now = Date.now();
    const db = seed({
      end_time: now - 1000,
      current_price: 400,
      bids: [{ id: 'bid_1', auctionId: 'auc_1', userId: 'usr_rival', userName: 'Rival', amount: 400, timestamp: now - 2000 }],
    });

    const response = await worker.fetch(new Request('https://msa-auction.test/api/auctions/auc_1'), ENV);
    const body = await response.json() as any;

    expect(db.rows('auctions')[0].status).toBe('ended');
    expect(body.auction).toMatchObject({ status: 'ended', winnerId: 'usr_rival', winningBid: 400 });
  });

  it('settles a past-end_time auction lazily on POST /api/auctions/:id/bids (kept on the bid route), rejecting the bid as ended', async () => {
    const now = Date.now();
    const db = seed({
      end_time: now - 1000,
      current_price: 400,
      bids: [{ id: 'bid_1', auctionId: 'auc_1', userId: 'usr_rival', userName: 'Rival', amount: 400, timestamp: now - 2000 }],
    });

    const result = await placeBid({ amount: 500 }, 'tok_good');

    expect(db.rows('auctions')[0].status).toBe('ended');
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('AUCTION_ENDED');
  });
});
