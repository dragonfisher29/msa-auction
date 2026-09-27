-- WHEN TO RUN: BEFORE deploying the v1 (fixed-price) Worker. Safe while the OLD auction Worker is still live.
-- ORDER: 006 (this file) -> deploy the new Worker -> 007_drop_bid_columns.sql.
-- ============================================================================
-- 006_fixed_price_listings.sql
--
-- WHAT THIS DOES (ADDITIVE - nothing is dropped, no bid data is touched)
--   1. Preflight: stops with a clear error, changing nothing, if the live
--      `auctions` table does not look the way this file assumes.
--   2. Adds `auctions.price numeric(12,2)`, `auctions.expires_at bigint` and
--      `auctions.sold_at bigint`. Timestamps are epoch MILLISECONDS in a bigint,
--      matching every other timestamp in this schema (`created_at`, `end_time`,
--      `hidden_at`, `users.reset_token_expires` - see 002 and 003).
--   3. Drops NOT NULL (only where it exists) on the bid-era columns the new
--      Worker no longer writes, so its INSERT - which does not mention them -
--      cannot fail on a constraint. Dropping NOT NULL is not destructive: no
--      value changes, and the old Worker always writes these columns anyway.
--   4. Backfills every existing row:
--        price      <- starting_price (the old starting price becomes the price)
--        active     -> expires_at = now + 30 days
--        ended WITH a winner    -> status 'sold', sold_at = end_time,
--                                  expires_at = end_time
--        ended with NO winner   -> left as status 'ended', expires_at = end_time.
--                                  The new Worker reads that as `expired`;
--                                  007 rewrites it to the canonical form
--                                  (status 'active' with a past expires_at).
--        cancelled / hidden     -> expires_at = end_time (keeps the photo
--                                  retention clock exactly where it was)
--   5. Replaces any CHECK constraint on `auctions.status` with one that allows
--      'sold' AND still allows 'ended' (the old Worker's settlement cron keeps
--      writing 'ended' until the new Worker is deployed). 007 tightens it.
--   6. Adds the indexes the new Worker's queries use:
--        idx_auctions_browse         (created_at desc, id desc) where status = 'active'
--                                    -> GET /api/auctions
--        idx_auctions_seller_created (seller_id, created_at desc, id desc)
--                                    -> GET /api/users/me/activity
--      The live-listing cap count is already served by idx_auctions_seller_active (001).
--   7. Installs a TRANSITIONAL trigger, `msa_v1_transition_sync`, that keeps the
--      new columns correct for rows the OLD Worker writes between this migration
--      and the new deploy (new listings, price edits, settlements). 007 drops it.
--
-- WHY A TRIGGER. Between running this file and deploying the new Worker, the
-- old Worker is still taking writes. Without the trigger:
--   - a listing created in that window would have NULL price / expires_at and
--     would be invisible on the new browse page;
--   - an old-style edit of starting_price would leave price stale;
--   - an auction the old cron settles in that window would keep a 30-day
--     expiry and no sold_at.
-- The trigger is a no-op for every write the NEW Worker makes (it always sets
-- price and expires_at itself and never writes starting_price or 'ended').
--
-- SAFE TO RE-RUN. Columns and indexes use IF NOT EXISTS; every backfill only
-- touches rows whose expires_at / price is still NULL; the trigger and the
-- CHECK constraint are dropped and recreated.
--
-- RUNS AS ONE TRANSACTION. If any statement fails, nothing is applied.
--
-- LOCKING. ADD COLUMN without a default and DROP NOT NULL are metadata-only.
-- CREATE INDEX (not CONCURRENTLY - that cannot run inside a transaction) blocks
-- writes to `auctions` while it builds; the table is small, so this is seconds.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Preflight - fail loudly instead of guessing
-- ---------------------------------------------------------------------------
-- No migration in this repo creates the base `auctions` table, so the column
-- types below are INFERRED (from the Worker's row mappers and 001-004). This
-- block turns a wrong inference into a readable error and a rolled-back
-- transaction, rather than a half-applied migration.
do $$
declare
  required_column text;
  column_type text;
begin
  foreach required_column in array array[
    'id', 'status', 'seller_id', 'created_at', 'end_time',
    'starting_price', 'current_price', 'winner_id', 'image_count'
  ]
  loop
    select data_type into column_type
      from information_schema.columns
     where table_schema = 'public' and table_name = 'auctions' and column_name = required_column;

    if column_type is null then
      raise exception '006 preflight: public.auctions.% does not exist. Nothing was changed.', required_column;
    end if;

    -- Timestamps must be epoch-millisecond NUMBERS: the new Worker compares
    -- them to Date.now() and pages on created_at with numeric filters.
    if required_column in ('created_at', 'end_time')
       and column_type not in ('bigint', 'integer', 'numeric', 'double precision') then
      raise exception '006 preflight: public.auctions.% is %, expected a numeric epoch-millisecond column. Nothing was changed.',
        required_column, column_type;
    end if;

    if required_column = 'status' and column_type <> 'text' and column_type <> 'character varying' then
      raise exception '006 preflight: public.auctions.status is %, expected text. Nothing was changed.', column_type;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. New columns
-- ---------------------------------------------------------------------------
-- price: the fixed asking price in GBP. numeric(12,2) like every other money
-- column since 004, so it is exact and a third decimal place is refused.
alter table public.auctions add column if not exists price numeric(12,2);

-- expires_at: epoch ms. The listing leaves the browse page when this passes.
alter table public.auctions add column if not exists expires_at bigint;

-- sold_at: epoch ms, set when the seller marks the listing sold. NULL otherwise.
alter table public.auctions add column if not exists sold_at bigint;

-- ---------------------------------------------------------------------------
-- 3. Relax NOT NULL on the bid-era columns the new Worker does not write
-- ---------------------------------------------------------------------------
-- Only columns that exist AND are currently NOT NULL are touched. bid_version
-- is left alone: it has DEFAULT 0 (004), so an INSERT that omits it is fine.
do $$
declare
  legacy_column text;
begin
  for legacy_column in
    select column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'auctions'
       and is_nullable = 'NO'
       and column_name in (
         'starting_price', 'current_price', 'highest_bidder_id', 'highest_bidder_name',
         'duration_minutes', 'start_time', 'end_time', 'bids',
         'winner_id', 'winner_name', 'winning_bid'
       )
  loop
    execute format('alter table public.auctions alter column %I drop not null', legacy_column);
    raise notice '006: dropped NOT NULL on auctions.%', legacy_column;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Backfill
-- ---------------------------------------------------------------------------
-- "now" in epoch milliseconds, the unit every timestamp column uses.
-- 30 days = 2,592,000,000 ms.

-- 4a. The old starting price becomes the fixed price.
update public.auctions
   set price = coalesce(starting_price, current_price)
 where price is null;

-- 4b. Currently active auctions get a full 30 days from now as fixed-price listings.
update public.auctions
   set expires_at = (extract(epoch from now()) * 1000)::bigint + 2592000000
 where status = 'active'
   and expires_at is null;

-- 4c. Ended auctions that had a winner become SOLD, at the moment they ended.
--     expires_at = end_time too, so the photo-retention clock (30 days after
--     expires_at, see cleanupStaleImages) matches the old "30 days after end_time".
update public.auctions
   set status     = 'sold',
       sold_at    = coalesce(end_time::bigint, (extract(epoch from now()) * 1000)::bigint),
       expires_at = coalesce(end_time::bigint, (extract(epoch from now()) * 1000)::bigint)
 where status = 'ended'
   and winner_id is not null
   and expires_at is null;

-- 4d. Everything else not yet backfilled - ended with NO winner, cancelled,
--     hidden - expires when the auction ended. Status is left as it is; an
--     'ended' row with no sold_at reads as `expired` in the new Worker.
update public.auctions
   set expires_at = coalesce(end_time::bigint, (extract(epoch from now()) * 1000)::bigint)
 where expires_at is null;

-- ---------------------------------------------------------------------------
-- 5. Status CHECK constraint - allow 'sold', keep 'ended' for now
-- ---------------------------------------------------------------------------
-- 001 and 003 state that `auctions.status` has NO check constraint. This does
-- not rely on that: any existing CHECK that mentions `status` is dropped and
-- replaced, so the result is the same either way.
do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
      from pg_constraint
     where conrelid = 'public.auctions'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.auctions drop constraint %I', constraint_row.conname);
    raise notice '006: dropped CHECK constraint % on auctions', constraint_row.conname;
  end loop;
end
$$;

-- NOT VALID: enforced for every new write from now on, without scanning (or
-- failing on) rows already in the table. 007 validates the tightened version.
alter table public.auctions
  add constraint auctions_status_check
  check (status in ('active', 'sold', 'cancelled', 'hidden', 'ended'))
  not valid;

-- ---------------------------------------------------------------------------
-- 6. Indexes for the new Worker's queries
-- ---------------------------------------------------------------------------
-- GET /api/auctions: `status = 'active' AND expires_at > now`, ORDER BY
-- created_at DESC, id DESC, keyset-paged on (created_at, id). `expires_at > now`
-- cannot be part of a partial-index predicate (now() is not immutable), so it is
-- applied as a filter over this index - cheap, since expired rows are a small
-- tail of the active set.
create index if not exists idx_auctions_browse
  on public.auctions (created_at desc, id desc)
  where status = 'active';

-- GET /api/users/me/activity: `seller_id = <caller>` ORDER BY created_at DESC.
create index if not exists idx_auctions_seller_created
  on public.auctions (seller_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- 7. Transitional trigger - REMOVED BY 007
-- ---------------------------------------------------------------------------
create or replace function public.msa_v1_transition_sync()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  -- price follows starting_price for rows the OLD Worker writes.
  if new.price is null then
    new.price := coalesce(new.starting_price, new.current_price);
  elsif tg_op = 'UPDATE'
        and new.starting_price is distinct from old.starting_price
        and new.price is not distinct from old.price then
    new.price := new.starting_price;
  end if;

  if new.status = 'ended' then
    -- The old cron just settled this auction: it finished at end_time.
    new.expires_at := least(
      coalesce(new.expires_at, new.end_time::bigint, now_ms),
      coalesce(new.end_time::bigint, now_ms)
    );
    if new.winner_id is not null and new.sold_at is null then
      new.sold_at := coalesce(new.end_time::bigint, now_ms);
    end if;
  elsif new.expires_at is null then
    -- A listing the old Worker created: same 30-day life as a new-Worker listing.
    new.expires_at := now_ms + 2592000000;
  end if;

  return new;
end
$$;

drop trigger if exists msa_v1_transition_sync on public.auctions;

create trigger msa_v1_transition_sync
  before insert or update on public.auctions
  for each row
  execute function public.msa_v1_transition_sync();

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION - run these afterwards
-- ---------------------------------------------------------------------------
-- Every row has a price and an expiry (expect 0 and 0):
--   select count(*) filter (where price is null)      as missing_price,
--          count(*) filter (where expires_at is null) as missing_expiry
--     from public.auctions;
--
-- How the backfill classified the rows ('ended' rows with sold_at NULL are the
-- no-winner auctions the new Worker reports as expired):
--   select status, (sold_at is not null) as has_sold_at, count(*)
--     from public.auctions group by 1, 2 order by 1, 2;
--
-- What the new browse page will show (live listings):
--   select count(*) from public.auctions
--    where status = 'active'
--      and expires_at > (extract(epoch from now()) * 1000)::bigint;
--
-- The new column types (expect price numeric 12/2, expires_at bigint, sold_at bigint):
--   select column_name, data_type, numeric_precision, numeric_scale
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'auctions'
--      and column_name in ('price', 'expires_at', 'sold_at', 'created_at', 'end_time')
--    order by column_name;
