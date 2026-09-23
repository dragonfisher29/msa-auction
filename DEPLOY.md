# Deploying MSA Auction

This is a step-by-step runbook for shipping the current working tree to
production (`https://msa-auction.msasoton.workers.dev/`). Follow it in order.
Do not skip the verification line after a step — if it does not match, stop
and fix it before moving on.

**Deploys go through the Cloudflare dashboard, not a CLI.** The Worker is
connected to this repo's GitHub via Cloudflare **Workers Builds**: every push
or merge to `main` triggers a build and deploy on Cloudflare's own servers.
You never run a deploy command yourself. The only exception is `npx wrangler
dev` for local development (Appendix A.5), which is unrelated to shipping to
production.

---

## DANGER: the local dev server runs against the production database

**There is no separate development database.** `.env`, `.dev.vars`, and
`wrangler.toml` all point at the exact same Supabase project
(`ygyvsowniuoszlsahrvl`). Booting `server.ts` on your laptop with `npm run
dev` talks to production, not a sandbox. Every row you touch locally is a row
a student can see.

### The photo-deleting sweep now runs daily, in production, on purpose

`cleanupStaleImages()` (`workers/shared.ts`) finds every listing that is no
longer active — ended, cancelled, or hidden, never one still running — whose
`end_time` is more than 30 days in the past and that still has an image, and
sets `image_url = null` and `image_urls = '[]'` on it. Images are base64 data
URLs stored directly in the `auctions` row, and there is no backup and no
second copy, so once they are nulled out they are gone. This is an
**owner-approved retention policy**, not an accident: the committee agreed
that a listing's photos do not need to survive a month after it ends. The
committee should tell sellers this up front — e.g. in whatever page or message
explains how listing a sold/expired item works.

**It runs once a day in the Worker**, via the second cron in `wrangler.toml`'s
`[triggers]` (`0 3 * * *`, i.e. 03:00 **UTC** — Cloudflare cron schedules
always run in UTC, not local time), and is enabled through `[vars]`:

```
ENABLE_STALE_IMAGE_CLEANUP = "true"
```

Only the literal string `"true"` enables it. **To turn it off:** set that to
`"false"` in `wrangler.toml` and merge to `main` — the next deploy carries the
change. An active listing is never touched, no matter how old, regardless of
this setting.

**The local dev server has its own, separate copy of the same gate**, read
from `.env` (not `wrangler.toml`) and **off by default** — see
`STALE_IMAGE_CLEANUP_ENV` in `maintenance.ts`. This is deliberate: `.env`,
`.dev.vars`, and `wrangler.toml` all point at the exact same Supabase project
(see the warning above), so a dev-server sweep running unprompted against
production is a much worse failure mode than a daily production cron running
the policy the committee actually asked for. Leave `.env`'s
`ENABLE_STALE_IMAGE_CLEANUP` unset unless you are deliberately testing this
locally against production data (you almost never want that — see the DANGER
note above).

**Nothing in this document ever asks you to run `npm run dev` or `npm
start`.** Only use `npm run lint`, `npm test`, and `npm run build` — none of
them open a database connection or execute `server.ts`; `npm run build` only
bundles it into a file, it does not run it.

---

## 1. What this deploy contains, and what has (and hasn't) been verified

This ships a large change set: five database migrations, image payloads
removed from both the auction list **and** the bid response (images now load
once via the dedicated images route, which is a large cut in Supabase
egress), a hardened settlement job, tighter bid/cancel/edit rules, seller
phone numbers gated to signed-in users, and row level security enabled on the
core tables. In detail:

- **No route but the images route returns image data.** `GET /api/auctions`,
  `GET /api/auctions/:id`, and the bid response all carry only `imageCount` (or
  no image field at all) — a card or detail view fetches photos separately from
  `GET /api/auctions/:id/images`, and that response is cached for the rest of
  the session.
