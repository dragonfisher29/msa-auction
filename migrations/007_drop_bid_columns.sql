-- WHEN TO RUN: only AFTER the v1 (fixed-price) Worker is deployed AND you have checked the live site works.
-- ORDER: 006_fixed_price_listings.sql -> deploy the new Worker -> 007 (this file). Never before the deploy.
-- ============================================================================
-- ############################################################################
-- ##                                                                        ##
-- ##   DESTRUCTIVE AND IRREVERSIBLE. THIS PERMANENTLY DELETES ALL BID DATA.  ##
-- ##                                                                        ##
-- ##   1. BACK UP FIRST. In the SQL Editor, run (as its own query):          ##
-- ##        create schema if not exists backup;                             ##
-- ##        create table backup.auctions_pre007 as table public.auctions;   ##
-- ##        alter table backup.auctions_pre007                              ##
-- ##          enable row level security;                                    ##
-- ##      and confirm its row count matches `public.auctions`. It goes in   ##
-- ##      a separate schema WITH RLS ON because the rows contain sellers'   ##
-- ##      phone numbers: a copy in `public` with RLS off would be readable  ##
-- ##      by anyone holding the (non-secret) anon key - the hole 005 shut. ##
-- ##   2. RUN ONLY AFTER THE NEW WORKER IS DEPLOYED. The OLD Worker reads    ##
-- ##      every column this drops; running this while it is live breaks    ##
-- ##      every page of the site.                                           ##
-- ##   3. There is no "down" migration. Dropped columns cannot be restored  ##
-- ##      except from the backup in step 1.                                 ##
-- ##                                                                        ##
-- ############################################################################
-- ============================================================================
-- 007_drop_bid_columns.sql
--
-- WHAT THIS DOES
--   1. Preflight: refuses to run (changing nothing) unless 006 has run.
--   2. Removes 006's transitional trigger and its function. The old Worker is
--      gone, so nothing writes the bid-era columns any more - and the trigger
--      body references columns this file is about to drop.
--   3. Final catch-up for rows the old Worker wrote between 006 and the deploy,
--      in case the trigger was missing for any reason (price / expires_at).
--   4. Rewrites every remaining legacy status 'ended' row to its canonical form:
--        had a winner (or a sold_at) -> status 'sold'
--        no winner                   -> status 'active' with expires_at in the
--                                       past, i.e. the derived `expired` state.
--   5. Tightens the status CHECK to exactly 'active' | 'sold' | 'cancelled' |
--      'hidden', and VALIDATES it against every existing row.
--   6. Sets NOT NULL on price and expires_at (every row has them after step 3).
--   7. Drops the indexes that only served the auction ordering on end_time.
--   8. Drops the bid-era columns, all of which the new Worker never reads:
--        bids, bid_version, current_price, starting_price,
--        highest_bidder_id, highest_bidder_name,
--        winner_id, winner_name, winning_bid,
--        duration_minutes, start_time, end_time
--
-- KEPT: everything the new Worker reads - id, title, description,
-- phone_number, price, seller_id, seller_name, status, category, image_url,
-- image_urls, image_count, images_version, created_at, expires_at, sold_at, and the
-- hidden_reason / hidden_by / hidden_at takedown record.
--
-- NO DATABASE FUNCTIONS are dropped other than 006's trigger function: no
-- migration in this repo created any bidding function, and the Worker has never
-- called an RPC. If the live database has one anyway, the query at the bottom
-- lists every function in `public` for you to review by hand.
--
-- RUNS AS ONE TRANSACTION. If ANY step fails - for example the CHECK in step 5
-- finds a status it does not recognise - the whole file is rolled back and no
-- column is dropped. Read the error, fix the row, run it again.
--
-- SAFE TO RE-RUN: every step is guarded (IF EXISTS, or checks for the column
-- before touching it), so a second run after a successful one is a no-op.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Preflight
-- ---------------------------------------------------------------------------
do $$
declare
  required_column text;
begin
  foreach required_column in array array['price', 'expires_at', 'sold_at']
  loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'auctions' and column_name = required_column
    ) then
      raise exception '007 preflight: auctions.% is missing - run 006_fixed_price_listings.sql first. Nothing was changed.',
        required_column;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Remove the transitional trigger from 006
-- ---------------------------------------------------------------------------
drop trigger if exists msa_v1_transition_sync on public.auctions;
drop function if exists public.msa_v1_transition_sync();

-- ---------------------------------------------------------------------------
-- 3 + 4. Final catch-up and legacy 'ended' conversion
-- ---------------------------------------------------------------------------
-- Dynamic SQL, guarded on the legacy columns still existing, so a re-run after
-- they have been dropped skips this step instead of erroring.
do $$
declare
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  has_legacy boolean;
  affected integer;
