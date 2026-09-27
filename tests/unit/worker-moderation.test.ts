// @vitest-environment node
/**
 * Reporting, takedowns, bans and the admin role.
 *
 * The load-bearing claims here are negative ones: a non-admin cannot reach an
 * admin route by any path, a banned account cannot act anywhere, and a hidden
 * listing cannot be settled. Those are tested route by route rather than
 * through the helpers, because a role check that exists but is not wired into a
 * route is worth nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeSupabase, FakeSupabase } from './helpers/fake-supabase';

const mocks = vi.hoisted(() => ({ client: null as any }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mocks.client,
}));

import worker from '../../workers/index';
import { REPORT_REASONS, RESET_TOKEN_TTL_MS, sha256Hex } from '../../workers/shared';

const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'test-secret' };

const NOW = Date.now();
const FUTURE = NOW + 3_600_000;

const ADMIN = {
  id: 'usr_admin',
  name: 'Committee',
  username: 'committee',
  token: 'tok_admin',
  role: 'admin',
  banned_at: null,
  banned_reason: null,
  created_at: NOW,
};

const SELLER = {
  id: 'usr_seller',
  name: 'Seller',
  username: 'seller',
  token: 'tok_seller',
  role: 'member',
  banned_at: null,
  banned_reason: null,
  created_at: NOW,
};

const MEMBER = {
  id: 'usr_member',
  name: 'Member',
  username: 'member',
  token: 'tok_member',
  role: 'member',
  banned_at: null,
  banned_reason: null,
  created_at: NOW,
};

const BANNED = {
  id: 'usr_banned',
  name: 'Banned',
  username: 'banned',
  token: 'tok_banned',
  role: 'member',
  banned_at: NOW - 1000,
  banned_reason: 'Repeated scam listings',
  created_at: NOW,
};

function auctionRow(overrides: Record<string, any> = {}) {
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
    image_urls: ['data:image/png;base64,aaa'],
    image_count: 1,
    created_at: NOW - 1000,
    expires_at: FUTURE,
    sold_at: null,
    ...overrides,
  };
}

function seed(
  options: { users?: Record<string, any>[]; auctions?: Record<string, any>[]; reports?: Record<string, any>[] } = {},
): FakeSupabase {
  const db = createFakeSupabase({
    users: options.users ?? [ADMIN, SELLER, MEMBER, BANNED],
    auctions: options.auctions ?? [auctionRow()],
    reports: options.reports ?? [],
  });
  mocks.client = db;
  return db;
}

async function callJson(method: string, path: string, options: { token?: string; body?: any } = {}) {
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
    ENV,
  );

  return { status: response.status, body: (await response.json()) as any };
}

/** Every /api/admin/* route, so a new one cannot quietly skip the role check. */
const ADMIN_ROUTES: { method: string; path: string; body?: any }[] = [
  { method: 'GET', path: '/api/admin/reports' },
  { method: 'GET', path: '/api/admin/reset-requests' },
  { method: 'POST', path: '/api/admin/auctions/auc_1/hide', body: { reason: 'Scam' } },
  { method: 'POST', path: '/api/admin/users/usr_member/ban', body: { reason: 'Spam' } },
  { method: 'POST', path: '/api/admin/users/usr_member/unban', body: {} },
];

beforeEach(() => {
  mocks.client = null;
});

/* ========================================================================== */
/* 1. The admin role                                                          */
/* ========================================================================== */

