# Deploying MSA Auction

This is the deployment runbook for `https://msa-auction.msasoton.workers.dev/`, and the
**v1 cut-over runbook** for switching the live site from bidding to the fixed-price
classifieds model. Read section 5 (the cut-over) fully before you start it — it has an
irreversible step.

## Hard rules on this project

- **Deploys go through the Cloudflare dashboard.** The Worker (`msa-auction`) is
  connected to this repo's GitHub via **Workers & Pages → msa-auction → Settings →
  Builds**, with build command `npm run build`. A push or merge to `main` triggers a
  build and deploy on Cloudflare's own servers. **You never run `wrangler deploy` (or
  `npx wrangler deploy`) yourself**, and nothing in this document asks you to.
- **Secrets are set through the same dashboard** — **Settings → Variables and
  Secrets** — never with `wrangler secret put`.
- **Database changes happen in the Supabase dashboard's SQL Editor**, not from a local
  `psql` session or a CLI migration tool.
- **This project stays on free tiers, with no card on file anywhere** — not
  Cloudflare, not Supabase. That is why R2 is off (Appendix A) and why nothing in this
  document tells you to add a payment method.
- Any shell command below that you run yourself is written for **Windows PowerShell
  5.1** (fenced ```powershell). No `&&` — where two commands need to run in sequence,
  they're on separate lines, or joined with `; if ($?) { ... }`.

---

## DANGER: local `wrangler dev` talks to the production database

**There is no separate development database.** `wrangler.toml`'s `[vars]` block
(committed to the repo) points `SUPABASE_URL` at the one and only Supabase project.
`.dev.vars` (git-ignored, used by `npm run dev:api` / `wrangler dev`) only needs to
supply `SUPABASE_SECRET_KEY` — it inherits the same `SUPABASE_URL`. Running the Worker
locally is not a sandbox: every row you touch is a row a member can see.

The daily stale-image cleanup sweep (`cleanupStaleImages`, gated on
`ENABLE_STALE_IMAGE_CLEANUP` in `[vars]`, currently `"true"`) runs against this same
production database once a day via the Worker's cron trigger. It is irreversible —
images are base64 inside Postgres, with no second copy and no backup. This is an
owner-approved retention policy (30 days after a listing's `expires_at`), not a bug.

---

## 1. What changed for v1, and what this document covers

The product changed from a live auction to a fixed-price classifieds board — see the
README for the full feature list. For deployment, the load-bearing differences are:

- Two new migrations, `006_fixed_price_listings.sql` (adds columns and backfills —
  and, per the owner's decision, converts live auctions with bids to sold at their
  current highest bid, which is not reversible from inside the database — see section
  5 step 3) and `007_drop_bid_columns.sql` (destructive, irreversible).
- The Worker's cron triggers drop from two (`* * * * *` settlement, `0 3 * * *`
  cleanup) to one (`0 3 * * *` cleanup only) — `wrangler.toml` already reflects this.
- A new `LISTING_TTL_DAYS` plaintext var controls how long a listing stays live.
- The preferred Supabase secret name is now `SUPABASE_SECRET_KEY`, holding a new-style
  `sb_secret_...` key rather than the legacy `service_role` JWT. The Worker reads
  `env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY`, so either name works —
  but see section 5 step 1 for why rotating to the new key is mandatory here, not
  optional.

Sections 2-4 below are reference material (environment setup, migrations 001-005,
appointing an admin) that applies whether or not you're doing the v1 cut-over. **If
you are doing the v1 cut-over, skip to section 5** and come back to 2-4 only if
something there is missing on this deployment.

---

## 2. Environment and secrets (Cloudflare dashboard)

**Plaintext configuration** (`SUPABASE_URL`, `MAX_LISTINGS_PER_USER`,
`LISTING_TTL_DAYS`, `ENABLE_STALE_IMAGE_CLEANUP`) lives in `wrangler.toml`'s `[vars]`
block, is committed to the repo, and is visible in the dashboard. **`wrangler.toml` is
the source of truth for these** — it overwrites whatever plaintext value is set in the
dashboard on every build. So: edit plaintext vars in `wrangler.toml` (through a pull
request into `main`), and never rely on editing them directly in the dashboard, since
the next build reverts that edit.

**The Supabase secret key is different.** It bypasses row-level security and must
never appear in `[vars]` — not even as a placeholder. Set it only through:

**Dashboard → Workers & Pages → msa-auction → Settings → Variables and Secrets → Add
→ Secret**, name `SUPABASE_SECRET_KEY`, paste the value, save. Skip this if it's
already configured — check the same list first.

For local development, the same value goes in `.dev.vars` (git-ignored) in the repo
root, read by `wrangler dev` (`npm run dev:api`).

---

## 3. Database migrations (already applied, prior to v1)

Migrations 001-005 predate v1 and, per the owner, are already applied on the live
database. They're listed here for completeness and for anyone setting up a fresh
project from scratch. Run each in the **Supabase dashboard → SQL Editor**, in order,
by opening the file in `migrations/`, copying the whole thing, and running it — the
migration's own header comments are the full detail, not the summary below.

| Migration | What it adds | Required before deploy because |
| --- | --- | --- |
| `001_listing_lifecycle_and_list_payload.sql` | `auctions.image_count`, keyset-pagination index, per-seller active-listing index | `GET /api/auctions` selects `image_count` by name; missing it is Postgres 42703 |
| `002_user_email_and_password_reset.sql` | `users.email`, `reset_token_hash`, `reset_token_expires` | The email/reset routes 500 on the missing columns |
| `003_moderation_and_admin.sql` | `users.role`/`banned_at`/`banned_reason`, the `reports` table, `auctions.hidden_*` | Every `/api/admin/*` route and `POST /api/auctions/:id/report` 500 without it |
| `004_money_numeric_and_bid_version.sql` | Converts money columns to `numeric(12,2)`; adds `bid_version` | The bid-era code paths (now removed by 007) selected `bid_version` by name |
| `005_enable_rls.sql` | Row level security on `users`, `auctions`, `reports`, no policies | Closes anon-key read access to `users.token` and other columns; the Worker's secret key bypasses RLS regardless |

If you are setting this project up fresh (not doing the v1 cut-over on an existing
deployment), run 001-005 here first, then continue with section 5 starting at 006.

---

## 4. Appoint the first admin

There is deliberately no route in the application that grants admin — a self-service
"make me admin" endpoint would be the whole vulnerability. Do this by hand, in the
**Supabase SQL Editor**, before you rely on the admin panel:

```sql
update public.users set role = 'admin' where username = 'your-lowercase-username';
```

Usernames are stored lower-cased. Verify:

```sql
select username, role from public.users where role = 'admin';
```

---

## 5. THE V1 CUT-OVER RUNBOOK

Do these in order. Each step names what it changes and, where relevant, whether it
can be undone. **Steps 3 and 7 touch the database and are the ones to slow down for.**

### Step 1 — Rotate the Supabase secret key, and disable legacy JWT keys

**This is mandatory, not a nice-to-have.** The old `service_role` key was committed to
this repository in plaintext, in commit `fbfde1c`, and remains readable in git history
permanently — rewriting history does not fix a key that may already have been cloned
or scraped. The only real fix is to make that value stop working.

1. **Supabase dashboard → Project Settings → API Keys.** Create a new **secret key**
   (the new-style key, prefixed `sb_secret_...`, distinct from the legacy
   JWT-format `service_role` key). *(This project's exact menu wording was not
   re-verified live against the dashboard while writing this document — if the
   labels have moved, look for "API Keys" under Project Settings; the underlying
   Supabase feature — separate publishable/secret keys replacing the legacy
   anon/service_role JWTs, with an option to disable the legacy pair — is what you
   want.)*
2. **Cloudflare dashboard → Workers & Pages → msa-auction → Settings → Variables and
   Secrets.** Set `SUPABASE_SECRET_KEY` to the new `sb_secret_...` value (add it if
   it isn't there yet; edit it in place if `SUPABASE_SERVICE_ROLE_KEY` or an older
   `SUPABASE_SECRET_KEY` already exists — the Worker's fallback (`env.SUPABASE_SECRET_KEY
   ?? env.SUPABASE_SERVICE_ROLE_KEY`) means either name works, but only one value should
   be live).
3. Update your own `.dev.vars` to the same new value, if you develop locally.
4. Back in Supabase, **disable the legacy JWT-based API keys** (the old `anon` and
   `service_role` pair) once you've confirmed the new key works end to end (steps 2-4
   below exercise that). Disabling them is what actually revokes the leaked value —
   until this is done, the key from commit `fbfde1c` still works against your
   database from anywhere.

**Reversible?** Creating a new secret key and setting it in Cloudflare is fully
reversible (swap the dashboard value back). **Disabling the legacy keys is the point
of no return for the leaked key** — that's intentional. If something breaks after
disabling them, the fix is re-enabling the legacy keys in Supabase, not reverting
Cloudflare.

### Step 2 — Back up `auctions` before migration 006

Migration 006 is not reversible from inside the database once it runs (see step 3's
"Reversible?" note) — per the owner's decision, it converts live auctions that already
have a bid to `'sold'` at their current highest bid. Take a backup first, in the
**Supabase SQL Editor**, using the same backup-schema-with-RLS pattern migration 007's
own header uses for `backup.auctions_pre007` (step 6):

```sql
create schema if not exists backup;
create table backup.auctions_pre006 as table public.auctions;
alter table backup.auctions_pre006 enable row level security;
```

Then confirm the row count matches:

```sql
select (select count(*) from public.auctions) as live_count,
       (select count(*) from backup.auctions_pre006) as backup_count;
```

Expect the two numbers to be equal. Row level security is enabled with no policies for
the same reason as `backup.auctions_pre007`: the rows contain sellers' phone numbers,
and a copy sitting in `public` with RLS off would be readable by anyone holding the
(non-secret) anon key.

### Step 3 — Tell sellers and bidders first, then run migration 006

**Before you run this**, bidding on the live site is ending for good. Post a notice
(society WhatsApp/social channels) telling sellers and bidders of live auctions that
bidding is closing and that every live listing with at least one bid will convert to
**sold, at its current highest bid** the moment this migration runs — see below. Give
people a reasonable window to place a final bid or walk away before you run it.

**Supabase dashboard → SQL Editor.** Open `migrations/006_fixed_price_listings.sql`,
read its header comment in full, copy the whole file, and run it. It is **not purely
additive** — besides adding `price`, `expires_at` and `sold_at`, adding indexes and
installing a transitional trigger, it also: rewrites rows that ended with a winner to
status `'sold'`; drops `NOT NULL` on the bid-era columns the new Worker no longer
writes; drops any legacy `CHECK` constraint on `auctions.status` before the backfill
runs (re-adding one, `NOT VALID`, afterwards, so an unexpected legacy status is still
backfilled rather than aborting the migration); and, per the owner's decision, converts
every **live** auction to a fixed-price listing as follows:

- A live auction that already has at least one bid converts to `status = 'sold'`, at
  its **current highest bid** (not the original starting price).
- A live auction with no bids converts to a live listing at its **starting price**.
- Every live auction — bid or no bid — gets a **fresh 30-day expiry** from the moment
  006 runs, regardless of how long it had been live before.

It is safe to run **before** the new Worker deploys — the old (bidding) Worker keeps
working against the same table while this is in place, kept correct by the
transitional trigger.

Then run the verification queries from the bottom of that file (also reproduced
here):

```sql
-- Every row has a price and an expiry (expect 0 and 0):
select count(*) filter (where price is null)      as missing_price,
       count(*) filter (where expires_at is null) as missing_expiry
  from public.auctions;

-- How the backfill classified existing rows:
select status, (sold_at is not null) as has_sold_at, count(*)
  from public.auctions group by 1, 2 order by 1, 2;

-- What the new browse page will show (live listings):
select count(*) from public.auctions
 where status = 'active'
   and expires_at > (extract(epoch from now()) * 1000)::bigint;
```

**Reversible?** Only partly — see the rollback notes at the end of this section
(step 8). Dropping the added columns/indexes/trigger undoes the additive part, but it
does **not** restore rows rewritten to `'sold'`, the `NOT NULL` constraints that were
dropped, or the original `status` `CHECK`. The only full restore is the backup taken
**before** running 006, in step 2.

### Step 4 — Merge `release/v1` into `main`

This is what actually ships the new Worker — the Cloudflare Git-connected build
deploys on every merge to `main`. On GitHub, open (or already have) a pull request
from `release/v1` into `main`, review it, and merge.

Watch the build: **dashboard → Workers & Pages → msa-auction → Deployments.** Once
it's live, confirm two things in the dashboard before moving on:

- **Settings → Triggers → Cron Triggers** shows only `0 3 * * *`. The old `* * * * *`
  settlement trigger must be gone — `wrangler.toml` on `release/v1` only declares the
  one cron, and `scheduled()` in `workers/index.ts` ignores any other `event.cron` it
  might still receive, but the trigger itself should not be listed any more either.
- **Settings → Variables and Secrets** shows `LISTING_TTL_DAYS` (plaintext, from
  `[vars]`) set — `wrangler.toml` ships it as `"30"`. If it's missing, the Worker
  falls back to the same default (30 days) internally, so this is a confirmation
  step, not a blocker, but confirm it landed as intended.

**Reversible?** Rolling the Worker back to the previous deployment (dashboard →
Deployments → pick the old version → **Rollback**) is immediate, but it does not
un-migrate the database: listings created under the new v1 client (which write
`price`/`expires_at` and never `end_time`) will show as **Ended** in the old
(bidding) UI, since that UI reads `end_time` to work out whether an auction is live.
See the rollback notes at the end of this section for what does and doesn't come back
with it.

### Step 5 — Smoke test the live site

Do all of these against `https://msa-auction.msasoton.workers.dev/` before touching
the database again (step 6). If anything here fails, stop and roll back the Worker
(step 4's rollback) before you run migration 007 — 007 is not designed to run against
the old Worker.

1. **Browse** — the homepage loads a grid of listings with prices, not a blank page
   or an error.
2. **Sign in** — an existing test account signs in successfully.
3. **Create a listing** — with at least one photo — and it appears on the browse
   grid with the price you set.
4. **WhatsApp button** — open a listing while signed in and confirm the "Message the
   Seller on WhatsApp" button is present (it only renders when the seller's number
   parses to a usable `wa.me` target).
5. **Mark as Sold** — on a listing you own, confirm the button, dialog and resulting
   state change all work, and the listing leaves the browse grid.
6. **Cancel** — on another listing you own, confirm cancelling removes it from the
   browse grid but the listing is still reachable by its direct link.
7. **Admin hide** — as an admin account, hide a test listing from `/admin` and
   confirm it disappears from the browse grid (and, for a non-admin, from the direct
   link too).
8. **Deep link to a missing listing** — open `/auction/<an-id-that-does-not-exist>`
   directly and confirm you see the "This listing is no longer available" notice,
   not a blank page or a crash.
9. **Session expiry across devices** — sign in on a second device, then open a
   listing on the first device and try to contact the seller. You should be asked to
   sign in again there, not see an endless spinner.

### Step 6 — Back up, per migration 007's own header

**Do this even though it feels redundant with migration 006 having just run.**
Migration 007 is destructive and irreversible; its own header requires this backup as
its literal first step. In the **Supabase SQL Editor**, run this as its own query:

```sql
create schema if not exists backup;
create table backup.auctions_pre007 as table public.auctions;
alter table backup.auctions_pre007 enable row level security;
```

Then confirm the row count matches:

```sql
select (select count(*) from public.auctions) as live_count,
       (select count(*) from backup.auctions_pre007) as backup_count;
```

Expect the two numbers to be equal. The backup table gets row level security enabled
with no policies — the rows contain sellers' phone numbers, and a copy sitting in
`public` with RLS off would be readable by anyone holding the (non-secret) anon key,
which is exactly the hole migration 005 closed on the real table.

### Step 7 — Run migration 007

**Only after step 5's smoke test has passed on the live, newly-deployed Worker.**
Running this against the old (bidding) Worker breaks every page of the site — the old
Worker reads columns this migration drops.

**Supabase dashboard → SQL Editor.** Read `migrations/007_drop_bid_columns.sql`'s
header in full — it repeats the backup requirement and states plainly that there is
no "down" migration for the columns it drops, only the backup from step 6. Copy the
whole file and run it. Then run its own verification queries (reproduced here):

```sql
-- Remaining columns (expect no bid-era names in this list):
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'auctions'
 order by ordinal_position;

-- Status distribution (expect only active / sold / cancelled / hidden):
select status, count(*) from public.auctions group by 1 order by 1;
```

**Reversible?** No — not from within the database. `bids`, `bid_version`,
`current_price`, `starting_price`, `highest_bidder_id`/`name`, `winner_id`/`name`,
`winning_bid`, `duration_minutes`, `start_time`, `end_time` are gone for good once
this commits. The only way back is restoring specific columns from
`backup.auctions_pre007` (step 6) by hand, which is a manual, one-off SQL job, not a
migration file in this repo.

### Step 8 — Rollback notes for each step above

| Step | Reversible? | How |
| --- | --- | --- |
| 1. Rotate secret key | Creating/setting the new key: yes. Disabling the legacy keys: **effectively no** — you would have to re-enable a key you deliberately revoked, defeating the point | Re-enable the legacy keys in Supabase if something depends on them; otherwise fix the dependency, don't undo the rotation |
| 2. Backup before 006 | N/A (additive, harmless to leave) | Drop `backup.auctions_pre006` once you're confident you no longer need it |
| 3. Migration 006 | **Only partly** — the added columns/indexes/trigger can be dropped, but the rows rewritten to `'sold'` (at current highest bid), the dropped `NOT NULL`s and the dropped legacy `CHECK` do **not** come back this way | `drop trigger if exists msa_v1_transition_sync on public.auctions; drop function if exists public.msa_v1_transition_sync(); alter table public.auctions drop column if exists price, drop column if exists expires_at, drop column if exists sold_at;` then drop the indexes it added (see the migration file). For the rewritten data, restore from `backup.auctions_pre006` (step 2) by hand — that backup is the only full restore |
| 4. Merge to `main` | Yes, immediately for the Worker code. **Not** for the database | Dashboard → Deployments → previous version → **Rollback**. A later merge to `main` (by anyone) redeploys the new code again — if the rollback needs to stick, also revert the merge commit on GitHub. Note: listings created under v1 will show as **Ended** in the old UI after this rollback, since the old client reads `end_time`, which v1 listings never set |
| 5. Smoke test | N/A (read-only) | — |
| 6. Backup before 007 | N/A (additive, harmless to leave) | Drop `backup.auctions_pre007` once you're confident you no longer need it |
| 7. Migration 007 | **No**, not as a migration | Restore specific columns from `backup.auctions_pre007` by hand in the SQL Editor if you must; there is no scripted "down" for this file |

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Homepage is empty / `GET /api/auctions` returns 500 | Migration 001 (or 006) wasn't run before this deploy | Run the missing migration via the Supabase SQL Editor, then re-check the endpoint |
| Every write to a listing (edit/sell/cancel) answers 500 mentioning `price` or `expires_at` | Migration 006 wasn't run before this Worker deployed | Run migration 006 (section 5, step 3) |
| Admin panel doesn't appear for your account | No row has `role = 'admin'` yet, or you logged in before appointing yourself | Re-run section 4, then sign out and back in so the client fetches your current role |
| Password reset links never arrive | No mail provider is configured — a known, permanent-for-now gap | Use `GET /api/admin/reset-requests` (admin token) to read the pending link and hand it to the student directly |
| Reporting a listing returns 500 | Migration 003 wasn't run — the `reports` table doesn't exist | Run migration 003 (section 3) |
| Listing photos have vanished from a sold/cancelled/hidden listing | Expected — the daily cleanup sweep runs 30 days after `expires_at`, by design | Not a bug. To stop it, set `ENABLE_STALE_IMAGE_CLEANUP = "false"` in `wrangler.toml` and merge to `main` |
| Listing photos have vanished from an ACTIVE listing, or one less than 30 days old | A bug in `cleanupStaleImages`, or someone ran a local sweep against production with the flag on | There is no recovery outside the `backup.auctions_pre007` snapshot (if migration 007 has already run) — check `workers/shared.ts` for a regression |
| Creating a listing fails on image upload | `POST /api/images` returning `503 IMAGE_STORAGE_UNAVAILABLE` is expected (no R2 bucket); the client should fall back to inlining the image | If it doesn't fall back, the deployed client is stale — merge `main` again to redeploy |
| Shared links preview with the MSA logo instead of the listing's photo | Expected with R2 off — every listing's first image is a `data:` URL and no crawler accepts one | Nothing to fix here; resolves for migrated listings if you ever complete Appendix A |
| The old `service_role` key from commit `fbfde1c` still authenticates | Legacy JWT keys were never disabled in Supabase | Finish step 1.4 of the cut-over runbook |

---

## Appendix A — OPTIONAL, LATER: moving images onto R2

> **Not part of the v1 cut-over. Do not do any of this unless Supabase egress is a
> real problem, and only after adding a payment method to the Cloudflare account is
> something the society has actually decided to do.**

R2 charges nothing for egress, so moving image bytes there and keeping only a short
`/images/<key>` path in the database removes image traffic from the Supabase bill
entirely. The R2 code path is already implemented and tested — `POST /api/images`,
`GET /images/:key`, and the admin migration batch route — it just has no bucket
bound. No migration is needed for any of this; `image_urls` keeps the same shape,
only the strings inside it change.

### A.1 Create the bucket, then uncomment the binding

1. Add a payment method to the Cloudflare account (dashboard → **Manage Account →
   Billing**) — R2 requires one even to stay inside the free allowance. This is a
   deliberate step the society has to choose to take; nothing about the rest of this
   project needs it.
2. Dashboard → **R2 → Create bucket**. Name it `msa-auction-images`.
3. In `wrangler.toml`, uncomment the three `[[r2_buckets]]` lines (they're there
   already, in a comment block that explains all of this too):
   ```
   [[r2_buckets]]
   binding = "IMAGES"
   bucket_name = "msa-auction-images"
   ```
4. Commit that change, open a pull request into `main`, and merge it. The binding
   only takes effect once this merge deploys through the dashboard build — not when
   the bucket is created.

**No code change is required.** Not in the Worker, not in the client, not in the
database.

### A.2 What happens immediately after that merge deploys

- Existing listings keep working untouched — their images are still base64 `data:`
  URLs, still served out of Postgres.
- New uploads go to R2 from the moment the deploy lands. `POST /api/images` starts
  returning `200` instead of `503`.
- Mixed state is now normal: one listing can hold a `data:` URL and an
  `/images/<key>` path in the same array until the backfill (A.3) reaches it.
- Egress does not drop yet — only the backfill moves existing images.

### A.3 Run the backfill

Run this **at a quiet hour**, using an admin token, from the admin panel or directly:

```powershell
$headers = @{ Authorization = "Bearer <admin-token>"; "Content-Type" = "application/json" }
Invoke-RestMethod -Method Post `
  -Uri "https://msa-auction.msasoton.workers.dev/api/admin/migrate-images" `
  -Headers $headers -Body '{"limit": 25}'
```

`POST /api/admin/migrate-images` converts one batch per call, is idempotent and
resumable, and is driven by what is still a `data:` URL in the database. **Stop when
`migrated` comes back `0`, not when `remaining` does** — a permanently-broken row (bad
base64, an unsupported format) stays in `remaining` forever and is listed in
`failures` for a human to look at. `limit` counts successful conversions, defaults to
10, capped at 50.

### A.4 Confirm it worked

1. The endpoint returns `{"migrated": 0, "remaining": 0}`.
2. A listing that existed before the backfill still shows its photos.
3. In the browser devtools Network tab, its image requests go to
   `/images/<uuid>.<ext>` with `cache-control: public, max-age=31536000, immutable`.
4. Paste a migrated listing's URL into WhatsApp/Discord — the preview shows the
   listing's own photo instead of the MSA logo.
5. Watch Supabase egress over the following days; it should fall toward the cost of
   the JSON API alone.

### A.5 Local development with R2 on

`npm run dev` (Vite only) never has the R2 binding — bindings only exist under
`wrangler dev`. Use `npm run dev:api` (`wrangler dev`) to exercise real image upload
locally; it provides the binding once A.1 is done. `npm run dev` on its own keeps
returning `503`/`404` from the image routes regardless of whether R2 is live in
production, which is intentional: it's what lets the client's fallback path stay
exercised even after R2 is switched on.

### A.6 Turning R2 back off

Comment the `[[r2_buckets]]` block out again, commit, push, merge to `main`. Listings
already holding `/images/<key>` paths will show broken images for those entries — the
bucket binding is gone — but nothing errors and nothing becomes uneditable. New
listings go straight back to storing base64.
