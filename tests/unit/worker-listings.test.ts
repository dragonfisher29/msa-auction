// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeSupabase, FakeSupabase } from './helpers/fake-supabase';

// The Worker builds its Supabase client at request time, so the client the
// tests inspect has to come back from createClient().
const mocks = vi.hoisted(() => ({ client: null as any }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mocks.client,
}));

import worker from '../../workers/index';

const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'test-secret' };

const SELLER = { id: 'usr_seller', name: 'Seller', username: 'seller', token: 'tok_seller' };
const OTHER = { id: 'usr_other', name: 'Other', username: 'other', token: 'tok_other' };

const NOW = Date.now();
const FUTURE = NOW + 3_600_000;

function auctionRow(overrides: Record<string, any> = {}) {
  return {
    id: 'auc_1',
    title: 'Vintage lamp',
    description: 'A lamp',
    phone_number: '0100000000',
    starting_price: 100,
    current_price: 100,
    seller_id: SELLER.id,
    seller_name: SELLER.name,
    highest_bidder_id: null,
    highest_bidder_name: null,
    duration_minutes: 60,
    start_time: NOW - 1000,
    end_time: FUTURE,
    status: 'active',
    category: 'General',
    image_url: 'data:image/png;base64,aaa',
    image_urls: ['data:image/png;base64,aaa', 'data:image/png;base64,bbb'],
    image_count: 2,
    bids: [],
    winner_id: null,
    winner_name: null,
    winning_bid: null,
    created_at: NOW - 1000,
    ...overrides,
  };
}

function bid(overrides: Record<string, any> = {}) {
  return {
    id: 'bid_1',
    auctionId: 'auc_1',
    userId: OTHER.id,
    userName: OTHER.name,
    amount: 150,
    timestamp: NOW,
    ...overrides,
  };
}

function seed(auctions: Record<string, any>[]): FakeSupabase {
  const db = createFakeSupabase({ users: [SELLER, OTHER], auctions });
  mocks.client = db;
  return db;
}

