-- ============================================================================
-- 004_money_numeric_and_bid_version.sql
--
-- WHAT THIS DOES
--   1. Converts every money column on `auctions` from `double precision` to
--      `numeric(12,2)`: `current_price`, `starting_price`, `winning_bid`.
--   2. Adds `auctions.bid_version integer not null default 0`, the monotonic
--      counter the bid optimistic lock now guards on instead of a money value.
--
-- WHY
--   `select data_type from information_schema.columns
--      where table_name='auctions' and column_name='current_price';`
--   returns `double precision` on the live database.
--
--   (a) Money in binary floating point is simply wrong. 150.10 has no exact
--       float8 representation, accumulated values drift, and 0.1 + 0.2 <> 0.3.
--       `numeric(12,2)` stores the decimal exactly. 12 digits total with 2 after
--       the point caps a single value at 9,999,999,999.99, far above anything
--       this marketplace lists, and rejects a third decimal place outright.
--
--   (b) The bid path used to guard its UPDATE with
--       `.eq('current_price', <value read from the row>)` - exact equality on a
--       float8, across a read -> JSON -> JS number -> PostgREST text filter ->
--       float8 parse round trip. Nothing in that chain guarantees identical bits
--       for a value that is not exactly representable in binary: it depends on
--       the server's float output precision (`extra_float_digits`), on the
--       driver's number formatting, and on values that need all 17 significant
--       digits to round-trip. Whole-pound bids survive it; pence values can fail
--       the guard on a completely uncontended bid, burn all three retries, and
--       answer 409 BID_CONFLICT. Statement 2 below replaces that predicate with
--       an integer, which is exact under every one of those conditions.
--
-- ON THE `bids` JSONB ARRAY - NO TREATMENT NEEDED, AND NONE IS APPLIED HERE.
--   Each entry in `auctions.bids` carries its own `amount` as a JSON number, so
--   the obvious question is whether those drift the same way. They do not, for
--   two independent reasons:
--
--   1. `jsonb` does not store numbers as floats. A JSON number inside a jsonb
--      value is stored in Postgres's own `numeric` representation, so the
--      decimal 150.10 written into the array comes back out as the decimal
--      150.10. It was never binary floating point to begin with.
--
--   2. More importantly, nothing compares these amounts for exact equality
--      against a database predicate. The application reads them in JavaScript
--      and only ever does ordering work on them - picking the largest amount in
--      `resolveWinner`, and `>` / `<=` bid validation. Ordering over doubles is
--      deterministic and order-preserving for distinct 2dp decimals in this
--      range, so the float round trip cannot reorder two different bids. The
--      exactness problem only bites `=`, and there is no `=` on these values.
--
--   So the array is left exactly as it is. Rewriting it would be a large jsonb
--   update that buys nothing.
--
-- ORDER: run this FOURTH and LAST. The full run order for this change set is
--   001_listing_lifecycle_and_list_payload.sql
--   002_user_email_and_password_reset.sql
--   003_moderation_and_admin.sql
--   004_money_numeric_and_bid_version.sql
--
-- REQUIRED BEFORE DEPLOY, the same as 001. The Worker writes `bid_version` on
-- every successful bid; until this migration has run that column does not
-- exist. The Worker tolerates its absence (see below) rather than failing, but
-- while the column is missing the bid lock silently falls back to the old,
-- fragile float guard - which is the bug this change set exists to remove. Run
-- this BEFORE shipping the Worker.
--
-- BACKWARD / FORWARD COMPATIBILITY. The application reads `bid_version` off the
-- row and, when it is absent or NULL, falls back to the previous
-- `current_price` guard instead of dropping the guard. So:
--   - Worker deployed before this migration: old float guard, same behaviour as
--     today. Correct, just fragile.
--   - This migration run before the Worker is deployed: rows all hold 0 from the
--     DEFAULT, the old Worker ignores the column, nothing breaks.
--   - Either order is safe. Neither order corrupts data.
--
-- SAFE TO RE-RUN. Statement 1 inspects `information_schema.columns` and skips
-- any column already `numeric`; a second run is a no-op. Statement 2 is guarded
-- with IF NOT EXISTS.
--
-- LOCKING - READ THIS BEFORE RUNNING IT ON A BUSY TABLE. Unlike 001-003 this
-- migration is NOT purely additive. `alter column ... type` rewrites the table
-- and holds an ACCESS EXCLUSIVE lock for the duration, blocking reads and
-- writes. `auctions` is small, so this is seconds, but run it in a quiet
-- moment. If the ALTER fails with a dependency error, something references
-- these columns - a view, an index, or a generated column. The only generated
-- column on this table, `image_count` from 001, derives from `image_urls` and
-- is unaffected; no index in 001-003 covers a price column.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. float8 -> numeric(12,2) for every money column on `auctions`
-- ---------------------------------------------------------------------------

-- `round(<col>::numeric, 2)` is doing real work here, not decoration. Casting a
-- float8 straight to numeric carries the float's noise into the decimal: the
-- stored double nearest 150.10 is 150.09999999999999431..., and a bare
-- `::numeric(12,2)` would be at the mercy of that. Rounding to 2dp first lands
-- every existing row on the clean pence value the user actually entered.
--
-- The loop skips any column whose data_type is already 'numeric', which is what
-- makes a second run a no-op.
do $$
declare
  target_column text;
begin
  foreach target_column in array array['current_price', 'starting_price', 'winning_bid']
  loop
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'auctions'
        and column_name = target_column
        and data_type <> 'numeric'
    ) then
      execute format(
        'alter table public.auctions alter column %I type numeric(12,2) using round(%I::numeric, 2)',
        target_column,
        target_column
      );
      raise notice 'converted auctions.% to numeric(12,2)', target_column;
    else
      raise notice 'auctions.% already numeric (or absent) - skipped', target_column;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The optimistic-lock version counter
-- ---------------------------------------------------------------------------

-- Incremented by exactly one on every successful bid. The bid UPDATE guards on
-- `bid_version = <the value it read>`, so a bid that lands between another
-- writer's read and its write makes that writer's UPDATE match zero rows and
-- retry, instead of clobbering the `bids` array it never saw.
--
-- An integer equality predicate cannot be defeated by representation: there is
-- no rounding, no precision setting, and no text-formatting step that can turn
-- 7 into something that is not 7. That is the entire point of moving the guard
-- off the price.
--
-- NOT NULL with a DEFAULT, so every pre-existing row is backfilled to 0 by
-- Postgres itself and no row is rejected. integer, not bigint: 2.1 billion bids
-- on one listing is not a scenario.
alter table public.auctions
  add column if not exists bid_version integer not null default 0;

-- ---------------------------------------------------------------------------
-- VERIFICATION - run this afterwards to confirm the new types
-- ---------------------------------------------------------------------------
-- Expect exactly four rows:
--   bid_version     | integer | (null) | (null) | 32 | 0
--   current_price   | numeric | 12     | 2      |    |
--   starting_price  | numeric | 12     | 2      |    |
--   winning_bid     | numeric | 12     | 2      |    |
--
-- Any row still reading 'double precision' means the ALTER did not apply to
-- that column and the bid path is still exposed.
--
-- select column_name,
--        data_type,
--        numeric_precision,
--        numeric_scale,
--        is_nullable,
--        column_default
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'auctions'
--    and column_name in ('current_price', 'starting_price', 'winning_bid', 'bid_version')
--  order by column_name;
--
-- And confirm no money column anywhere on the table was missed - this should
-- return zero rows:
--
-- select column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'auctions'
--    and data_type in ('double precision', 'real');
