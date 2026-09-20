-- ============================================================================
-- 002_user_email_and_password_reset.sql
--
-- WHAT THIS DOES
--   1. Adds `users.email` - nullable, with a CASE-INSENSITIVE unique index over
--      the rows that have one. Until now the table had no email column at all,
--      so a forgotten password meant a permanently lost account.
--   2. Adds `users.reset_token_hash` and `users.reset_token_expires`, which back
--      POST /api/auth/request-reset and POST /api/auth/reset-password.
--
-- ORDER: run this SECOND, after 001_listing_lifecycle_and_list_payload.sql.
--
-- REQUIRED BEFORE DEPLOY. Without these columns the email and reset routes fail
-- with Postgres 42703 (undefined column). The PBKDF2 password change needs no
-- DDL at all - it reuses the existing `password_hash` text column - so a deploy
-- that skipped this file would still be able to register and log people in, but
-- account recovery would be broken.
--
-- SAFE TO RE-RUN. Every statement is guarded with IF NOT EXISTS. It adds no
-- NOT NULL constraints, rewrites no data, and drops nothing. Existing rows get
-- NULL in all three new columns, which is the correct "no recovery address, no
-- reset in flight" state.
--
-- NOTE ON THE TOKEN COLUMNS: `reset_token_hash` holds the SHA-256 HEX DIGEST of
-- the reset token, never the token itself. Nothing in the application writes a
-- raw reset token to the database. Do not add a column that does.
-- ============================================================================

-- 1. Recovery address. Nullable: every account that exists today has none, and
--    supplying one stays optional at registration.
alter table public.users
  add column if not exists email text;

-- Case-insensitive uniqueness, and only over rows that actually have an email -
-- a plain UNIQUE would let 'A@x.com' and 'a@x.com' both exist, and (in
-- Postgres) would allow unlimited NULLs but is clearer stated as partial.
--
-- The application already lowercases before writing; `lower(email)` makes that
-- a guarantee rather than a convention.
create unique index if not exists idx_users_email_ci
  on public.users (lower(email))
  where email is not null;

-- 2. Password reset. `reset_token_expires` is epoch milliseconds, matching
--    every other timestamp in this schema (`users.created_at`,
--    `auctions.end_time`), which are all bigint millis rather than timestamptz.
alter table public.users
  add column if not exists reset_token_hash text;

alter table public.users
  add column if not exists reset_token_expires bigint;

-- Lookup path for POST /api/auth/reset-password, which finds the account by
-- token hash. Partial, because only a handful of rows ever have one pending.
create index if not exists idx_users_reset_token_hash
  on public.users (reset_token_hash)
  where reset_token_hash is not null;

-- Lookup path for GET /api/admin/reset-requests, which scans for live requests
-- with `reset_token_expires > now`.
create index if not exists idx_users_reset_token_expires
  on public.users (reset_token_expires)
  where reset_token_expires is not null;
