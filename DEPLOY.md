# Deploying MSA Auction

This is a step-by-step runbook for shipping the current working tree to
production (`https://msa-auction.msasoton.workers.dev/`). Follow it in order.
Every command is copy-pasteable. Do not skip the verification line after a
step — if it does not match, stop and fix it before moving on.

---

## DANGER: never run the local dev server against this database

**`npm run dev` (and `npm start`) will permanently delete photos from every
listing older than 90 days, seconds after the process starts.**

`server.ts` runs `cleanupStaleImages()` on startup and then again every 6
hours. It selects every auction with `created_at` older than 90 days and, for
any that still has an image, sets `image_url = null` and `image_urls = '[]'`.
That is not a bug you can catch after the fact — there is no R2 bucket, no
backup, and no separate copy. Images are base64 data URLs stored directly in
the `auctions` row, so once they're nulled out they are gone.

The reason this is so easy to trigger by accident: **there is no separate
development database.** `.env`, `.dev.vars`, and `wrangler.toml` all point at
the exact same Supabase project (`ygyvsowniuoszlsahrvl`). Booting `server.ts`
on your laptop with `npm run dev` talks to production, not a sandbox.

**Nothing in this document ever asks you to run `npm run dev` or `npm
start`.** Only use `npm run lint`, `npm test`, and `npm run build` — none of
them open a database connection or execute `server.ts`; `npm run build` only
bundles it into a file, it does not run it. If a step ever seems to imply
otherwise, stop and re-read it.

---

## 1. What this deploy contains, and what has (and hasn't) been verified

This ships a large, previously-undeployed change set: four new database
migrations, image payloads removed from the auction list response, password
reset, admin/moderation tooling, and a fix to the bid optimistic lock (money
columns move from `double precision` to `numeric(12,2)`, guarded by a new
`bid_version` counter instead of a float comparison).

**Verified:** `npm run lint` (`tsc --noEmit`) exits 0, and `npm test`
(`vitest run`) passes all 280 tests as of writing this document.

**NOT verified:** every one of those 280 tests runs against an in-memory fake
of Supabase (`tests/unit/helpers/fake-supabase.ts`), not real Postgres. None
of the four migrations have ever been run against the live database. The bid
lock in particular has never been exercised against real Postgres row
locking, real PostgREST, or a real pence-denominated value. Treat the
post-deploy verification checklist in section 6 as mandatory, not optional —
it is the only thing standing in for that missing coverage.

---

## 2. Pre-flight checklist

Do all of this before touching the database or running `wrangler deploy`.

1. **Have ready:** access to the Supabase SQL editor for this project, a
   Cloudflare account authenticated for this Worker (`npx wrangler login` if
   you haven't already), the value of the Supabase service role key (from the
   Supabase dashboard → Project Settings → API), a test account username and
   password you're willing to use for the post-deploy bid test, and a second
   test account for the same. Set aside 20-30 minutes uninterrupted — you do
   not want to leave the migrations half-applied.

2. **Commit to a branch first.** Do not deploy out of an uncommitted working
   tree. From the repo root:
   ```
   git checkout -b deploy/2026-09-20
   git add -A
   git commit -m "Deploy: lifecycle, moderation, password reset, money fix"
   ```
   (Adjust the branch name/date. Review `git status` before the `add -A` —
   make sure nothing that looks like a secret is about to be staged.)

