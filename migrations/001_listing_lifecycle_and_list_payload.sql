-- ============================================================================
-- 001_listing_lifecycle_and_list_payload.sql
--
-- WHAT THIS DOES
--   1. Adds `auctions.image_count`, a STORED GENERATED column holding the
--      number of entries in `image_urls`. `GET /api/auctions` no longer selects
--      `image_url` / `image_urls` (they hold base64 data URLs and were being
--      shipped to every polling client); it selects this integer instead so the
--      client knows how many images to expect and fetches the bytes on demand
--      from `GET /api/auctions/:id/images`.
--   2. Adds an index matching the auction list's keyset pagination order,
--      `(end_time DESC, id DESC)` over non-cancelled rows.
--   3. Adds a partial index on `(seller_id) WHERE status = 'active'`, which is
--      what the per-user listing cap now counts.
--
-- ORDER: run this FIRST. There are four migrations in this change set - this
-- one, then 002_user_email_and_password_reset.sql, then
-- 003_moderation_and_admin.sql, then 004_money_numeric_and_bid_version.sql -
-- and they must be run in that order: 001, 002, 003, 004.
--
-- REQUIRED BEFORE DEPLOY. Without `image_count` the auction list query fails
-- with Postgres 42703 (undefined column), which renders an empty homepage.
-- Run this BEFORE shipping the Worker - deploying the Worker before running
-- this migration is the ordering that produces that failure.
--
-- 004 IS ALSO A PRE-DEPLOY REQUIREMENT, for a different reason. It converts the
-- money columns from `double precision` to `numeric(12,2)` and adds
-- `auctions.bid_version`, the column the bid optimistic lock guards on. The
-- Worker tolerates that column being absent - it falls back to the old
-- `current_price` guard rather than bidding unguarded - so a Worker deployed
-- ahead of 004 will not fail. It will just still carry the float-equality bug
-- 004 exists to remove. Run 004 BEFORE shipping the Worker too.
--
-- SAFE TO RE-RUN. Every statement is guarded with IF NOT EXISTS. It adds no
-- constraints, rewrites no data, and drops nothing.
--
-- NOTE ON 'cancelled': listings are now soft-deleted by setting
-- `status = 'cancelled'`. `auctions.status` is a plain `text` column with no
-- CHECK constraint, so the new value needs no DDL. Do not add a CHECK
-- constraint here without including 'cancelled' in it.
-- ============================================================================

-- 1. Image count, derived from image_urls. jsonb_typeof / jsonb_array_length
--    are both IMMUTABLE, which is what lets them be used in a generated column.
--    The CASE guards rows whose image_urls is a non-array JSON value.
alter table public.auctions
  add column if not exists image_count integer
  generated always as (
    case
      when jsonb_typeof(image_urls) = 'array' then jsonb_array_length(image_urls)
      else 0
    end
  ) stored;

-- 2. Keyset pagination order for GET /api/auctions.
--    Must match the ORDER BY and the `status <> 'cancelled'` filter exactly or
--    Postgres will fall back to a sort over the whole table.
create index if not exists idx_auctions_list_keyset
  on public.auctions (end_time desc, id desc)
  where status <> 'cancelled';

-- 3. Per-seller active listing count (the cap on POST /api/auctions).
create index if not exists idx_auctions_seller_active
  on public.auctions (seller_id)
  where status = 'active';
