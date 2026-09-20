-- ============================================================================
-- 003_moderation_and_admin.sql
--
-- WHAT THIS DOES
--   1. Adds `users.role` (NOT NULL, default 'member'), plus `users.banned_at`
--      and `users.banned_reason`.
--   2. Creates the `reports` table that backs POST /api/auctions/:id/report and
--      GET /api/admin/reports.
--   3. Adds `auctions.hidden_reason` / `hidden_by` / `hidden_at`, so an admin
--      takedown records WHY and BY WHOM instead of only flipping a status.
--   4. Adds a list index matching the auction list's new visibility filter.
--
-- ORDER: run this THIRD, after 002_user_email_and_password_reset.sql.
--
-- REQUIRED BEFORE DEPLOY. Without `users.role` every /api/admin/* route answers
-- 500, and POST /api/auctions/:id/report fails on the missing `reports` table.
--
-- SAFE TO RE-RUN. Every statement is guarded with IF NOT EXISTS. The one NOT
-- NULL column added (`users.role`) carries a DEFAULT, so the backfill of
-- existing rows is what Postgres does automatically and no row is rejected.
--
-- >>> YOU MUST APPOINT THE FIRST ADMIN BY HAND. <<<
-- Everything defaults to 'member'. Until one row says 'admin', EVERY admin
-- route answers 403 NOT_ADMIN and there is no way in through the application -
-- by design, since a self-service route that grants admin would be the whole
-- vulnerability. Edit the username below, uncomment the line, and run it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Roles and bans
-- ---------------------------------------------------------------------------

-- 'member' | 'admin'. A plain text column with no CHECK constraint, matching
-- `auctions.status`. The application reads this column and ONLY this column to
-- decide whether a caller is an admin; a `role` in a request body is never
-- consulted. Do not add a route that writes it.
alter table public.users
  add column if not exists role text not null default 'member';

-- Epoch milliseconds, like every other timestamp in this schema. NULL means
-- "not banned"; the application treats any positive value as banned.
alter table public.users
  add column if not exists banned_at bigint;

alter table public.users
  add column if not exists banned_reason text;

-- Small table, but this keeps `GET /api/admin/reports`-style role lookups and
-- any future admin listing off a sequential scan.
create index if not exists idx_users_role
  on public.users (role)
  where role <> 'member';

-- ---------------------------------------------------------------------------
-- 2. Reports
-- ---------------------------------------------------------------------------

-- `id`, `auction_id` and `reporter_id` are text to match the application's own
-- id format (`rep_...`, `auc_...`, `usr_...`), which is what `auctions.id` and
-- `users.id` already use.
--
-- `reason` is one of: scam | prohibited | offensive | wrong_category | other.
-- Enforced in the application (workers/shared.ts REPORT_REASONS) rather than by
-- a CHECK constraint, so adding a reason later does not need a migration.
--
-- `status` is one of: open | actioned | dismissed.
create table if not exists public.reports (
  id text primary key,
  auction_id text not null,
  reporter_id text not null,
  reason text not null,
  details text,
  created_at bigint not null,
  status text not null default 'open',
  resolved_by text,
  resolved_at bigint
);

-- The admin queue reads open reports first.
create index if not exists idx_reports_status
  on public.reports (status);

-- Backs the one-open-report-per-user-per-listing check on POST
-- /api/auctions/:id/report. An index, not a unique constraint: a user may
-- legitimately report the same listing again once an earlier report has been
-- actioned or dismissed.
create index if not exists idx_reports_auction_reporter
  on public.reports (auction_id, reporter_id, status);

-- ---------------------------------------------------------------------------
-- 3. Admin takedown metadata on auctions
-- ---------------------------------------------------------------------------

-- POST /api/admin/auctions/:id/hide requires a reason. These columns are where
-- it goes; without them the reason would be collected and then discarded.
alter table public.auctions
  add column if not exists hidden_reason text;

alter table public.auctions
  add column if not exists hidden_by text;

alter table public.auctions
  add column if not exists hidden_at bigint;

-- ---------------------------------------------------------------------------
-- 4. List index for the new visibility filter
-- ---------------------------------------------------------------------------

-- GET /api/auctions now excludes BOTH 'cancelled' and 'hidden'. The index from
-- migration 001 (`where status <> 'cancelled'`) still covers that narrower
-- predicate, so this is an optimisation, not a correctness fix. 001's index is
-- deliberately left in place - dropping it would need an exclusive lock.
create index if not exists idx_auctions_list_keyset_visible
  on public.auctions (end_time desc, id desc)
  where status <> 'cancelled' and status <> 'hidden';

-- ---------------------------------------------------------------------------
-- 5. APPOINT THE FIRST ADMIN  --  EDIT AND UNCOMMENT THIS
-- ---------------------------------------------------------------------------
-- Replace the username with your own (it is stored lowercased), then run it.
-- Nothing else in this file or in the application will do this for you.
--
-- update public.users set role = 'admin' where username = 'your-username-here';
--
-- Verify afterwards:
--   select username, role from public.users where role = 'admin';