async function call(method: string, path: string, options: { token?: string; body?: any; env?: any } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  const response = await worker.fetch(
    new Request(`https://msa-auction.test${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    options.env ?? ENV,
  );

  return response;
}

async function callJson(method: string, path: string, options: { token?: string; body?: any } = {}) {
  const response = await call(method, path, options);
  return { status: response.status, body: (await response.json()) as any };
}

const VALID_EDIT = { title: 'Nicer lamp', startingPrice: 250 };

beforeEach(() => {
  mocks.client = null;
});

/* ========================================================================== */
/* 1. Edit / cancel / delete a listing                                        */
/* ========================================================================== */

describe('PATCH /api/auctions/:id', () => {
  it('rejects the edit once the listing has bids', async () => {
    const db = seed([auctionRow({ bids: [bid()], current_price: 150, highest_bidder_id: OTHER.id })]);

    const result = await callJson('PATCH', '/api/auctions/auc_1', { token: SELLER.token, body: VALID_EDIT });

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('LISTING_HAS_BIDS');
    expect(result.body.error).toContain(
      'This listing already has bids and can no longer be edited. You can cancel it instead.',
    );

    const row = db.rows('auctions')[0];
    expect(row.title).toBe('Vintage lamp');
    expect(row.starting_price).toBe(100);
  });

  it('rejects the edit when the caller is not the seller', async () => {
    const db = seed([auctionRow()]);

    const result = await callJson('PATCH', '/api/auctions/auc_1', { token: OTHER.token, body: VALID_EDIT });

    expect(result.status).toBe(403);
    expect(result.body.code).toBe('NOT_LISTING_OWNER');
    expect(db.rows('auctions')[0].title).toBe('Vintage lamp');
  });

  it('requires authentication', async () => {
    seed([auctionRow()]);

    const result = await callJson('PATCH', '/api/auctions/auc_1', { body: VALID_EDIT });

    expect(result.status).toBe(401);
    expect(result.body.code).toBe('UNAUTHORIZED');
  });

  it('updates the editable fields and moves current_price with startingPrice', async () => {
    const db = seed([auctionRow()]);

    const result = await callJson('PATCH', '/api/auctions/auc_1', {
      token: SELLER.token,
      body: { title: 'Nicer lamp', description: 'Much nicer', category: 'Home', startingPrice: 250 },
    });

    expect(result.status).toBe(200);
    expect(result.body.auction).toMatchObject({
      title: 'Nicer lamp',
      description: 'Much nicer',
      category: 'Home',
      startingPrice: 250,
      currentPrice: 250,
    });

    const row = db.rows('auctions')[0];
    expect(row.starting_price).toBe(250);
    expect(row.current_price).toBe(250);
    // Untouched fields survive the partial patch.
    expect(row.phone_number).toBe('0100000000');
    expect(row.end_time).toBe(FUTURE);
    expect(row.duration_minutes).toBe(60);
    expect(row.image_urls).toHaveLength(2);
  });

  it('refuses to edit an ended or cancelled listing', async () => {
    for (const status of ['ended', 'cancelled']) {
      seed([auctionRow({ status, end_time: FUTURE })]);

      const result = await callJson('PATCH', '/api/auctions/auc_1', { token: SELLER.token, body: VALID_EDIT });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe('LISTING_NOT_EDITABLE');
    }
  });

  it('reuses validateAuctionInput rather than a second validator', async () => {
    seed([auctionRow()]);
    const badPrice = await callJson('PATCH', '/api/auctions/auc_1', {
      token: SELLER.token,
      body: { startingPrice: 0 },
    });
    expect(badPrice.status).toBe(400);
    expect(badPrice.body.code).toBe('INVALID_PRICE');

    seed([auctionRow()]);
    const noTitle = await callJson('PATCH', '/api/auctions/auc_1', { token: SELLER.token, body: { title: '   ' } });
    expect(noTitle.status).toBe(400);
    expect(noTitle.body.code).toBe('MISSING_FIELDS');

    seed([auctionRow()]);
    const tooManyImages = await callJson('PATCH', '/api/auctions/auc_1', {
      token: SELLER.token,
      body: { imageUrls: ['a', 'b', 'c', 'd'] },
    });
    expect(tooManyImages.status).toBe(400);
    expect(tooManyImages.body.code).toBe('TOO_MANY_IMAGES');
  });

  it('guards the write on highest_bidder_id so a bid landing mid-edit wins', async () => {
    const db = seed([auctionRow()]);

    await callJson('PATCH', '/api/auctions/auc_1', { token: SELLER.token, body: VALID_EDIT });

    expect(db.updateFilters('auctions')[0]).toContainEqual({ op: 'is', column: 'highest_bidder_id', value: null });
    expect(db.updateFilters('auctions')[0]).toContainEqual({ op: 'eq', column: 'status', value: 'active' });
  });

  it('returns 404 for an unknown listing', async () => {
    seed([auctionRow()]);

    const result = await callJson('PATCH', '/api/auctions/auc_missing', { token: SELLER.token, body: VALID_EDIT });

    expect(result.status).toBe(404);
    expect(result.body.code).toBe('AUCTION_NOT_FOUND');
  });
});

describe('DELETE /api/auctions/:id', () => {
  it('soft-cancels the listing and drops it from the default list, but keeps it fetchable by id', async () => {
    const db = seed([auctionRow(), auctionRow({ id: 'auc_2', end_time: FUTURE - 1000 })]);

    const deleted = await callJson('DELETE', '/api/auctions/auc_1', { token: SELLER.token });

    expect(deleted.status).toBe(200);
    expect(deleted.body.success).toBe(true);
    expect(deleted.body.auction.status).toBe('cancelled');

    // Soft delete: the row is still there, with its bid history.
    const row = db.rows('auctions').find((entry: any) => entry.id === 'auc_1');
    expect(row).toBeDefined();
    expect(row.status).toBe('cancelled');
    expect(db.rows('auctions')).toHaveLength(2);

    const list = await callJson('GET', '/api/auctions');
    expect(list.status).toBe(200);
    expect(list.body.auctions.map((auction: any) => auction.id)).toEqual(['auc_2']);

    const byId = await callJson('GET', '/api/auctions/auc_1');
    expect(byId.status).toBe(200);
    expect(byId.body.auction).toMatchObject({ id: 'auc_1', status: 'cancelled' });
  });

  it('allows cancelling a listing that already has bids and preserves the bid history', async () => {
    const db = seed([auctionRow({ bids: [bid()], current_price: 150, highest_bidder_id: OTHER.id })]);

    const result = await callJson('DELETE', '/api/auctions/auc_1', { token: SELLER.token });

    expect(result.status).toBe(200);
    expect(result.body.hadBids).toBe(true);
    expect(result.body.bidsPreserved).toBe(true);
    expect(result.body.message).toContain('everyone who bid can still open it');

    const row = db.rows('auctions')[0];
    expect(row.status).toBe('cancelled');
    expect(row.bids).toHaveLength(1);
    expect(row.bids[0].userId).toBe(OTHER.id);
  });

  it('rejects a cancel from someone other than the seller', async () => {
    const db = seed([auctionRow()]);

    const result = await callJson('DELETE', '/api/auctions/auc_1', { token: OTHER.token });

    expect(result.status).toBe(403);
    expect(result.body.code).toBe('NOT_LISTING_OWNER');
    expect(db.rows('auctions')[0].status).toBe('active');
  });

  it('refuses to cancel a listing that has already ended', async () => {
    const db = seed([auctionRow({ status: 'ended' })]);

    const result = await callJson('DELETE', '/api/auctions/auc_1', { token: SELLER.token });

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('LISTING_NOT_EDITABLE');
    expect(db.rows('auctions')[0].status).toBe('ended');
  });

  it('requires authentication', async () => {
    const db = seed([auctionRow()]);

    const result = await callJson('DELETE', '/api/auctions/auc_1');

    expect(result.status).toBe(401);
    expect(result.body.code).toBe('UNAUTHORIZED');
    expect(db.rows('auctions')[0].status).toBe('active');
  });
});

describe('settlement ignores cancelled listings', () => {
  it('never settles or assigns a winner to a cancelled auction whose end_time has passed', async () => {
    const db = seed([
      auctionRow({
        status: 'cancelled',
        end_time: NOW - 5000,
        current_price: 400,
        highest_bidder_id: OTHER.id,
        highest_bidder_name: OTHER.name,
        bids: [bid({ amount: 400 })],
      }),
    ]);

    await worker.scheduled({ cron: '* * * * *' }, ENV, { waitUntil: () => {} });
    await callJson('GET', '/api/auctions');
    await callJson('GET', '/api/auctions/auc_1');

    const row = db.rows('auctions')[0];
    expect(row.status).toBe('cancelled');
    expect(row.winner_id).toBeNull();
    expect(row.winner_name).toBeNull();
    expect(row.winning_bid).toBeNull();
  });
});

/* ========================================================================== */
/* 2. The listing cap counts active listings only                             */
/* ========================================================================== */

describe('POST /api/auctions - listing cap', () => {
  const NEW_LISTING = {
    title: 'Desk lamp',
    description: 'Still works',
    phoneNumber: '0100000001',
    startingPrice: 50,
    durationMinutes: 120,
    imageUrls: ['data:image/png;base64,ccc'],
  };

  function sellerRows(count: number, status: string, idPrefix: string) {
    return Array.from({ length: count }, (_, index) =>
      auctionRow({ id: `${idPrefix}${index}`, status, end_time: FUTURE + index }),
    );
  }

  it('lets a seller with 25 ended listings and 0 active ones create a new listing', async () => {
    const db = seed(sellerRows(25, 'ended', 'auc_done_'));

    const result = await callJson('POST', '/api/auctions', { token: SELLER.token, body: NEW_LISTING });

    expect(result.status).toBe(201);
    expect(result.body.auction).toMatchObject({ title: 'Desk lamp', sellerId: SELLER.id, status: 'active' });
    expect(db.rows('auctions')).toHaveLength(26);
  });

  it('does not count cancelled listings towards the cap either', async () => {
    seed([...sellerRows(20, 'cancelled', 'auc_gone_'), ...sellerRows(19, 'active', 'auc_live_')]);

    const result = await callJson('POST', '/api/auctions', { token: SELLER.token, body: NEW_LISTING });

    expect(result.status).toBe(201);
  });

  it('still blocks a seller who is at the cap on ACTIVE listings, and says so', async () => {
    const db = seed(sellerRows(20, 'active', 'auc_live_'));

    const result = await callJson('POST', '/api/auctions', { token: SELLER.token, body: NEW_LISTING });

    expect(result.status).toBe(429);
    expect(result.body.code).toBe('LISTING_LIMIT_REACHED');
    expect(result.body.error).toContain('20 active listings');
    expect(db.rows('auctions')).toHaveLength(20);
  });

  it('counts only the calling seller, filtered on status=active', async () => {
    const db = seed(sellerRows(3, 'active', 'auc_live_'));

    await callJson('POST', '/api/auctions', { token: SELLER.token, body: NEW_LISTING });

    const countFilters = db.operations.find(
      (operation) =>
        operation.op === 'select' &&
        operation.table === 'auctions' &&
        operation.filters.some((filter) => filter.column === 'seller_id'),
    );

    expect(countFilters?.filters).toContainEqual({ op: 'eq', column: 'seller_id', value: SELLER.id });
    expect(countFilters?.filters).toContainEqual({ op: 'eq', column: 'status', value: 'active' });
  });
});

/* ========================================================================== */
/* 3. Slim list payload + keyset pagination                                    */
/* ========================================================================== */

describe('GET /api/auctions - slim payload', () => {
  it('omits image payloads, reports imageCount, and never selects image columns', async () => {
    const db = seed([auctionRow()]);

    const result = await callJson('GET', '/api/auctions');

    expect(result.status).toBe(200);
    const auction = result.body.auctions[0];
    expect(auction.imageCount).toBe(2);
    expect(auction).not.toHaveProperty('imageUrls');
    expect(auction).not.toHaveProperty('imageUrl');
    expect(JSON.stringify(result.body)).not.toContain('base64');

    const listColumns = db.selectColumns('auctions').find((columns) => columns?.includes('image_count'));
    expect(listColumns).toBeDefined();
    expect(listColumns).not.toContain('image_urls');
    expect(listColumns).not.toContain('image_url,');
  });

  it('falls back to counting image_urls when image_count is absent', async () => {
    seed([auctionRow({ image_count: undefined })]);

    const result = await callJson('GET', '/api/auctions');

    expect(result.body.auctions[0].imageCount).toBe(2);
  });

  it('keeps the fields the cards actually render', async () => {
    seed([auctionRow({ bids: [bid()], current_price: 150, highest_bidder_id: OTHER.id, highest_bidder_name: OTHER.name })]);

    const auction = (await callJson('GET', '/api/auctions')).body.auctions[0];

    expect(auction).toMatchObject({
      id: 'auc_1',
      title: 'Vintage lamp',
      status: 'active',
      currentPrice: 150,
      startingPrice: 100,
      sellerId: SELLER.id,
      sellerName: SELLER.name,
      highestBidderId: OTHER.id,
      category: 'General',
      endTime: FUTURE,
    });
    expect(auction.bids).toHaveLength(1);
  });
});

describe('GET /api/auctions - keyset pagination', () => {
  function page(size: number) {
    return Array.from({ length: size }, (_, index) =>
      auctionRow({ id: `auc_${String(index).padStart(3, '0')}`, end_time: FUTURE + index }),
    );
  }

  it('defaults to 24 per page and hands back a cursor', async () => {
    seed(page(30));

    const result = await callJson('GET', '/api/auctions');

    expect(result.status).toBe(200);
    expect(result.body.auctions).toHaveLength(24);
    expect(typeof result.body.nextCursor).toBe('string');
    expect(result.body.nextCursor).not.toBe('');
  });

  it('walks the whole set with the cursor, with no gaps and no repeats', async () => {
    seed(page(30));

    const first = await callJson('GET', '/api/auctions?limit=12');
    expect(first.body.auctions).toHaveLength(12);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await callJson('GET', `/api/auctions?limit=12&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.auctions).toHaveLength(12);
    expect(second.body.nextCursor).toBeTruthy();

    const third = await callJson('GET', `/api/auctions?limit=12&cursor=${encodeURIComponent(second.body.nextCursor)}`);
    expect(third.body.auctions).toHaveLength(6);
    // Last page: nothing left to page to.
    expect(third.body.nextCursor).toBeNull();

    const seen = [...first.body.auctions, ...second.body.auctions, ...third.body.auctions].map((a: any) => a.id);
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });

  it('orders by end_time desc so ended listings sort behind live ones', async () => {
    seed([
      auctionRow({ id: 'auc_soon', end_time: NOW + 1000 }),
      auctionRow({ id: 'auc_later', end_time: NOW + 9_000_000 }),
      auctionRow({ id: 'auc_mid', end_time: NOW + 5_000_000 }),
    ]);

    const result = await callJson('GET', '/api/auctions');

    expect(result.body.auctions.map((auction: any) => auction.id)).toEqual(['auc_later', 'auc_mid', 'auc_soon']);
  });

  it('clamps limit to 60 and ignores junk values', async () => {
    seed(page(70));

    const clamped = await callJson('GET', '/api/auctions?limit=500');
    expect(clamped.body.auctions).toHaveLength(60);

    const junk = await callJson('GET', '/api/auctions?limit=abc');
    expect(junk.body.auctions).toHaveLength(24);
  });

  it('excludes cancelled listings from every page', async () => {
    seed([
      auctionRow({ id: 'auc_a', end_time: FUTURE + 3 }),
      auctionRow({ id: 'auc_b', end_time: FUTURE + 2, status: 'cancelled' }),
      auctionRow({ id: 'auc_c', end_time: FUTURE + 1 }),
    ]);

    const result = await callJson('GET', '/api/auctions?limit=1');
    const next = await callJson('GET', `/api/auctions?limit=1&cursor=${encodeURIComponent(result.body.nextCursor)}`);

    expect(result.body.auctions.map((a: any) => a.id)).toEqual(['auc_a']);
    expect(next.body.auctions.map((a: any) => a.id)).toEqual(['auc_c']);
    expect(next.body.nextCursor).toBeNull();
  });

  it('rejects a tampered cursor instead of silently returning page one', async () => {
    seed(page(5));

    const result = await callJson('GET', '/api/auctions?cursor=not-a-real-cursor');

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_CURSOR');
  });
});

