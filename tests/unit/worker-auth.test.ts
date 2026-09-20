// @vitest-environment node
/**
 * Password storage, email capture and password reset.
 *
 * Driven through the Worker's real routes rather than against the helpers in
 * isolation, because the thing worth protecting is the LOGIN CONTRACT: nobody
 * gets locked out by the format change, and nobody's password is recoverable
 * from the stored value.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeSupabase, FakeSupabase } from './helpers/fake-supabase';

const mocks = vi.hoisted(() => ({ client: null as any }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mocks.client,
}));

import worker from '../../workers/index';
import {
  RESET_TOKEN_TTL_MS,
  PBKDF2_ITERATIONS,
  parseStoredPassword,
  sha256Hex,
  hashPassword,
} from '../../workers/shared';

const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'test-secret' };

const NOW = Date.now();
const PASSWORD = 'correct horse battery staple';

function userRow(overrides: Record<string, any> = {}) {
  return {
    id: 'usr_alice',
    name: 'Alice',
    username: 'alice',
    password_hash: null,
    token: 'tok_alice',
    created_at: NOW - 10_000,
    email: null,
    role: 'member',
    banned_at: null,
    banned_reason: null,
    reset_token_hash: null,
    reset_token_expires: null,
    ...overrides,
  };
}

function seed(users: Record<string, any>[]): FakeSupabase {
  const db = createFakeSupabase({ users, auctions: [] });
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

/** The format this change replaces: one round of SHA-256, no salt. */
function legacyHash(value: string) {
  return sha256Hex(value);
}

beforeEach(() => {
  mocks.client = null;
});

/* ========================================================================== */
/* 1. Password storage                                                        */
/* ========================================================================== */

describe('password storage', () => {
  it('stores a new registration as a self-describing pbkdf2 string, not a bare digest', async () => {
    const db = seed([]);

    const result = await callJson('POST', '/api/auth/register', {
      body: { username: 'Alice', name: 'Alice', password: PASSWORD },
    });

    expect(result.status).toBe(201);

    const stored = db.rows('users')[0].password_hash;
    expect(stored).toMatch(/^pbkdf2\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);

    const parsed = parseStoredPassword(stored);
    expect(parsed.format).toBe('pbkdf2');
    expect((parsed as any).iterations).toBe(PBKDF2_ITERATIONS);
    expect((parsed as any).salt.length).toBe(16);

    // The password itself never appears anywhere on the row.
    expect(JSON.stringify(db.rows('users')[0])).not.toContain(PASSWORD);
  });

  it('gives two users with the SAME password different stored hashes', async () => {
    const db = seed([]);

    await callJson('POST', '/api/auth/register', {
      body: { username: 'alice', name: 'Alice', password: PASSWORD },
    });
    await callJson('POST', '/api/auth/register', {
      body: { username: 'bob', name: 'Bob', password: PASSWORD },
    });

    const [alice, bob] = db.rows('users');
    expect(alice.password_hash).not.toBe(bob.password_hash);

    // Specifically because the SALTS differ - that is what defeats a rainbow
    // table and stops one cracked hash unlocking every account that reused it.
    const aliceSalt = (parseStoredPassword(alice.password_hash) as any).salt.join(',');
    const bobSalt = (parseStoredPassword(bob.password_hash) as any).salt.join(',');
    expect(aliceSalt).not.toBe(bobSalt);
  });

  it('logs a pbkdf2 user in with the right password and issues a fresh session token', async () => {
    const db = seed([]);

    const registered = await callJson('POST', '/api/auth/register', {
      body: { username: 'alice', name: 'Alice', password: PASSWORD },
    });

    const login = await callJson('POST', '/api/auth/login', {
      body: { username: 'alice', password: PASSWORD },
    });

    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ username: 'alice', name: 'Alice' });
    expect(login.body.user.token).toBeTruthy();
    expect(login.body.user.token).not.toBe(registered.body.user.token);
    expect(db.rows('users')[0].token).toBe(login.body.user.token);
  });

  it('logs in against a pbkdf2 hash written at a DIFFERENT iteration count than the current constant', async () => {
    // The stored string embeds its own iteration count (see `parseStoredPassword`),
    // so a row written under an old value of PBKDF2_ITERATIONS must keep verifying
    // even after the constant changes - nobody who registered or logged in under
    // the old count gets locked out.
    const oldIterationCount = PBKDF2_ITERATIONS + 90_000;
    expect(oldIterationCount).not.toBe(PBKDF2_ITERATIONS);

    const legacyCountHash = await hashPassword(PASSWORD, { iterations: oldIterationCount });
    expect(parseStoredPassword(legacyCountHash)).toMatchObject({ format: 'pbkdf2', iterations: oldIterationCount });

    const db = seed([userRow({ password_hash: legacyCountHash })]);

    const login = await callJson('POST', '/api/auth/login', { body: { username: 'alice', password: PASSWORD } });

    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe('usr_alice');
    // Not rewritten - unlike the legacy SHA-256 format, a pbkdf2 hash at a
    // different iteration count is a valid current format and is left alone.
    expect(db.rows('users')[0].password_hash).toBe(legacyCountHash);
  });

  it('rejects a wrong password without revealing anything about the account', async () => {
    seed([]);

    await callJson('POST', '/api/auth/register', {
      body: { username: 'alice', name: 'Alice', password: PASSWORD },
    });

    const wrong = await callJson('POST', '/api/auth/login', {
      body: { username: 'alice', password: 'not the password' },
    });

    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');

    const missing = await callJson('POST', '/api/auth/login', {
      body: { username: 'nobody', password: PASSWORD },
    });

    // Same status, same code, same message as a wrong password.
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('INVALID_CREDENTIALS');
    expect(missing.body.error).toBe(wrong.body.error);
  });
});