describe('/api/admin/* access control', () => {
  it('refuses an anonymous caller on every admin route', async () => {
    for (const route of ADMIN_ROUTES) {
      seed();
      const result = await callJson(route.method, route.path, { body: route.body });

      expect(result.status, `${route.method} ${route.path}`).toBe(401);
      expect(result.body.code, `${route.method} ${route.path}`).toBe('UNAUTHORIZED');
    }
  });

  it('refuses a signed-in NON-ADMIN on every admin route', async () => {
    for (const route of ADMIN_ROUTES) {
      const db = seed();
      const result = await callJson(route.method, route.path, { token: MEMBER.token, body: route.body });

      expect(result.status, `${route.method} ${route.path}`).toBe(403);
      expect(result.body.code, `${route.method} ${route.path}`).toBe('NOT_ADMIN');

      // And nothing happened as a side effect of trying.
      expect(db.rows('auctions')[0].status).toBe('active');
      expect(db.rows('users').find((user: any) => user.id === MEMBER.id).banned_at).toBeNull();
    }
  });

  it('ignores a role claimed in the request body - the database row is the only source', async () => {
    const db = seed();

    const hide = await callJson('POST', '/api/admin/auctions/auc_1/hide', {
      token: MEMBER.token,
      body: { reason: 'Scam', role: 'admin', user: { role: 'admin' }, isAdmin: true },
    });

    expect(hide.status).toBe(403);
    expect(hide.body.code).toBe('NOT_ADMIN');
    expect(db.rows('auctions')[0].status).toBe('active');
    // The attempt did not write a role either.
    expect(db.rows('users').find((user: any) => user.id === MEMBER.id).role).toBe('member');
  });

  it('lets a real admin through', async () => {
    seed();

    const result = await callJson('GET', '/api/admin/reports', { token: ADMIN.token });

    expect(result.status).toBe(200);
    expect(result.body.reports).toEqual([]);
  });

  it('404s an unknown /api/admin path only AFTER the role check', async () => {
    seed();

    const member = await callJson('GET', '/api/admin/nope', { token: MEMBER.token });
    expect(member.status).toBe(403);
    expect(member.body.code).toBe('NOT_ADMIN');

    const admin = await callJson('GET', '/api/admin/nope', { token: ADMIN.token });
    expect(admin.status).toBe(404);
  });
});

/* ========================================================================== */
/* 2. Bans                                                                    */
/* ========================================================================== */