describe('GET /api/auctions/:id/images', () => {
  it('returns the images with a public cache header and no auth', async () => {
    seed([auctionRow()]);

    const response = await call('GET', '/api/auctions/auc_1/images');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(await response.json()).toEqual({
      imageUrls: ['data:image/png;base64,aaa', 'data:image/png;base64,bbb'],
    });
  });

  it('404s for an unknown listing', async () => {
    seed([auctionRow()]);

    const result = await callJson('GET', '/api/auctions/auc_nope/images');

    expect(result.status).toBe(404);
    expect(result.body.code).toBe('AUCTION_NOT_FOUND');
  });
});

describe('GET /api/auctions/:id', () => {
  it('still returns the full object including imageUrls', async () => {
    seed([auctionRow()]);

    const result = await callJson('GET', '/api/auctions/auc_1');

    expect(result.status).toBe(200);
    expect(result.body.auction.imageUrls).toEqual(['data:image/png;base64,aaa', 'data:image/png;base64,bbb']);
    expect(result.body.auction.imageUrl).toBe('data:image/png;base64,aaa');
  });
});

/* ========================================================================== */
/* 4. Per-auction Open Graph tags                                              */
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
      auctionRow({
        title: 'Genuine "Vintage" <script>alert(1)</script> lamp',
        description: 'Hand-made & "signed" <b>rare</b>',
        current_price: 250,
      }),
    ]);

    const { response, html } = await fetchShare('/auction/auc_1', assetsEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    // The dangerous characters are gone...
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('"Vintage"');
    // ...and present only in escaped form.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;Vintage&quot;');
    expect(html).toContain('&amp;');

    // The attribute the title lands in is not broken out of: exactly one
    // og:title meta, and it is still a well-formed quoted attribute.
    const ogTitle = html.match(/<meta property="og:title" content="([^"]*)"/);
    expect(ogTitle).not.toBeNull();
    expect(ogTitle![1]).toContain('&lt;script&gt;');
    expect(html.match(/property="og:title"/g)).toHaveLength(1);

    // The app's own module script is untouched.
    expect(html).toContain('<script type="module" src="/src/main.tsx">');
  });

  it('replaces the static shell tags rather than duplicating them', async () => {
    seed([auctionRow({ title: 'Vintage lamp', current_price: 250 })]);

    const { html } = await fetchShare('/auction/auc_1', assetsEnv());

    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('<title>Vintage lamp - £250 | MSA Auction</title>');
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html.match(/name="twitter:card"/g)).toHaveLength(1);
    // This row's images are still legacy base64, which no crawler can fetch, so
    // the preview falls back to the site logo as an ABSOLUTE url - never the
    // data URL, and never nothing. Exactly one og:image survives.
    expect(html.match(/property="og:image"/g)).toHaveLength(1);
    expect(html).toContain('<meta property="og:image" content="https://msa-auction.test/MSA_Logo.png" />');
    expect(html).toContain('<meta property="og:url" content="https://msa-auction.test/auction/auc_1" />');
    expect(html).not.toContain('Real-time online auction platform.');
  });

  it('serves the unmodified shell when the auction does not exist', async () => {
    seed([auctionRow()]);

    const { response, html } = await fetchShare('/auction/auc_missing', assetsEnv());

    expect(response.status).toBe(200);
    expect(html).toBe(SHELL);
  });

  it('falls back to the plain shell when the lookup throws', async () => {
    const db = createFakeSupabase(
      { users: [SELLER], auctions: [auctionRow()] },
      {
        errorOn: ({ table }) => (table === 'auctions' ? { message: 'connection reset', code: 'PGRST000' } : null),
      },
    );
    mocks.client = db;

    const { response, html } = await fetchShare('/auction/auc_1', assetsEnv());

    expect(response.status).toBe(200);
    expect(html).toBe(SHELL);
  });

  it('leaves non-HTML assets alone', async () => {
    seed([auctionRow()]);

    const env = assetsEnv({
      fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    });

    const { html } = await fetchShare('/auction/auc_1', env);

    expect(html).toBe('{}');
  });

  it('does not intercept other SPA routes', async () => {
    seed([auctionRow()]);

    const { html } = await fetchShare('/about', assetsEnv());

    expect(html).toBe(SHELL);
  });
});