begin
  select count(*) = 7 into has_legacy
    from information_schema.columns
   where table_schema = 'public' and table_name = 'auctions'
     and column_name in ('starting_price', 'current_price', 'end_time', 'winner_id',
                         'winning_bid', 'highest_bidder_id', 'bids');

  if has_legacy then
    -- LEGACY PRICE RULE - identical to 006 step 4a (winning bid, else current
    -- highest bid, else starting price).
    execute $sql$
      update public.auctions
         set price = case
               when winner_id is not null
                 then coalesce(winning_bid, current_price, starting_price)
               when highest_bidder_id is not null
                 or (jsonb_typeof(bids) = 'array' and jsonb_array_length(bids) > 0)
                 then coalesce(current_price, starting_price)
               else coalesce(starting_price, current_price)
             end
       where price is null
    $sql$;
    get diagnostics affected = row_count;
    raise notice '007: backfilled price on % row(s)', affected;

    execute format(
      'update public.auctions set expires_at = %s + 2592000000 where status = %L and expires_at is null',
      now_ms, 'active');
    execute format(
      'update public.auctions set expires_at = coalesce(end_time::bigint, %s) where expires_at is null',
      now_ms);

    -- 'ended' with a winner -> sold, at the moment it ended.
    execute format(
      'update public.auctions
          set status = %L,
              sold_at = coalesce(sold_at, end_time::bigint, %s),
              expires_at = least(coalesce(expires_at, %s), coalesce(end_time::bigint, %s))
        where status = %L and (winner_id is not null or sold_at is not null)',
      'sold', now_ms, now_ms, now_ms, 'ended');
    get diagnostics affected = row_count;
    raise notice '007: converted % ended-with-winner row(s) to sold', affected;

    -- 'ended' with no winner -> expired: stored active, expiry never later than now.
    execute format(
      'update public.auctions
          set status = %L,
              expires_at = least(coalesce(expires_at, %s), coalesce(end_time::bigint, %s), %s)
        where status = %L',
      'active', now_ms, now_ms, now_ms, 'ended');
    get diagnostics affected = row_count;
    raise notice '007: converted % ended-without-winner row(s) to expired', affected;
  else
    raise notice '007: legacy columns already dropped - skipping catch-up';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Tighten the status CHECK and validate it against every row
-- ---------------------------------------------------------------------------
-- A readable error first, naming the offending values, instead of Postgres's
-- generic "check constraint is violated by some row".
do $$
declare
  unexpected text;
begin
  select string_agg(distinct coalesce(status, '<NULL>'), ', ') into unexpected
    from public.auctions
   where status is null or status not in ('active', 'sold', 'cancelled', 'hidden');

  if unexpected is not null then
    raise exception '007: auctions.status holds unexpected value(s): %. Fix those rows, then re-run. Nothing was changed.',
      unexpected;
  end if;
end
$$;

alter table public.auctions drop constraint if exists auctions_status_check;

alter table public.auctions
  add constraint auctions_status_check
  check (status in ('active', 'sold', 'cancelled', 'hidden'))
  not valid;

alter table public.auctions validate constraint auctions_status_check;

-- ---------------------------------------------------------------------------
-- 6. NOT NULL on the columns every listing must have
-- ---------------------------------------------------------------------------
-- Fails the whole transaction (dropping nothing) if a NULL survived step 3,
-- which would mean a row with no starting price to take a price from.
alter table public.auctions alter column price set not null;
alter table public.auctions alter column expires_at set not null;

-- ---------------------------------------------------------------------------
-- 7. Indexes that only served the auction ordering
-- ---------------------------------------------------------------------------
-- Both are on (end_time desc, id desc), from 001 and 003. Dropping end_time
-- below would remove them anyway; named here so the intent is explicit.
drop index if exists public.idx_auctions_list_keyset;
drop index if exists public.idx_auctions_list_keyset_visible;

-- ---------------------------------------------------------------------------
-- 8. Drop the bid-era columns
-- ---------------------------------------------------------------------------
alter table public.auctions
  drop column if exists bids,
  drop column if exists bid_version,
  drop column if exists current_price,
  drop column if exists starting_price,
  drop column if exists highest_bidder_id,
  drop column if exists highest_bidder_name,
  drop column if exists winner_id,
  drop column if exists winner_name,
  drop column if exists winning_bid,
  drop column if exists duration_minutes,
  drop column if exists start_time,
  drop column if exists end_time;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION - run these afterwards
-- ---------------------------------------------------------------------------
-- The remaining columns (expect no bid-era names in this list):
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'auctions'
--    order by ordinal_position;
--
-- Status distribution (expect only active / sold / cancelled / hidden):
--   select status, count(*) from public.auctions group by 1 order by 1;
--
-- Functions left in the public schema - review by hand; drop only one you are
-- sure served bidding and that nothing else calls:
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--    order by 1;
--
-- Once the site has run cleanly for a while, the backup from the header can go:
--   drop table if exists backup.auctions_pre007;