/* ========================================================================== */
/* 2. Transparent migration off the legacy hash                               */
/* ========================================================================== */

describe('legacy SHA-256 hashes', () => {
  it('still authenticates, and is rewritten to pbkdf2 on the first successful login', async () => {
    const db = seed([userRow({ password_hash: await legacyHash(PASSWORD) })]);

    // Precondition: the row really is in the old format.
    expect(db.rows('users')[0].password_hash).toMatch(/^[0-9a-f]{64}$/);

    const login = await callJson('POST', '/api/auth/login', { body: { username: 'alice', password: PASSWORD } });

    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe('usr_alice');

    // Upgraded in place, silently.
    const upgraded = db.rows('users')[0].password_hash;
    expect(upgraded).toMatch(/^pbkdf2\$/);
    expect(parseStoredPassword(upgraded).format).toBe('pbkdf2');

    // And the same password still works against the new value.
    const again = await callJson('POST', '/api/auth/login', { body: { username: 'alice', password: PASSWORD } });
    expect(again.status).toBe(200);
    expect(db.rows('users')[0].password_hash).toBe(upgraded);
  });

  it('never upgrades - or accepts - a WRONG password against a legacy row', async () => {
    const legacy = await legacyHash(PASSWORD);
    const db = seed([userRow({ password_hash: legacy })]);

    const login = await callJson('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong' } });

    expect(login.status).toBe(401);
    expect(login.body.code).toBe('INVALID_CREDENTIALS');
    expect(db.rows('users')[0].password_hash).toBe(legacy);
  });

  it('guards the upgrade write on the old value so a concurrent change is not clobbered', async () => {
    const db = seed([userRow({ password_hash: await legacyHash(PASSWORD) })]);

    await callJson('POST', '/api/auth/login', { body: { username: 'alice', password: PASSWORD } });

    const upgradeWrite = db
      .updateFilters('users')
      .find((filters) => filters.some((filter) => filter.column === 'password_hash'));

    expect(upgradeWrite).toBeDefined();
    expect(upgradeWrite).toContainEqual({ op: 'eq', column: 'id', value: 'usr_alice' });
  });
});