3. **Confirm the test suite passes locally:**
   ```
   npm run lint
   npm test
   ```
   `lint` should print nothing and exit 0. `test` should end with
   `Tests  280 passed (280)` (or all-passed with whatever the current total
   is — a failing or reduced count means don't proceed).

4. **Record the current deployment**, so you have something to roll back to:
   ```
   npx wrangler deployments list
   ```
   Copy the version ID at the top of the list somewhere safe (a notes app, a
   comment in your terminal history) before you deploy anything new.

5. **Check the sub-penny condition ahead of migration 004** (full detail in
   section 3.4, but do this now so you're not stuck mid-run):
   ```sql
   select count(*) from auctions where current_price <> round(current_price::numeric, 2);
   ```
   If this returns anything other than `0`, stop here — do not run migration
   004 — and ask before proceeding. See section 3.4 for what a non-zero
   result means.

6. **Check for auctions that must not settle.** Deploying activates
   settlement (see section 5's cron warning) for every already-expired
   auction in one batch, immediately and irreversibly. Look at the live site
   now for any listing that has already ended, or is about to, that should
   NOT be resolved with a winner (e.g. it was a mistake, or the seller backed
   out). If you find one, deal with it before you deploy — today's live site
   has no cancel/hide feature yet, so this may mean asking a committee member
   with direct Supabase access to update that one row's `status` column by
   hand, or simply accepting it will settle.

---

## 3. Migrations

Run these against the Supabase SQL editor for the project, **in this order:
001, 002, 003, 004.** Every one of them is written to be safe to re-run except
where noted for 004. For each, open the file in `migrations/`, copy the whole
thing, paste it into the SQL editor, and run it — the excerpts below are the
load-bearing statements, not a substitute for reading the file's own comments
if something looks off.

### 3.1 `001_listing_lifecycle_and_list_payload.sql`

**What it does:** adds a generated `auctions.image_count` column, plus two
indexes for the new keyset-paginated listing query.

**Why it must run before deploy:** the new `GET /api/auctions` query selects
`image_count` explicitly. Without this column, Postgres returns error 42703
(undefined column), the endpoint 500s, and the homepage renders empty for
every visitor.

**Verify:**
```sql
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'auctions' and column_name = 'image_count';
```
Expect one row: `image_count | integer`.

**Rollback** (only if something is visibly wrong — it's additive and safe to
leave in place otherwise):
```sql
drop index if exists idx_auctions_seller_active;
drop index if exists idx_auctions_list_keyset;
alter table public.auctions drop column if exists image_count;
```

### 3.2 `002_user_email_and_password_reset.sql`

**What it does:** adds `users.email` (case-insensitive unique), plus
`reset_token_hash` and `reset_token_expires` for password recovery.

**Why it must run before deploy:** without these columns, the email and
password-reset routes 500 on the missing column. Login, registration, and
everything else keep working — this is not a hard blocker, only a feature
gap, but there is no reason to skip it.

**Verify:**
```sql
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'users'
   and column_name in ('email', 'reset_token_hash', 'reset_token_expires')
 order by column_name;
```
Expect three rows: `email` (text), `reset_token_expires` (bigint),
`reset_token_hash` (text).

**Rollback:**
```sql
drop index if exists idx_users_reset_token_expires;
drop index if exists idx_users_reset_token_hash;
drop index if exists idx_users_email_ci;
alter table public.users drop column if exists reset_token_expires;
alter table public.users drop column if exists reset_token_hash;
alter table public.users drop column if exists email;
```

### 3.3 `003_moderation_and_admin.sql`

**What it does:** adds `users.role` / `banned_at` / `banned_reason`, a
`reports` table, and `hidden_reason` / `hidden_by` / `hidden_at` on
`auctions`.

**Why it must run before deploy:** without `users.role`, every `/api/admin/*`
route 500s, and reporting a listing 500s on the missing `reports` table.

**Verify:**
```sql
select column_name, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'users' and column_name = 'role';

select to_regclass('public.reports');

select column_name
  from information_schema.columns
 where table_schema = 'public' and table_name = 'auctions'
   and column_name in ('hidden_reason', 'hidden_by', 'hidden_at')
 order by column_name;
```
Expect `role` to default to `'member'`, `to_regclass` to return `reports`
(not null), and all three `hidden_*` columns to be present.

**Rollback:**
```sql
drop index if exists idx_auctions_list_keyset_visible;
alter table public.auctions drop column if exists hidden_at;
alter table public.auctions drop column if exists hidden_by;
alter table public.auctions drop column if exists hidden_reason;
drop table if exists public.reports;
drop index if exists idx_users_role;
alter table public.users drop column if exists banned_reason;
alter table public.users drop column if exists banned_at;
alter table public.users drop column if exists role;
```
Note: if you've already appointed an admin (section 4) before you roll this
back, that assignment is dropped along with the column and has to be redone
after re-running 003.

### 3.4 `004_money_numeric_and_bid_version.sql` — read this one fully before running it

This is the only migration in the set that is **not purely additive**. It
converts `auctions.current_price`, `starting_price`, and `winning_bid` from
`double precision` to `numeric(12,2)`, and adds `bid_version integer not null
default 0`.

**Why this exists:** the database currently stores money as floating point.
Binary floating point cannot represent most decimal amounts exactly — 150.10
has no exact `double precision` representation — so values can drift, and the
bid lock's old guard (an exact equality check on that float) could fail on a
perfectly normal, uncontested pence-value bid and wrongly report a conflict.
`numeric(12,2)` stores the decimal exactly instead of approximating it.

**Before running it — check for sub-penny data.** The conversion rounds every
value to 2 decimal places. If any row already holds a value with a third
decimal place, the round trip silently changes it. Run this first (you should
already have run it in pre-flight step 5):
```sql
select count(*) from auctions where current_price <> round(current_price::numeric, 2);
```
If this returns `0`, proceed. **If it returns anything else, stop and ask
before running this migration** — do not decide unilaterally to round away
someone's data.

**Locking — run it in a quiet moment.** Unlike 001-003, this migration
rewrites the table under an `ACCESS EXCLUSIVE` lock for its duration, which
blocks all reads and writes on `auctions`. The table is small so this should
take seconds, not minutes, but avoid running it in the middle of active
bidding.

**Why it must run before deploy:** the Worker writes `bid_version` on every
successful bid. The application code tolerates the column being absent — it
falls back to the old float-based guard rather than failing outright — so a
Worker deployed ahead of this migration will not error. It will just still
carry the exact bug this migration exists to fix. Run it before shipping the
Worker, same as 001.

**Verify:**
```sql
select column_name, data_type, numeric_precision, numeric_scale, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'auctions'
   and column_name in ('current_price', 'starting_price', 'winning_bid', 'bid_version')
 order by column_name;
```
Expect `current_price`, `starting_price`, `winning_bid` all `numeric` with
precision 12 / scale 2, and `bid_version` as `integer` defaulting to `0`. Then
confirm nothing was missed:
```sql
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'auctions'
   and data_type in ('double precision', 'real');
```
Expect zero rows.

**Rollback:** the migration's own comments document that either run order
relative to the Worker deploy is safe and that leaving this migration in
place does not corrupt data — so reverting it should rarely be necessary. If
you do need to, this has **not** been tested against a live database, unlike
the forward migration:
```sql
alter table public.auctions alter column current_price type double precision using current_price::double precision;
alter table public.auctions alter column starting_price type double precision using starting_price::double precision;
alter table public.auctions alter column winning_bid type double precision using winning_bid::double precision;
alter table public.auctions drop column if exists bid_version;
```
This carries the same `ACCESS EXCLUSIVE` lock as the forward migration — run
it in a quiet moment too, and only alongside rolling the Worker back to a
version that predates this change set.

---

## 4. Appoint the first admin

There is deliberately no route in the application that grants admin — a
self-service "make me admin" endpoint would be the whole vulnerability. You
have to do this by hand, in the SQL editor, and it must happen before you
deploy (the admin panel and moderation tools go live the moment the new
Worker ships, and you want an admin account ready to use them).

1. Open `migrations/003_moderation_and_admin.sql` and find the commented-out
   line near the bottom (section 5). Copy it out, edit the username, and run
   it on its own — usernames are stored **lowercased**:
   ```sql
   update public.users set role = 'admin' where username = 'your-lowercase-username';
   ```
2. Verify:
   ```sql
   select username, role from public.users where role = 'admin';
   ```
   Expect one row with your username.

If it returns zero rows, the username didn't match. Find the real stored
value with:
```sql
select username from public.users order by created_at desc limit 20;
```
and re-run the `update` with the exact (lowercased) value from that list.

---

## 5. Build and deploy

1. From the branch you committed in pre-flight step 2, build:
   ```
   npm run build
   ```
   This runs `vite build` (produces `./dist`, which `wrangler.toml` serves as
   static assets) and bundles `server.ts` into `dist/server.cjs` for local
   use — that bundling step does not execute anything, it's safe.

2. If this is the first time deploying this Worker, or the secret has never
   been set, set the Supabase service role key as an encrypted secret (skip
   if it's already configured in the Cloudflare dashboard for this Worker):
   ```
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   ```
   Paste the key when prompted. Never put this value in `wrangler.toml` —
   everything under `[vars]` there is plaintext, committed to git, and
   visible in the dashboard.

3. **Read this before you run the deploy command.** `wrangler.toml` sets
   `crons = ["* * * * *"]`. This is the first time this cron has ever been
   active. Within about a minute of deploying — and possibly sooner, since
   the auction list endpoint also settles on-demand on its first request —
   every auction whose end time has already passed gets swept into `ended`
   and assigned a winner, all at once. This is correct behaviour, but it is
   irreversible: anything that must not settle needs to have been dealt with
   in pre-flight step 6, before this point, not after.

4. Deploy:
   ```
   npx wrangler deploy
   ```
   Watch the output for the deployed URL and a version ID; note the version
   ID alongside the one you recorded in pre-flight step 4.

5. **Tell the society to reload.** Anyone with the site open in a tab from
   before this deploy is running old client code that expects image data
   directly in the auction list response. Against the new API they will see
   placeholder images and at most 24 listings until they refresh the page.
   Post a heads-up (Discord, WhatsApp, wherever the committee already talks
   to members) asking people to reload if anything looks broken, before the
   bug reports start arriving.

---

## 6. Post-deploy verification

Run every one of these. This is the only check standing in for the fact that
none of the 280 automated tests ran against a real database.

1. **Auction list envelope and payload shape:**
   ```
   curl -s https://msa-auction.msasoton.workers.dev/api/auctions
   ```
   Pass: valid JSON shaped like `{"auctions": [...], "nextCursor": ...}`, and
   no `imageUrl` or `imageUrls` key anywhere in it (grep for `imageUrl` on the
   output — expect no match). Fail: a 500, an empty page when listings
   clearly exist, or image data present in the response.

2. **Admin route rejects a non-admin token.** Log in as an ordinary (non-admin)
   account and call an admin route with its token:
   ```
   curl -s -X POST https://msa-auction.msasoton.workers.dev/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"username":"<non-admin-username>","password":"<password>"}'
   ```
   Take the `token` from the response, then:
   ```
   curl -s -o /dev/null -w "%{http_code}\n" \
     https://msa-auction.msasoton.workers.dev/api/admin/reports \
     -H "Authorization: Bearer <token>"
   ```
   Pass: `403`, with body code `NOT_ADMIN`. Fail: `200`, or anything that
   isn't `403`.

3. **The pence bid — the one check nothing else substitutes for.** From two
   different test accounts, bid on the same live auction: first £150.10, then
   from the second account £150.20 (both strictly above the current price).
   ```
   curl -s -X POST https://msa-auction.msasoton.workers.dev/api/auctions/<auction-id>/bids \
     -H "Authorization: Bearer <token-1>" -H "Content-Type: application/json" \
     -d '{"amount": 150.10}'

   curl -s -X POST https://msa-auction.msasoton.workers.dev/api/auctions/<auction-id>/bids \
     -H "Authorization: Bearer <token-2>" -H "Content-Type: application/json" \
     -d '{"amount": 150.20}'
   ```
   Pass: both return `200` with the new price reflected. **Fail: a `409
   BID_CONFLICT` on either of these uncontended bids means the optimistic
   lock is broken against real Postgres — stop and roll back immediately**
   (section 7), you should not leave this live.

4. **Settlement is running.** Tail the live logs:
   ```
   npx wrangler tail
   ```
   Within a minute (sooner if an auction has already expired), expect a line
   like `[Settle] Ended N auction(s).` Pass: that line appears. Fail: nothing
   after several minutes with a known-expired auction sitting there — check
   the Worker logs for an error instead.

5. **Open Graph tags on a shared link.** Pick any live auction id from the
   list in check 1, then:
   ```
   curl -s https://msa-auction.msasoton.workers.dev/auction/<auction-id> | grep -i "og:title"
   ```
   Pass: an `<meta property="og:title" content="...">` tag containing that
   auction's actual title, not the generic site title.

---

## 7. Rollback

To revert the Worker to the version you recorded in pre-flight step 4:
```
npx wrangler rollback <version-id>
```

**Migrations 001, 002, and 003 are purely additive** (new nullable columns,
a new table, new indexes) — they are safe to leave in place no matter which
Worker version is running. There is no need to reverse them just because you
rolled the Worker back.

**Migration 004 is the one to think about**, because it changes the type of
columns an older Worker also reads. Its own comments assert that either
run-order relative to the Worker is safe and that no data is lost either way
— which is why leaving it in place after a rollback should be fine in the
normal case. That said, this specific scenario (rolling the Worker back to a
pre-004 version while 004 has already been applied) has not been tested
against a live database as part of this deploy. If you roll the Worker back
and immediately see bidding behave strangely, that is the first thing to
suspect, and the rollback SQL is in section 3.4.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Homepage is empty / `GET /api/auctions` returns 500 | Migration 001 wasn't run before deploy — `image_count` doesn't exist | Run migration 001 (section 3.1), then re-check the endpoint |
| Every bid returns `409 BID_CONFLICT`, even uncontested ones | Migration 004 wasn't run, or the optimistic lock is broken against real Postgres | Confirm migration 004 ran (section 3.4 verify query); if it has and the conflicts persist, roll back the Worker (section 7) |
| Admin panel doesn't appear for your account | No row has `role = 'admin'` yet, or you logged in before appointing yourself | Re-run section 4, then log out and back in so the client fetches your current role |
| Password reset links never arrive | There is no mail provider wired up yet — this is a known, interim gap | Use `GET /api/admin/reset-requests` (requires an admin token) to read the pending token and hand the reset link to the student directly |
| Reporting a listing returns a 500 | Migration 003 wasn't run — the `reports` table doesn't exist | Run migration 003 (section 3.3) |
| Listing photos have vanished from older auctions | Someone ran `npm run dev` (or `npm start`) locally, which triggered `cleanupStaleImages()` against the production database | There is no recovery — the images are gone. Prevent it going forward: never run the local server against these credentials; see the warning at the top of this document |

---

## 9. After this deploy

- **Delete `GET /api/admin/reset-requests`** once a real mail provider is
  wired up for password resets. It exists only as an interim way for an
  admin to hand a reset link to a student directly (see the comment above the
  route in `workers/index.ts`); it is not something that should stay in a
  production API long-term.
- **Outstanding work:** a real mail provider for password reset emails, and
  moving image storage off base64-in-Postgres and onto something like
  Cloudflare R2 — both because of the storage cost and because it removes the
  single-copy-with-no-backup risk this document just warned you about.