describe('banned accounts', () => {
  it('is refused on listing creation, the seller write routes and the account routes, with 403 ACCOUNT_BANNED', async () => {
    const routes: { method: string; path: string; body?: any }[] = [
      {
        method: 'POST',
        path: '/api/auctions',
        body: {
          title: 'Thing',
          description: 'Desc',
          phoneNumber: '0100000000',
          price: 10,
          imageUrls: ['data:image/png;base64,aaa'],
        },
      },
      { method: 'PATCH', path: '/api/auctions/auc_1', body: { title: 'Renamed' } },
      { method: 'POST', path: '/api/auctions/auc_1/sold' },
      { method: 'DELETE', path: '/api/auctions/auc_1' },
      { method: 'GET', path: '/api/users/me/activity' },
      { method: 'GET', path: '/api/auth/me' },
      { method: 'POST', path: '/api/auth/email', body: { email: 'x@example.com' } },
      { method: 'POST', path: '/api/auctions/auc_1/report', body: { reason: 'scam' } },
    ];

    for (const route of routes) {
      // The banned account OWNS auc_1, so a 403 here is the ban, not an ownership check.
      const db = seed({ auctions: [auctionRow({ seller_id: BANNED.id, seller_name: BANNED.name })] });
      const result = await callJson(route.method, route.path, { token: BANNED.token, body: route.body });

      expect(result.status, `${route.method} ${route.path}`).toBe(403);
      expect(result.body.code, `${route.method} ${route.path}`).toBe('ACCOUNT_BANNED');
      // The reason is surfaced so the user is not left guessing.
      expect(result.body.error, `${route.method} ${route.path}`).toContain('Repeated scam listings');

      expect(db.rows('auctions')).toHaveLength(1);
      expect(db.rows('auctions')[0]).toMatchObject({ status: 'active', title: 'Vintage lamp' });
    }
  });

  it('cannot log in even with the correct password', async () => {
    const db = seed({
      users: [ADMIN, { ...BANNED, password_hash: await sha256Hex('right password') }],
      auctions: [],
    });

    const correct = await callJson('POST', '/api/auth/login', {
      body: { username: 'banned', password: 'right password' },
    });
    expect(correct.status).toBe(403);
    expect(correct.body.code).toBe('ACCOUNT_BANNED');
    // No new session token was minted for them.
    expect(db.rows('users').find((user: any) => user.id === BANNED.id).token).toBe(BANNED.token);

    // A WRONG password still fails as a wrong password, so the ban is not a
    // password oracle: an attacker cannot tell a banned account from any other.
    const wrong = await callJson('POST', '/api/auth/login', {
      body: { username: 'banned', password: 'guess' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('leaves an unbanned user working normally again', async () => {
    const db = seed();

    const banned = await callJson('POST', '/api/admin/users/usr_member/ban', {
      token: ADMIN.token,
      body: { reason: 'Abusive messages' },
    });
    expect(banned.status).toBe(200);
    expect(banned.body.user).toMatchObject({ id: MEMBER.id, bannedReason: 'Abusive messages' });
    expect(db.rows('users').find((user: any) => user.id === MEMBER.id).banned_at).toBeGreaterThan(0);

    const blocked = await callJson('GET', '/api/users/me/activity', { token: MEMBER.token });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('ACCOUNT_BANNED');

    const unbanned = await callJson('POST', '/api/admin/users/usr_member/unban', {
      token: ADMIN.token,
      body: {},
    });
    expect(unbanned.status).toBe(200);
    expect(unbanned.body.user.bannedAt).toBeNull();

    const allowed = await callJson('GET', '/api/users/me/activity', { token: MEMBER.token });
    expect(allowed.status).toBe(200);
  });

  it('requires a reason, refuses self-bans, refuses banning another admin, and 404s an unknown user', async () => {
    seed();
    const noReason = await callJson('POST', '/api/admin/users/usr_member/ban', { token: ADMIN.token, body: {} });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('MISSING_REASON');

    seed();
    const self = await callJson('POST', '/api/admin/users/usr_admin/ban', {
      token: ADMIN.token,
      body: { reason: 'Oops' },
    });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('CANNOT_BAN_SELF');

    seed({ users: [ADMIN, { ...ADMIN, id: 'usr_admin2', username: 'admin2', token: 'tok_admin2' }] });
    const otherAdmin = await callJson('POST', '/api/admin/users/usr_admin2/ban', {
      token: ADMIN.token,
      body: { reason: 'Disagreement' },
    });
    expect(otherAdmin.status).toBe(403);
    expect(otherAdmin.body.code).toBe('CANNOT_BAN_ADMIN');

    seed();
    const unknown = await callJson('POST', '/api/admin/users/usr_ghost/ban', {
      token: ADMIN.token,
      body: { reason: 'Spam' },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('USER_NOT_FOUND');
  });
});

/* ========================================================================== */
/* 3. Reporting                                                               */
/* ========================================================================== */

describe('POST /api/auctions/:id/report', () => {
  it('records a report from any signed-in user', async () => {
    const db = seed();

    const result = await callJson('POST', '/api/auctions/auc_1/report', {
      token: MEMBER.token,
      body: { reason: 'scam', details: 'Asks for a bank transfer up front' },
    });

    expect(result.status).toBe(200);
    expect(result.body.duplicate).toBe(false);
    expect(result.body.report).toMatchObject({
      auctionId: 'auc_1',
      reporterId: MEMBER.id,
      reason: 'scam',
      status: 'open',
      auctionTitle: 'Vintage lamp',
      sellerId: SELLER.id,
    });

    const row = db.rows('reports')[0];
    expect(row.auction_id).toBe('auc_1');
    expect(row.reporter_id).toBe(MEMBER.id);
    expect(row.status).toBe('open');
    expect(row.details).toBe('Asks for a bank transfer up front');
  });

  it('collapses a duplicate into a 200 with the existing report, not an error', async () => {
    const db = seed();

    const first = await callJson('POST', '/api/auctions/auc_1/report', {
      token: MEMBER.token,
      body: { reason: 'scam' },
    });
    const second = await callJson('POST', '/api/auctions/auc_1/report', {
      token: MEMBER.token,
      body: { reason: 'offensive', details: 'changed my mind' },
    });

    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.report.id).toBe(first.body.report.id);
    // Still exactly one row: the duplicate did not write a second.
    expect(db.rows('reports')).toHaveLength(1);
    expect(db.rows('reports')[0].reason).toBe('scam');
  });

  it('keeps reports from DIFFERENT users on the same listing separate', async () => {
    const db = seed();

    await callJson('POST', '/api/auctions/auc_1/report', { token: MEMBER.token, body: { reason: 'scam' } });
    await callJson('POST', '/api/auctions/auc_1/report', { token: SELLER.token, body: { reason: 'prohibited' } });

    expect(db.rows('reports')).toHaveLength(2);
  });

  it('enforces the fixed reason set', async () => {
    for (const reason of REPORT_REASONS) {
      const db = seed();
      const ok = await callJson('POST', '/api/auctions/auc_1/report', { token: MEMBER.token, body: { reason } });
      expect(ok.status, reason).toBe(200);
      expect(db.rows('reports')[0].reason).toBe(reason);
    }

    for (const reason of ['spam', '', null, 42, 'SCAM ', 'other; drop table']) {
      const db = seed();
      const result = await callJson('POST', '/api/auctions/auc_1/report', { token: MEMBER.token, body: { reason } });

      if (reason === 'SCAM ') {
        // Trimmed and lowercased before the check, so this one is valid.
        expect(result.status).toBe(200);
        continue;
      }

      expect(result.status, String(reason)).toBe(400);
      expect(result.body.code, String(reason)).toBe('INVALID_REPORT_REASON');
      expect(db.rows('reports')).toHaveLength(0);
    }
  });

  it('requires authentication and a listing that exists', async () => {
    seed();
    const anonymous = await callJson('POST', '/api/auctions/auc_1/report', { body: { reason: 'scam' } });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe('UNAUTHORIZED');

    seed();
    const missing = await callJson('POST', '/api/auctions/auc_ghost/report', {
      token: MEMBER.token,
      body: { reason: 'scam' },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('AUCTION_NOT_FOUND');
  });
});

describe('GET /api/admin/reports', () => {
  it('lists open reports first, each with the listing title and seller', async () => {
    seed({
      auctions: [auctionRow(), auctionRow({ id: 'auc_2', title: 'Old bike', created_at: NOW - 2000 })],
      reports: [
        {
          id: 'rep_old',
          auction_id: 'auc_2',
          reporter_id: MEMBER.id,
          reason: 'other',
          details: null,
          created_at: NOW - 100_000,
          status: 'dismissed',
          resolved_by: ADMIN.id,
          resolved_at: NOW - 90_000,
        },
        {
          id: 'rep_new',
          auction_id: 'auc_1',
          reporter_id: MEMBER.id,
          reason: 'scam',
          details: 'Dodgy',
          created_at: NOW - 200_000,
          status: 'open',
          resolved_by: null,
          resolved_at: null,
        },
      ],
    });

    const result = await callJson('GET', '/api/admin/reports', { token: ADMIN.token });

    expect(result.status).toBe(200);
    // The OPEN one comes first even though it is the older of the two.
    expect(result.body.reports.map((report: any) => report.id)).toEqual(['rep_new', 'rep_old']);
    expect(result.body.reports[0]).toMatchObject({
      auctionId: 'auc_1',
      auctionTitle: 'Vintage lamp',
      sellerId: SELLER.id,
      sellerName: SELLER.name,
      reason: 'scam',
      status: 'open',
    });
    expect(result.body.reports[1].auctionTitle).toBe('Old bike');
  });
});

/* ========================================================================== */
/* 4. Hiding a listing                                                        */
/* ========================================================================== */

describe('POST /api/admin/auctions/:id/hide', () => {
  it('removes the listing from the list but leaves it fetchable by id', async () => {
    const db = seed({ auctions: [auctionRow(), auctionRow({ id: 'auc_2', created_at: NOW - 2000 })] });

    const hidden = await callJson('POST', '/api/admin/auctions/auc_1/hide', {
      token: ADMIN.token,
      body: { reason: 'Phone number in the description' },
    });

    expect(hidden.status).toBe(200);
    expect(hidden.body.status).toBe('hidden');

    const row = db.rows('auctions').find((auction: any) => auction.id === 'auc_1');
    expect(row.status).toBe('hidden');
    expect(row.hidden_reason).toBe('Phone number in the description');
    expect(row.hidden_by).toBe(ADMIN.id);
    expect(row.hidden_at).toBeGreaterThan(0);

    const list = await callJson('GET', '/api/auctions');
    expect(list.body.auctions.map((auction: any) => auction.id)).toEqual(['auc_2']);

    // The takedown must survive the direct link too: an anonymous caller gets
    // the same 404 as an unknown id, never the hidden row.
    const byId = await callJson('GET', '/api/auctions/auc_1');
    expect(byId.status).toBe(404);
    expect(byId.body.code).toBe('AUCTION_NOT_FOUND');

    // An admin, resolved from the bearer token, still gets the full row so the
    // panel can review what it took down.
    const asAdmin = await callJson('GET', '/api/auctions/auc_1', { token: ADMIN.token });
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.auction).toMatchObject({ id: 'auc_1', status: 'hidden' });
  });

  it('keeps a hidden listing out of every page of the cursor walk', async () => {
    seed({
      auctions: [
        auctionRow({ id: 'auc_a', created_at: NOW - 1 }),
        auctionRow({ id: 'auc_b', created_at: NOW - 2, status: 'hidden' }),
        auctionRow({ id: 'auc_c', created_at: NOW - 3 }),
      ],
    });

    const first = await callJson('GET', '/api/auctions?limit=1');
    const next = await callJson('GET', `/api/auctions?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);

    expect(first.body.auctions.map((a: any) => a.id)).toEqual(['auc_a']);
    expect(next.body.auctions.map((a: any) => a.id)).toEqual(['auc_c']);
    expect(next.body.nextCursor).toBeNull();
  });

  it('locks the seller out of a hidden listing: no edit, no mark-sold, no cancel', async () => {
    for (const route of [
      { method: 'PATCH', path: '/api/auctions/auc_1', body: { title: 'Back again' } },
      { method: 'POST', path: '/api/auctions/auc_1/sold' },
      { method: 'DELETE', path: '/api/auctions/auc_1' },
    ]) {
      const db = seed({ auctions: [auctionRow({ status: 'hidden' })] });

      const result = await callJson(route.method, route.path, { token: SELLER.token, body: route.body });

      expect(result.status, `${route.method} ${route.path}`).toBe(409);
      expect(result.body.code).toBe('LISTING_NOT_EDITABLE');
      expect(db.rows('auctions')[0]).toMatchObject({ status: 'hidden', title: 'Vintage lamp', sold_at: null });
    }
  });

  it('closes the open reports on that listing as actioned', async () => {
    const db = seed({
      reports: [
        {
          id: 'rep_1',
          auction_id: 'auc_1',
          reporter_id: MEMBER.id,
          reason: 'scam',
          details: null,
          created_at: NOW,
          status: 'open',
          resolved_by: null,
          resolved_at: null,
        },
      ],
    });

    const result = await callJson('POST', '/api/admin/auctions/auc_1/hide', {
      token: ADMIN.token,
      body: { reason: 'Confirmed scam' },
    });

    expect(result.body.reportsActioned).toBe(1);
    expect(db.rows('reports')[0]).toMatchObject({ status: 'actioned', resolved_by: ADMIN.id });
    expect(db.rows('reports')[0].resolved_at).toBeGreaterThan(0);
  });

  it('requires a reason and a listing that exists', async () => {
    const db = seed();
    const noReason = await callJson('POST', '/api/admin/auctions/auc_1/hide', { token: ADMIN.token, body: {} });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('MISSING_REASON');
    expect(db.rows('auctions')[0].status).toBe('active');

    seed();
    const missing = await callJson('POST', '/api/admin/auctions/auc_ghost/hide', {
      token: ADMIN.token,
      body: { reason: 'Scam' },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('AUCTION_NOT_FOUND');
  });
});

/* ========================================================================== */
/* 4a. A hidden listing must not leak through any read path                   */
/* ========================================================================== */

describe('a hidden listing is invisible to everyone but an admin', () => {
  it('404s by id for an anonymous caller', async () => {
    seed({ auctions: [auctionRow({ status: 'hidden' })] });

    const result = await callJson('GET', '/api/auctions/auc_1');

    expect(result.status).toBe(404);
    expect(result.body.code).toBe('AUCTION_NOT_FOUND');
  });

  it('404s for a signed-in non-admin', async () => {
    seed({ auctions: [auctionRow({ status: 'hidden' })] });

    const result = await callJson('GET', '/api/auctions/auc_1', { token: MEMBER.token });

    expect(result.status).toBe(404);
    expect(result.body.code).toBe('AUCTION_NOT_FOUND');
  });

  it('returns the full row for an admin', async () => {
    seed({ auctions: [auctionRow({ status: 'hidden' })] });

    const result = await callJson('GET', '/api/auctions/auc_1', { token: ADMIN.token });

    expect(result.status).toBe(200);
    expect(result.body.auction).toMatchObject({ id: 'auc_1', status: 'hidden' });
  });

  it('never errors out on a garbage or expired token - it just falls back to "not an admin"', async () => {
    seed({ auctions: [auctionRow({ status: 'hidden' })] });

    const result = await callJson('GET', '/api/auctions/auc_1', { token: 'tok_does_not_exist' });

    expect(result.status).toBe(404);
    expect(result.body.code).toBe('AUCTION_NOT_FOUND');
  });

  it('refuses to serve images for a hidden listing to a non-admin, but still serves them to an admin', async () => {
    seed({ auctions: [auctionRow({ status: 'hidden' })] });

    const anonymous = await callJson('GET', '/api/auctions/auc_1/images');
    expect(anonymous.status).toBe(404);
    expect(anonymous.body.code).toBe('AUCTION_NOT_FOUND');

    const member = await callJson('GET', '/api/auctions/auc_1/images', { token: MEMBER.token });
    expect(member.status).toBe(404);
    expect(member.body.code).toBe('AUCTION_NOT_FOUND');

    const admin = await callJson('GET', '/api/auctions/auc_1/images', { token: ADMIN.token });
    expect(admin.status).toBe(200);
    expect(admin.body.imageUrls).toEqual(['data:image/png;base64,aaa']);
  });

  it('serves the default shell with no trace of the hidden title through the Open Graph path', async () => {
    seed({ auctions: [auctionRow({ status: 'hidden', title: 'Definitely A Scam Watch' })] });

    const shell = `<!doctype html>
<html>
  <head>
    <title>MSA Auction</title>
    <meta name="description" content="Real-time online auction platform." />
  </head>
  <body></body>
</html>`;

    const response = await worker.fetch(
      new Request('https://msa-auction.test/auction/auc_1'),
      {
        ...ENV,
        ASSETS: {
          fetch: async () => new Response(shell, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
        },
      },
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toBe(shell);
    expect(html).not.toContain('Definitely A Scam Watch');
  });
});

/* ========================================================================== */
/* 5. The interim reset-request queue                                         */
/* ========================================================================== */

describe('GET /api/admin/reset-requests', () => {
  it('hands an admin a usable token for each pending request, and stores only its hash', async () => {
    const db = seed({
      users: [
        ADMIN,
        {
          ...MEMBER,
          email: 'member@example.com',
          password_hash: await sha256Hex('old password'),
          reset_token_hash: await sha256Hex('some-earlier-token'),
          reset_token_expires: NOW + RESET_TOKEN_TTL_MS,
        },
        { ...SELLER, email: 'seller@example.com', reset_token_hash: null, reset_token_expires: null },
      ],
      auctions: [],
    });

    const result = await callJson('GET', '/api/admin/reset-requests', { token: ADMIN.token });

    expect(result.status).toBe(200);
    // Only the account with a live request is listed.
    expect(result.body.resetRequests).toHaveLength(1);
    expect(result.body.resetRequests[0]).toMatchObject({ userId: MEMBER.id, email: 'member@example.com' });

    const token = result.body.resetRequests[0].token;
    expect(token).toBeTruthy();

    // What is stored is the HASH of the issued token, never the token itself.
    const row = db.rows('users').find((user: any) => user.id === MEMBER.id);
    expect(row.reset_token_hash).toBe(await sha256Hex(token));
    expect(row.reset_token_hash).not.toBe(token);

    // And the token actually works.
    const reset = await callJson('POST', '/api/auth/reset-password', {
      body: { token, newPassword: 'a fresh password' },
    });
    expect(reset.status).toBe(200);
  });

  it('re-issues on each read, so the previous link stops working', async () => {
    seed({
      users: [
        ADMIN,
        { ...MEMBER, email: 'member@example.com', reset_token_hash: await sha256Hex('x'), reset_token_expires: NOW + RESET_TOKEN_TTL_MS },
      ],
      auctions: [],
    });

    const first = await callJson('GET', '/api/admin/reset-requests', { token: ADMIN.token });
    const second = await callJson('GET', '/api/admin/reset-requests', { token: ADMIN.token });

    expect(second.body.resetRequests[0].token).not.toBe(first.body.resetRequests[0].token);

    const stale = await callJson('POST', '/api/auth/reset-password', {
      body: { token: first.body.resetRequests[0].token, newPassword: 'nope' },
    });
    expect(stale.status).toBe(400);
    expect(stale.body.code).toBe('INVALID_RESET_TOKEN');
  });

  it('skips requests that have already expired', async () => {
    seed({
      users: [
        ADMIN,
        { ...MEMBER, email: 'member@example.com', reset_token_hash: await sha256Hex('x'), reset_token_expires: NOW - 1 },
      ],
      auctions: [],
    });

    const result = await callJson('GET', '/api/admin/reset-requests', { token: ADMIN.token });

    expect(result.body.resetRequests).toEqual([]);
  });
});