- **Settlement is more robust.** The cron job reads its columns by name, caps
  each run at 20 auctions, and one failing row is logged and skipped rather
  than blocking the rest of the batch.
- **Lazy settle was removed from `GET /api/auctions`, `/api/notifications`, and
  `/api/users/me/activity`.** Only the single-auction read (`GET
  /api/auctions/:id`) still settles on demand. Practical effect: a win/loss
  notification, or an auction disappearing from someone's "My Bids" list as
  settled, can now lag up to about a minute behind the actual end time, until
  the once-a-minute cron catches it.
- **Bids are rejected** on a cancelled or hidden listing, and if the listing's
  status or `end_time` changed between the bidder loading the page and
  submitting the bid.
- **Cancel and edit are refused once `end_time` has passed**, even if the
  cron hasn't settled the row yet.
- **The seller's phone number is gone from the public list** and only appears
  on the auction detail response for a signed-in, authenticated request.
- **`migrations/005_enable_rls.sql` is new** — see section 3.5. It enables row
  level security on `users`, `auctions`, and `reports` with no policies added;
  safe because the Worker always authenticates with the service-role key,
  which bypasses RLS.
- **Migration 004 is required before this version**, same as before — see
  section 3.4. **The owner has confirmed 004 is already applied on
  production**, so this is a check, not a new step, for this deploy.
- **New listing photos are much smaller.** Client-side compression now targets
  1024px on the long edge (was 1600px) and always outputs JPEG, so a typical
  phone photo lands around 100-150KB instead of up to ~1.9MB — see
  `src/lib/images.ts`. The server also rejects a brand-new inline image over
  300KB (400 `IMAGE_TOO_LARGE` on `POST`/`PATCH /api/auctions`), except
  when it is byte-identical to an image already stored on that listing, so
  editing an old, larger listing is never blocked by its own existing photos.
  This does not touch or resize any image already stored.
- **The `image_url` mirror column is no longer duplicated with a full base64
  image.** On create/edit it is only written when the first image is a stored
  `/images/<key>` path (needed for the Open Graph share preview once R2 is
  on); a `data:` URL first image now leaves it `null`, and every reader falls
  back to `image_urls[0]`. No migration touches existing rows.
- **A second daily cron now runs the stale-image cleanup sweep in
  production** — see "The photo-deleting sweep now runs daily" above.

**Verified:** `npm run lint` (`tsc --noEmit`) exits 0, and `npm test`
(`vitest run`) passes the whole suite — 397 tests at the time of writing. That
total moves as tests are added; what matters is that none fail and that the
count does not go *down*.

**NOT verified:** every one of those tests runs against an in-memory fake
of Supabase (`tests/unit/helpers/fake-supabase.ts`), not real Postgres. The bid
lock in particular has never been exercised against real Postgres row
locking, real PostgREST, or a real pence-denominated value. Treat the
post-deploy verification checklist in section 6 as mandatory, not optional —
it is the only thing standing in for that missing coverage.

---

## 2. Pre-flight checklist

**Remember: on this project, merging a branch to `main` on GitHub deploys it.**
Do all of this before you open that merge — not after.

1. **Have ready:** access to the Supabase SQL editor for this project, access
   to the Cloudflare dashboard for this account, the value of the Supabase
   service role key (from the Supabase dashboard → Project Settings → API), a
   test account username and password you're willing to use for the
   post-deploy bid test, and a second test account for the same. Set aside
   20-30 minutes uninterrupted — you do not want to leave the migrations
   half-applied.

2. **Work on a branch, then open a pull request.** Do not push straight to
   `main` — a push to `main` deploys immediately, before anyone has looked at
   it. From the repo root:
   ```
   git checkout -b deploy/2026-09-20
   git add -A
   git commit -m "Deploy: lifecycle, moderation, settlement hardening, RLS"
   git push -u origin deploy/2026-09-20
   ```
   Then open a pull request on GitHub from that branch into `main`. (Adjust
   the branch name/date. Review `git status` before the `add -A` — make sure
   nothing that looks like a secret is about to be staged.)