/* ========================================================================== */
/* 3. Email capture                                                           */
/* ========================================================================== */

describe('email addresses', () => {
  it('accepts an optional email at registration, normalised to lowercase', async () => {
    const db = seed([]);

    const result = await callJson('POST', '/api/auth/register', {
      body: { username: 'alice', name: 'Alice', password: PASSWORD, email: '  Alice@Example.COM ' },
    });

    expect(result.status).toBe(201);
    expect(result.body.user.email).toBe('alice@example.com');
    expect(db.rows('users')[0].email).toBe('alice@example.com');
  });

  it('registers fine with no email at all', async () => {
    const db = seed([]);

    const result = await callJson('POST', '/api/auth/register', {
      body: { username: 'alice', name: 'Alice', password: PASSWORD },
    });

    expect(result.status).toBe(201);
    expect(result.body.user.email).toBeNull();
    expect(db.rows('users')[0].email).toBeUndefined();
  });

  it('rejects an address with no @ or no dot in the domain', async () => {
    for (const email of ['alice', 'alice@', '@example.com', 'alice@example', 'alice example@x.com']) {
      seed([]);
      const result = await callJson('POST', '/api/auth/register', {
        body: { username: 'alice', name: 'Alice', password: PASSWORD, email },
      });

      expect(result.status).toBe(400);
      expect(result.body.code).toBe('INVALID_EMAIL');
    }
  });

  it('lets an existing user attach one through POST /api/auth/email', async () => {
    const db = seed([userRow()]);

    const result = await callJson('POST', '/api/auth/email', {
      token: 'tok_alice',
      body: { email: 'ALICE@Example.com' },
    });

    expect(result.status).toBe(200);
    expect(result.body.email).toBe('alice@example.com');
    expect(db.rows('users')[0].email).toBe('alice@example.com');
  });

  it('requires authentication, and refuses an address another account already holds', async () => {
    seed([userRow(), userRow({ id: 'usr_bob', username: 'bob', token: 'tok_bob', email: 'taken@example.com' })]);

    const anonymous = await callJson('POST', '/api/auth/email', { body: { email: 'x@example.com' } });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe('UNAUTHORIZED');

    const taken = await callJson('POST', '/api/auth/email', {
      token: 'tok_alice',
      body: { email: 'Taken@example.com' },
    });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('EMAIL_TAKEN');
  });
});

/* ========================================================================== */
/* 4. Password reset                                                          */
/* ========================================================================== */

describe('POST /api/auth/request-reset', () => {
  const GENERIC = 'If that account exists, a reset link has been created.';

  it('answers identically for a real account, an unknown one, and junk input', async () => {
    seed([userRow({ email: 'alice@example.com' })]);
    const real = await callJson('POST', '/api/auth/request-reset', { body: { usernameOrEmail: 'alice' } });

    seed([userRow({ email: 'alice@example.com' })]);
    const unknown = await callJson('POST', '/api/auth/request-reset', { body: { usernameOrEmail: 'nobody' } });

    seed([userRow({ email: 'alice@example.com' })]);
    const junk = await callJson('POST', '/api/auth/request-reset', { body: {} });

    for (const result of [real, unknown, junk]) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ success: true, message: GENERIC });
    }
  });

  it('stores only the token HASH plus a 60-minute expiry, and returns no token', async () => {
    const db = seed([userRow({ email: 'alice@example.com' })]);

    const result = await callJson('POST', '/api/auth/request-reset', { body: { usernameOrEmail: 'alice' } });

    const row = db.rows('users')[0];
    expect(row.reset_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.reset_token_expires).toBeGreaterThan(Date.now() + RESET_TOKEN_TTL_MS - 5_000);
    expect(row.reset_token_expires).toBeLessThanOrEqual(Date.now() + RESET_TOKEN_TTL_MS);

    // Nothing that could be replayed as a token comes back to the caller.
    expect(JSON.stringify(result.body)).not.toContain(row.reset_token_hash);
    expect(Object.keys(result.body).sort()).toEqual(['message', 'success']);
  });

  it('finds the account by email as well as by username', async () => {
    const db = seed([userRow({ email: 'alice@example.com' })]);

    await callJson('POST', '/api/auth/request-reset', { body: { usernameOrEmail: 'Alice@Example.com' } });

    expect(db.rows('users')[0].reset_token_hash).toBeTruthy();
  });

  it('does nothing for an account with no email on file', async () => {
    const db = seed([userRow({ email: null })]);

    const result = await callJson('POST', '/api/auth/request-reset', { body: { usernameOrEmail: 'alice' } });

    expect(result.status).toBe(200);
    expect(db.rows('users')[0].reset_token_hash).toBeNull();
  });
});

describe('POST /api/auth/reset-password', () => {
  const TOKEN = 'a-known-reset-token';

  async function seedWithPendingReset(overrides: Record<string, any> = {}) {
    return seed([
      userRow({
        email: 'alice@example.com',
        password_hash: await legacyHash('old password'),
        reset_token_hash: await sha256Hex(TOKEN),
        reset_token_expires: Date.now() + RESET_TOKEN_TTL_MS,
        ...overrides,
      }),
    ]);
  }

  it('sets a pbkdf2 password, clears the reset columns, and issues a fresh session token', async () => {
    const db = await seedWithPendingReset();
    const oldSessionToken = db.rows('users')[0].token;

    const result = await callJson('POST', '/api/auth/reset-password', {
      body: { token: TOKEN, newPassword: 'a brand new password' },
    });

    expect(result.status).toBe(200);
    expect(result.body.user.token).toBeTruthy();
    expect(result.body.user.token).not.toBe(oldSessionToken);

    const row = db.rows('users')[0];
    expect(row.password_hash).toMatch(/^pbkdf2\$/);
    expect(row.reset_token_hash).toBeNull();
    expect(row.reset_token_expires).toBeNull();

    // users.token is single-valued, so the old session is gone with it.
    expect(row.token).toBe(result.body.user.token);
    const stale = await callJson('GET', '/api/auth/me', { token: oldSessionToken });
    expect(stale.status).toBe(401);

    // The new password works.
    const login = await callJson('POST', '/api/auth/login', {
      body: { username: 'alice', password: 'a brand new password' },
    });
    expect(login.status).toBe(200);
  });

  it('refuses a token that has already been used', async () => {
    await seedWithPendingReset();

    const first = await callJson('POST', '/api/auth/reset-password', {
      body: { token: TOKEN, newPassword: 'first password' },
    });
    expect(first.status).toBe(200);

    const replay = await callJson('POST', '/api/auth/reset-password', {
      body: { token: TOKEN, newPassword: 'attacker password' },
    });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('INVALID_RESET_TOKEN');
  });

  it('refuses an expired token', async () => {
    const db = await seedWithPendingReset({ reset_token_expires: Date.now() - 1 });

    const result = await callJson('POST', '/api/auth/reset-password', {
      body: { token: TOKEN, newPassword: 'new password' },
    });

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('RESET_TOKEN_EXPIRED');
    expect(db.rows('users')[0].password_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an unknown token and a missing password', async () => {
    await seedWithPendingReset();
    const unknown = await callJson('POST', '/api/auth/reset-password', {
      body: { token: 'not-the-token', newPassword: 'new password' },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('INVALID_RESET_TOKEN');

    await seedWithPendingReset();
    const noPassword = await callJson('POST', '/api/auth/reset-password', { body: { token: TOKEN } });
    expect(noPassword.status).toBe(400);
    expect(noPassword.body.code).toBe('MISSING_FIELDS');
  });
});