3. **Confirm the test suite passes locally:**
   ```
   npm run lint
   npm test
   ```
   `lint` should print nothing and exit 0. `test` should end with
   `Tests  357 passed (357)` (or all-passed with whatever the current total
   is — a failing or reduced count means don't proceed).

4. **Record the current deployment**, so you have something to roll back to.
   Dashboard → **Workers & Pages → msa-auction → Deployments**. Copy the
   version ID (or note the timestamp) at the top of the list somewhere safe
   before you merge anything new.

5. **Check the sub-penny condition ahead of migration 004** (full detail in
   section 3.4, but do this now so you're not stuck mid-run):
   ```sql
   select count(*) from auctions where current_price <> round(current_price::numeric, 2);
   ```
   If this returns anything other than `0`, stop here — do not run migration
   004 — and ask before proceeding. See section 3.4 for what a non-zero
   result means. If you have already confirmed 004 is applied on production
   (see section 1), this check is informational only — it cannot be undone by
   not merging.

6. **Check for auctions that must not settle, before you merge.** Merging
   this branch activates settlement's new rules for every already-expired
   auction, and that resolution is irreversible. Look at the live site now
   for any listing that has already ended, or is about to, that should NOT be
   resolved with a winner (e.g. it was a mistake, or the seller backed out).
   If you find one, deal with it before you merge — cancel or hide it from
   the live site if it hasn't already ended, or ask a committee member with
   Supabase dashboard access to update that one row's `status` column by
   hand, or simply accept it will settle.

---

## 3. Migrations

Run these against the Supabase SQL editor for the project, **in this order:
001, 002, 003, 004, 005.** Every one of them is written to be safe to re-run
except where noted for 004. For each, open the file in `migrations/`, copy the
whole thing, paste it into the SQL editor, and run it — the excerpts below are
the load-bearing statements, not a substitute for reading the file's own
comments if something looks off.

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
successful bid. The application code used to tolerate the column being absent
— it fell back to the old float-based guard rather than failing outright — but
this version's bid, settle, and hide-listing code paths now select
`bid_version` **by name** (`BID_READ_COLUMNS` / `SETTLE_READ_COLUMNS` in
`workers/shared.ts`, and the hide route's own fetch), rather than via
`select('*')`. Naming a column PostgREST does not have errors the whole query
with 42703 (undefined column) instead of silently omitting it, so this is now
a **hard blocker**: run this migration before deploying this version, or
every bid, every settle (cron and lazy), and every admin hide will 500.

**This migration is REQUIRED before deploying this version** — see above.

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

### 3.5 `005_enable_rls.sql`

**What it does:** turns on row level security on `public.users`,
`public.auctions`, and `public.reports`. No policies are added.

**Why it must run before deploy:** with RLS off, the anon key (which ships in
this repo's client bundle and is not a secret) has default `select` access to
every row in these tables — including `users.token`, the bearer credential
the whole session scheme is built on. The Worker authenticates with the
service role key, which **bypasses RLS entirely**, so this migration changes
nothing about how the app itself behaves; it only blocks the anon/authenticated
keys, which this app never uses, from reading the tables directly.

**Verify:**
```sql
select tablename, rowsecurity
  from pg_tables
 where schemaname = 'public' and tablename in ('users', 'auctions', 'reports')
 order by tablename;
```
Expect `rowsecurity = true` on all three rows, and the app to keep working
exactly as before.

**Rollback** (only if the Worker starts erroring post-deploy and you suspect
this migration — check the service-role-key theory in the migration's own
comments first):
```sql
alter table public.users disable row level security;
alter table public.auctions disable row level security;
alter table public.reports disable row level security;
```

---

## 4. Appoint the first admin

There is deliberately no route in the application that grants admin — a
self-service "make me admin" endpoint would be the whole vulnerability. You
have to do this by hand, in the SQL editor, and it must happen before you
merge (the admin panel and moderation tools go live the moment the new
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

Deploys run on Cloudflare's own build servers, triggered by a push or merge to
`main` on GitHub. You never run a build or deploy command against production
yourself.

### 5.1 One-time setup — skip if Workers Builds is already connected

Check first: dashboard → **Workers & Pages → msa-auction → Settings →
Builds**. If it already shows a connected GitHub repository, skip to 5.2.
Otherwise:

1. In that same **Settings → Builds** tab, click **Connect** (or **Connect to
   Git**).
2. Choose **GitHub**, and authorize the Cloudflare Workers Builds GitHub App
   for the `dragonfisher29/msa-auction` repository if prompted.
3. Set **Production branch** to `main`.
4. Set **Build command** to `npm run build`.
5. Leave **Deploy command** at its default. Cloudflare runs it on its own
   build infrastructure after the build succeeds — you never type this
   command or watch it run locally.
6. Set **Root directory** to `/`.
7. Save. The **Worker name** shown in the dashboard for this project must be
   exactly `msa-auction`, matching `name = "msa-auction"` in `wrangler.toml`
   — if it doesn't match, builds fail.

### 5.2 Every deploy: set the secret (only if it isn't already set)

Dashboard → **Workers & Pages → msa-auction → Settings → Variables and
Secrets → Add → Secret**, name `SUPABASE_SERVICE_ROLE_KEY`, paste the key,
save. Skip this if it's already configured — check the same list first.

Never put this value in `wrangler.toml`'s `[vars]` block — everything there
is plaintext, committed to git, and visible in the dashboard. Note the
reverse direction too: `[vars]` in `wrangler.toml` is the source of truth for
plaintext configuration and **overwrites** any plaintext variable you set in
the dashboard on every build. So edit plaintext vars (`SUPABASE_URL`,
`MAX_LISTINGS_PER_USER`) in `wrangler.toml`, and edit secrets only in the
dashboard.

### 5.3 Read this before you merge the pull request

`wrangler.toml` sets `crons = ["* * * * *", "0 3 * * *"]` — two schedules,
both handled by `scheduled()` in `workers/index.ts`, which tells them apart by
`event.cron` (see the section above on the photo-deleting sweep). **Cloudflare
cron schedules run in UTC**, not in the timezone whoever reads this happens to
be in: `0 3 * * *` is 03:00 UTC every day, which is during the UK's early
hours whether the clocks are on GMT or BST.

- `* * * * *` (every minute) — settlement, unchanged in shape from before this
  deploy but with different internals: batched, per-row error handling, and no
  longer triggered lazily from the list/notifications/activity endpoints — see
  section 1. Within about a minute of the merge landing — and possibly sooner,
  since the auction detail endpoint still settles on demand on its first
  request — every already-expired auction gets swept into `ended` under the
  new rules, all at once. This is correct behaviour, but it is irreversible:
  anything that must not settle needs to have been dealt with in pre-flight
  step 6, **before** you merge, not after.
- `0 3 * * *` (03:00 UTC daily) — the stale-image cleanup sweep, gated on
  `ENABLE_STALE_IMAGE_CLEANUP` in `[vars]` (currently `"true"` — see the
  section above). Also irreversible, on its own 30-day-after-`end_time`
  schedule rather than triggered by this merge.

### 5.4 Merge to deploy

1. On GitHub, merge the pull request from your branch into `main`.
2. Watch the build and deploy: dashboard → **Workers & Pages → msa-auction →
   Deployments**. A new deployment appears for the commit you merged; open it
   to follow the build log.
3. Once it shows as live, note its version/deployment ID alongside the one
   you recorded in pre-flight step 4.
4. **Tell the society to reload.** Anyone with the site open in a tab from
   before this deploy is running old client code. Post a heads-up (Discord,
   WhatsApp, wherever the committee already talks to members) asking people
   to reload if anything looks broken, before the bug reports start arriving.

---

## 5.5 Images: nothing changes in this deploy

**There is no R2 step in this deploy, and no bucket to create.** Listing
images continue to be stored as base64 `data:` URLs inside
`auctions.image_urls`, exactly as they are on the live site today. Nothing
about image storage changes when you deploy.

Why, given that base64-in-Postgres is what took this project to 21GB of
Supabase egress against a 5GB allowance: enabling Cloudflare R2 requires a
payment method on the Cloudflare account, and this is a university society's
project, not anybody's personal one. So the `[[r2_buckets]]` block in
`wrangler.toml` is **commented out**. A Worker naming a bucket that does not
exist fails to deploy outright, which is why it must stay commented out until
a bucket actually exists.

The R2 implementation itself is still in the tree, still tested, and dormant.
With no binding bound, the Worker degrades on purpose rather than erroring:

| Route | With no bucket | With a bucket |
|---|---|---|
| `POST /api/images` | `503 IMAGE_STORAGE_UNAVAILABLE` | `200 {url, key}` |
| `GET /images/:key` | `404 IMAGE_NOT_FOUND` | the image bytes |
| `POST /api/admin/migrate-images` | `503 IMAGE_STORAGE_UNAVAILABLE` | runs a batch |

The client reads that `503` code and stores the image inline instead, which is
what it did before R2 existed. **Listing creation works normally.** Both
`data:` URLs and `/images/<key>` paths are accepted by the validator in every
combination, so nothing is a one-way door in either direction.

Link previews are unaffected: with every listing's first image a `data:` URL,
`og:image` falls back to the MSA logo for all of them — the same behaviour the
live site has today. A `data:` URL is never emitted as `og:image`; every
crawler rejects them.

**The plan is to deploy without R2 and measure.** This change set removes
image data from the detail and bid responses as well as the list — images now
load once via the images route — which is on its own a large reduction in
egress, and it may well be enough. See section 6 check 7 for what to watch,
and **Appendix A** for how to turn R2 on later if it is not.

---

## 6. Post-deploy verification

Run every one of these. This is the only check standing in for the fact that
none of the automated tests ran against a real database.

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

4. **Settlement is running.** Watch the live logs: dashboard → **Workers &
   Pages → msa-auction → Logs** (real-time / observability logs).
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

   Also check the image tag:
   ```
   curl -s https://msa-auction.msasoton.workers.dev/auction/<auction-id> | grep -i "og:image"
   ```
   Pass: `content="https://msa-auction.msasoton.workers.dev/MSA_Logo.png"`.
   Every listing previews as the logo, because with R2 off every listing's
   first image is a `data:` URL and those can never go in an `og:image`. Fail:
   a tag containing `data:image` (which would put megabytes of base64 into a
   page crawlers fetch), or no `og:image` tag at all (which turns today's logo
   preview into a blank card in iMessage, Slack and WhatsApp).

6. **Creating a listing with photos still works.** This is the one that
   matters most in this deploy. Log into the live site as a test account and
   create a listing with two or three photos attached.

   Pass: the listing is created and its photos render on the homepage and on
   the listing page. Fail: an error on submit mentioning image upload. If the
   browser devtools Network tab shows `POST /api/images` returning `503
   IMAGE_STORAGE_UNAVAILABLE`, **that on its own is expected and correct** —
   there is no R2 bucket, and the client is meant to see that code and store
   the image inline instead. What would be a genuine failure is the listing not
   being created at all, or the request never falling back.

7. **Watch Supabase egress for the next few days.** This is the measurement
   the whole no-R2 decision rests on, so do not skip it.

   Supabase dashboard → Project Settings → Usage → **Egress**. Note the figure
   today, immediately after deploying, then check it again after 3 and 7 days.

   The polling fix in this change set replaced a dead Socket.IO client that
   was reconnecting constantly, and the auction list no longer carries image
   payloads at all — between them that is the bulk of the 21GB. What you are
   looking for:

   | After a week | Means |
   |---|---|
   | Comfortably under the 5GB monthly allowance, and roughly flat day to day | Done. No R2 needed. Leave it as it is. |
   | Under the allowance but climbing steadily as listings accumulate | Fine for now. Re-check monthly, and keep Appendix A in mind for when the society grows. |
   | Still approaching or over 5GB | The remaining traffic really is the base64 images. Read **Appendix A** and decide whether attaching a payment method to the Cloudflare account is worth it. |

   Daily egress divided by daily page views gives you a rough per-view cost; if
   that number is in the megabytes, it is images, and Appendix A is the fix.

---

## 7. Rollback

To revert the Worker to the version you recorded in pre-flight step 4:
dashboard → **Workers & Pages → msa-auction → Deployments**, find that
version in the list, and choose **Rollback**.

**A later merge to `main` will redeploy the new code again.** A rollback in
the dashboard only changes what's live right now — if the branch you merged
is still sitting on `main`, the next push or merge (by anyone) puts the new
version straight back. If the rollback needs to stick, also revert the merge
commit on GitHub.

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
| Listing photos have vanished from an ended/cancelled/hidden auction | Expected: the daily cleanup sweep runs in production 30 days after `end_time`, by design — see the section near the top of this document | Not a bug. If it should not have run, set `ENABLE_STALE_IMAGE_CLEANUP = "false"` in `wrangler.toml` and merge to `main` |
| Listing photos have vanished from an ACTIVE auction, or from something less than 30 days old | Someone ran the local dev server with `ENABLE_STALE_IMAGE_CLEANUP=true` in `.env`, or the Worker's rule/cutoff has a bug | There is no recovery — the images are gone. Remove that variable from `.env` (the local default is off) and check `cleanupStaleImages` in `workers/shared.ts` for a regression |
| Creating a listing fails on image upload | `POST /api/images` returning `503 IMAGE_STORAGE_UNAVAILABLE` is expected (there is no R2 bucket) and the client should fall back to storing the image inline — if it does not, the client is out of date | Merge `main` again to redeploy the current client build; the fallback lives in the client. Section 5.5 has the full contract |
| Shared links preview with the MSA logo rather than the listing's photo | Expected with R2 off — every listing's first image is a `data:` URL and no crawler accepts one | Nothing to fix. It resolves for migrated listings if you ever do Appendix A |

---

## 9. After this deploy

- **Delete `GET /api/admin/reset-requests`** once a real mail provider is
  wired up for password resets. It exists only as an interim way for an
  admin to hand a reset link to a student directly (see the comment above the
  route in `workers/index.ts`); it is not something that should stay in a
  production API long-term.
- **Measure Supabase egress before doing anything else about images.** Image
  storage is still base64-in-Postgres and R2 is switched off (section 5.5).
  That is a deliberate wait-and-see: removing image data from the detail and
  bid responses in this deploy may be enough on its own. Follow section 6
  check 7 for a week before deciding, and only then read **Appendix A**.
- **Outstanding work:** a real mail provider for password reset emails.

---

## Appendix A — OPTIONAL, LATER: moving images onto R2

> **Not part of this deploy. Do not do any of this now.**
>
> Come back to this section only if, after watching Supabase egress for a few
> days (section 6 check 7), it is still uncomfortably close to the 5GB
> allowance. It requires adding a payment method to the Cloudflare account.

R2 charges nothing for egress, so moving the image bytes there and keeping
only a short `/images/<key>` path in the database removes image traffic from
the Supabase bill entirely. Everything below is already implemented and
tested; what follows is how to switch it on.

No migration is needed for any of it. `image_urls` keeps the same jsonb type;
only the strings inside it change shape.

### A.1 Create the bucket, then uncomment the binding

In this order, because a Worker that names a bucket which does not exist fails
to deploy:

1. Add a payment method to the Cloudflare account (dashboard → **Manage
   Account → Billing**) — R2 requires one even to stay inside the free
   allowance.
2. Dashboard → **R2 → Create bucket**. Name it `msa-auction-images`.
3. In `wrangler.toml`, uncomment these three lines (they are there, in a
   commented block that explains all of this too):
   ```
   [[r2_buckets]]
   binding = "IMAGES"
   bucket_name = "msa-auction-images"
   ```
4. Commit that change, push it through a pull request, and merge to `main`.
   With Workers Builds, `wrangler.toml` is the source of truth for bindings —
   the binding only takes effect once this merge deploys, not when the bucket
   is created.

**No code change is required.** Not in the Worker, not in the client, not in
the database.

### A.2 What happens immediately after that merge deploys

Nothing breaks, and nothing moves on its own. Specifically:

- **Existing listings keep working untouched.** Their images are still
  base64 `data:` URLs, still served out of Postgres, exactly as before.
- **New uploads go to R2** from the moment the deploy lands. `POST
  /api/images` starts returning `200` instead of `503`, so the client stops
  falling back to inlining.
- **Mixed state is now normal.** Until the backfill finishes, one listing can
  hold a legacy `data:` URL and an `/images/<key>` path in the same array —
  including within the same listing if a seller edits a half-migrated one.
  Every read path handles both forms; this is tested, not assumed.
- **Egress does not drop yet.** It drops as the backfill progresses. Until a
  listing's images move, they still leave Postgres on every view.

### A.3 Run the backfill to completion

> ### ⚠ Run this at a quiet hour — when nobody is editing listings
>
> This is not a style preference. The backfill rewrites a listing's images,
> and it guards that write on the listing's status and image count so that a
> seller editing the same listing in the same moment is not silently
> overwritten with the images they just replaced. That guard is deliberately
> proportionate rather than airtight: it catches a status change or a change
> in the number of images, but it would **not** catch a seller swapping one
> photo for a different one in the fraction of a second between this job
> reading the row and writing it back. `auctions` has no row-version column
> that an edit bumps, and the value that would make the guard exact — the old
> image array — is megabytes of base64 and cannot be sent as a query
> parameter.
>
> Running when the site is idle is therefore the thing standing between a
> concurrent edit and a silently reverted image set. Late night, or right
> after you have told the committee you are doing maintenance. Do not run it
> during an active auction evening.

`POST /api/admin/migrate-images` converts one batch per call. It is admin
only, idempotent, and resumable — it is driven entirely by what is still a
`data:` URL in the database, so a row that has already moved is skipped
rather than converted twice. Run it repeatedly until it stops making
progress.

With your admin token (the same bearer token the admin UI uses):

```
curl -s -X POST https://<your-worker-url>/api/admin/migrate-images \
  -H "Authorization: Bearer <admin token>" \
  -H "Content-Type: application/json" \
  -d '{"limit": 25}'
```

`limit` counts **successful conversions**, defaults to 10 and is capped at
50. Each response looks like:

```json
{ "migrated": 25, "remaining": 143, "failures": [],
  "scan": { "fastPathMatched": 25, "fallbackScanned": 0, "listingsWithImages": 168 } }
```

#### Check the FIRST response before you start looping

The loop below stops when `migrated` is `0`. Read that number on call one
against `scan`, because `migrated: 0` on the very first call is **not**
success on a database you know still holds base64 images.

`scan` exists to tell those apart:

| Field | Means |
|---|---|
| `fastPathMatched` | rows the indexed `image_url like 'data:%'` filter returned |
| `fallbackScanned` | rows the slower full scan examined |
| `listingsWithImages` | listings holding at least one image — counted **without** that filter |

On the very first call, against a database that still holds base64 images,
you should see **`migrated` greater than 0**, **`fastPathMatched` greater
than 0**, and `listingsWithImages` roughly equal to your total number of
listings with photos.

**If `listingsWithImages` is large but `fastPathMatched` is `0`**, the
indexed filter matched nothing. The backfill still works — the fallback scan
picks the rows up, which is why `migrated` should still be above zero — but
it is now reading every listing to find them, which costs the Supabase egress
this whole exercise exists to save. Finish the run if you like, then report
it. Do not read it as "already done".

**If `migrated` is `0` AND `listingsWithImages` is `0`**, there is genuinely
nothing to migrate.

Once the first response looks right, loop:

**Stop when `migrated` comes back `0` — not when `remaining` does.**

That distinction matters. A row that can never be converted — corrupt base64,
or bytes that are not actually a JPEG, PNG, WebP or GIF — stays in
`remaining` forever. Looping until `remaining` is `0` would therefore never
terminate. Looping until `migrated` is `0` means "no further progress is
possible", which is the condition you actually want.

When it stops, read the last few responses' `failures` arrays:

```json
{ "migrated": 0, "remaining": 2,
  "failures": [ { "auctionId": "auc_x1", "error": "Inline image is not decodable base64 in a supported format." } ] }
```

Each entry names one listing that needs a human. In practice the fix is to
ask the seller to re-upload, or to hide the listing. A failing row never
aborts the batch and is never retried in a loop — it is reported and stepped
over.

You may also see:

```
"Listing changed while it was being migrated; left for the next run."
```

That is not an error — it is the guard described in the warning above doing
its job. A seller edited that listing between the read and the write, so the
migration declined to overwrite their newer images, and the next call picks it
up. Seeing it more than once or twice means the site is busier than it should
be for this job: stop, and come back at a quieter hour.

### A.4 Confirm it worked

1. `{"migrated": 0, "remaining": 0}` from the endpoint.
2. Open a listing that existed before the deploy. Its images still render.
3. In the browser devtools Network tab, its image requests go to
   `/images/<uuid>.<ext>` and come back with
   `cache-control: public, max-age=31536000, immutable`.
4. Paste a **migrated** listing's URL into Discord or WhatsApp. The preview
   now shows the listing's own photo — `og:image` finally emits a real
   absolute URL rather than a base64 data URL that every crawler rejected.
   Paste a **not-yet-migrated** listing's URL and you get the MSA logo, the
   same as today. That fallback is deliberate: a base64 data URL can never be
   previewed, but emitting nothing would turn today's logo preview into a
   blank card for every listing still waiting on the backfill.
5. Watch the Supabase egress figure over the following days. It should fall
   to roughly the cost of the JSON API alone.

### A.5 A note on `npm run dev` (local development only)

An R2 bucket is a Worker binding, and the Express dev server has no bindings.
So even after you switch R2 on in production, `npm run dev` keeps returning
`503 IMAGE_STORAGE_UNAVAILABLE` from `POST /api/images`, `404` from `GET
/images/:key`, and `503` from `POST /api/admin/migrate-images` — exactly what
the Worker returns with no binding bound. That is deliberate: the client's
base64 fallback is driven by that error code, and a fallback that only fires in
one of the two environments is a fallback nobody has tested.

To exercise real image upload locally (**local development only — this never
touches production**), run `npx wrangler dev` instead of `npm run dev`; it
does provide the binding.

Reading listings locally is unaffected: both storage forms render.

### A.6 If you ever need to turn R2 back off

Comment the `[[r2_buckets]]` block out again in `wrangler.toml`, commit,
push, and merge to `main` to redeploy. Listings already holding
`/images/<key>` paths will show broken images for those entries — the bucket
is gone — but nothing errors, nothing becomes uneditable, and new listings go
straight back to storing base64. The validator accepts both forms
unconditionally in both directions.
