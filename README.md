<div align="center">
  <img src="assets/MSA_Logo.png" alt="MSA Southampton logo" width="120" />

  <h1>MSA Auction</h1>

  <p>A real-time student auction and marketplace for MSA Southampton, built on React and Cloudflare Workers.</p>

  <p><strong>Live:</strong> <a href="https://msa-auction.msasoton.workers.dev/">https://msa-auction.msasoton.workers.dev/</a></p>
</div>

---

## Features

- Browse live auctions in a responsive grid with a per-second countdown on every card.
- Username/password accounts (register and sign in); the session token is kept in `localStorage`.
- Create listings with a title, description, contact phone number, starting price, duration, category and up to 3 images.
- Images are compressed in the browser (max 1600px on the long edge, 5 MB per file) before being sent to the API.
- Bidding with server-side validation, a live bid history log, and quick `+£5 / +£10 / +£25 / +£50 / +£100` increment buttons.
- Search across title, description, category and seller name; filter by category and status; sort by end time, price or bid count.
- Per-device watchlist stored in browser `localStorage`.
- Live updates via REST polling: the auction list refreshes every 5 seconds and an open auction refreshes every 3 seconds. Polling pauses while the browser tab is hidden.
- Header connection badge reads **Live** when the API is reachable and **Reconnecting...** when it is not.
- All prices are in GBP (£), formatted with `en-GB` currency formatting.
- Per-user listing cap, configurable via `MAX_LISTINGS_PER_USER` (default 20).

---

## 📖 How to Use — Tutorial

### 1. Browse live auctions

Open the site and you land straight on the **Live Bidding Dashboard**. Each card shows the item image, a live countdown, the current highest bid, the starting price, the number of bids, the top bidder and the seller's first name. Cards are badged **Live**, **Ending Soon** (under 5 minutes left) or **Ended**, and you do not need an account to look around.

![MSA Auction homepage showing the Live Bidding Dashboard with a grid of auction cards, each displaying an item photo, countdown timer, current highest bid in pounds and a View and Place Bid button](docs/images/01-homepage.png)

### 2. Create an account or sign in

Click **Sign In** in the top-right of the header. The modal has two tabs: **Sign In** (Username, Password) and **Register** (Full Name, Username, Password). Usernames are stored lower-case and must be unique — registering a name that is taken returns "Username is already taken. Please choose another." Once you are in, the header shows your name, `@username` and a sign-out button.

![Sign in modal with Sign In and Register tabs, username and password fields, and a Sign In button](docs/images/02-sign-in.png)

### 3. List an item for sale

Press **Create Listing** in the header (you must be signed in; otherwise the modal prompts you to sign in first). Fill in **Item Title**, **Item Description**, **Starting Price (£)**, **Contact Phone Number**, an **Auction Duration** preset (2 Mins, 5 Mins, 6 Hours, 24 Hours, 3 Days, 7 Days, or a custom number of minutes), at least one image via **Add Image**, and a free-text **Category** (it defaults to `Electronics`; leaving it blank stores `General`). Submitting with a missing field shows "Please complete the title, description, and phone number fields.", and with no image "Please upload at least one image before publishing the listing." Click **Publish Live Auction** and the countdown starts immediately.

![Create New Auction Listing modal with fields for item title, description, starting price in pounds, contact phone number, duration presets, image upload and category](docs/images/03-create-listing.png)

### 4. Open an auction to see details and bid history

Click **View & Place Bid** on any card (ended auctions read **View Result & Logs**). The detail view shows the full description, the current highest bid against the starting price, the current top bidder, and a **Live Bid History** log with every bid, bidder name, amount and timestamp, newest first. The seller's name and phone number are shown here with a copy button and a `tel:` link — that is how you arrange handover once the auction closes.

![Auction detail modal showing the item image, a live countdown, current highest bid, seller name and phone number, and a live bid history list](docs/images/04-auction-detail.png)

### 5. Place a bid

In **Place Your Bid**, type an amount or tap the `+£5`, `+£10`, `+£25`, `+£50` or `+£100` pills, then press **Submit Bid**. The rules are enforced both in the browser and again on the server: the **first** bid must be at least the starting price, and every bid after that must be **strictly higher** than the current price — equalling it is rejected with "Bid must be strictly higher than current bid of £X." You cannot bid on your own listing (the form is replaced by "You are the seller of this listing and cannot bid on it."), and once the countdown expires bidding is closed. A successful bid confirms with "Placed bid of £X!" and everyone else's view updates on the next poll.

![Place Your Bid panel with quick increment buttons, a bid amount input prefixed with a pound sign, a Submit Bid button and a minimum bid hint](docs/images/05-place-bid.png)

### 6. Search, filter and use the watchlist

Use the search box to match on title, description, category or seller name. The category bar filters by **All Categories, Electronics, Vehicles, Collectibles, Art & Antiques, Books & Media, Fashion** and **General**, and the tabs below filter by **All Listings, Active Live, Ending Soon (<15m), Concluded** and **Watchlist**. Sort with **Ending Soonest, Highest Price, Lowest Price** or **Most Bids**. Tap the star on any card to add it to your watchlist — this is saved in your browser's `localStorage`, so it is per-device and per-browser and is **not** synced to your account.

![Search bar, category filter chips, status filter tabs including Watchlist, and a sort dropdown above the auction grid](docs/images/06-search-filters.png)

### Tips

- The auction list refreshes roughly every 5 seconds, and an open auction refreshes every 3 seconds, so prices and bid history appear with a short delay rather than instantly.
- Polling **pauses while the tab is in the background** and resumes the moment you switch back, so a tab left open for a while will look stale until you return to it. The refresh button beside the dashboard metrics forces an immediate reload.
- Short durations (the 2-minute preset) are handy for testing an end-to-end bid flow without waiting.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript 5.8, Vite 6 |
| Styling | Tailwind CSS 4 (`@tailwindcss/vite`) |
| Icons / animation | `lucide-react`, `motion` |
| Production backend | Cloudflare Workers (`workers/index.ts`) |
| Local dev server | Express 4 + `tsx` (`server.ts`) |
| Database | Supabase (Postgres) via `@supabase/supabase-js` |
| Build | `vite build` for the client, `esbuild` for the legacy dev server bundle |
| Tests | Vitest, React Testing Library, Playwright |

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Runs `server.ts` with `tsx` — Express plus Vite middleware on port 3000 |
| `npm run build` | Builds the client into `dist/`, then bundles `server.ts` to `dist/server.cjs` |
| `npm run start` | Runs the built Node server (`dist/server.cjs`) |
| `npm run preview` | Vite preview of the built client |
| `npm run lint` | `tsc --noEmit` type-check |
| `npm test` | Vitest unit and component tests |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with a coverage report |
| `npm run test:e2e` | Playwright end-to-end tests |

---

## Architecture

There are two server files in this repository, and only one of them is used in production.

**`workers/index.ts` — the production backend.** This is the Cloudflare Worker that serves the live site. It is a plain `fetch` handler that serves the built static client from `./dist` for non-`/api/` routes, and exposes a REST API:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health ping used by the header connection badge |
| `POST` | `/api/auth/register` | Create an account, returns a bearer token |
| `POST` | `/api/auth/login` | Sign in, issues a fresh bearer token |
| `GET` | `/api/auth/me` | Resolve the current user from `Authorization: Bearer <token>` |
| `GET` | `/api/auctions` | List all auctions |
| `GET` | `/api/auctions/:id` | Fetch one auction |
| `POST` | `/api/auctions` | Create a listing (auth required, enforces `MAX_LISTINGS_PER_USER`) |
| `POST` | `/api/auctions/:id/bids` | Place a bid, with all bid rules validated server-side |

**`server.ts` — a legacy local-only dev server.** It is an Express app that mounts Vite in middleware mode and mirrors the Worker's REST routes so `npm run dev` works locally. It still constructs a Socket.IO server, but **the client no longer speaks Socket.IO at all** — nothing in `src/` emits or listens to those events. The Socket.IO half of this file is dead code kept for reference.

### Why polling replaced WebSockets

The client used to connect to Socket.IO. That never worked in production: the app deploys as a Cloudflare Worker, and `workers/index.ts` has no WebSocket or Socket.IO server behind it, so requests to `/socket.io/` returned 404 and the header sat on "Connecting to Server..." indefinitely.

The client now uses REST polling instead (`src/lib/realtime.ts`). `startPolling()` runs a fetch on an interval, skips a tick if the previous request is still in flight, pauses while `document.visibilityState === 'hidden'`, and fires immediately again when the tab becomes visible. Three pollers run:

- `/api/auctions` every **5s** — new listings, new bids, auctions that have ended.
- `/api/auctions/:id` every **3s** — only while an auction detail modal is open.
- `/api/health` every **15s** — drives the **Live** / **Reconnecting...** badge in the header.

Countdown timers tick locally every second and do not require a network request.

---

## Getting Started

### Prerequisites

- Node.js 18 or newer
- npm
- A Supabase project (URL and service-role key)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in real values:

```bash
cp .env.example .env
```

```bash
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
VITE_API_BASE_URL=""
MAX_LISTINGS_PER_USER="20"
```

`VITE_API_BASE_URL` can stay empty when the client and API share an origin (which is the case both locally and on Workers). Set it only if you host the API on a separate domain.

### 3. Create the Supabase tables

In Supabase → SQL Editor:

```sql
create table if not exists public.users (
  id text primary key,
  name text not null,
  username text not null unique,
  password_hash text not null,
  token text,
  created_at bigint not null
);

create table if not exists public.auctions (
  id text primary key,
  title text not null,
  description text not null,
  phone_number text not null,
  starting_price double precision not null,
  current_price double precision not null,
  seller_id text not null,
  seller_name text not null,
  highest_bidder_id text,
  highest_bidder_name text,
  duration_minutes integer not null,
  start_time bigint not null,
  end_time bigint not null,
  status text not null default 'active',
  category text default 'General',
  image_url text,
  image_urls jsonb not null default '[]'::jsonb,
  bids jsonb not null default '[]'::jsonb,
  winner_id text,
  winner_name text,
  winning_bid double precision,
  created_at bigint not null
);

create index if not exists idx_users_username on public.users (username);
create index if not exists idx_auctions_seller_id on public.auctions (seller_id);
create index if not exists idx_auctions_status on public.auctions (status);
```

The snake_case column names matter — both `workers/index.ts` and `server.ts` read and write these exact names.

### 4. Run the app

```bash
npm run dev
```

This starts the Express dev server on port 3000 with Vite in middleware mode.

---

## Testing

```bash
npm test              # run unit and component tests once
npm run test:watch    # re-run on file changes
npm run test:coverage # with a coverage report
npm run test:e2e      # Playwright end-to-end tests
```

- **Unit and component tests** use Vitest with React Testing Library, and live in `tests/unit` and `tests/components`.
- **End-to-end tests** use Playwright and live in `tests/e2e`. The API is mocked at the network layer, so the E2E suite never touches production data or the live Supabase project.

---

## Deployment

The site is deployed as a Cloudflare Worker. `wrangler.toml` points `main` at `./workers/index.ts` and serves static assets from `./dist`, so the client must be built first:

```bash
npm run build
npx wrangler deploy
```

`not_found_handling = "single-page-application"` means unknown non-API paths fall through to `index.html`.

### Security note — known issue to fix

`SUPABASE_SERVICE_ROLE_KEY` is currently set in plaintext under `[vars]` in `wrangler.toml`, which is committed to the repository and therefore present in git history. The service-role key bypasses row-level security and grants full access to the database, so it must not live there.

To fix it:

1. Rotate the key in the Supabase dashboard (Project Settings → API), which invalidates the exposed one.
2. Remove `SUPABASE_SERVICE_ROLE_KEY` from `[vars]` in `wrangler.toml`.
3. Set the new key as an encrypted Worker secret:

   ```bash
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   ```

The Worker reads `env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY`, so a secret set under either name is picked up with no code change. Note that rotating alone does not scrub the old key from git history.

---

## Notes and known limitations

- Passwords are hashed with a plain SHA-256 digest and no salt, and the bearer token is a random UUID stored on the user row. This is not production-grade authentication.
- `POST /api/auctions/:id/bids` trusts the `userId` and `userName` in the request body rather than an `Authorization` header, so a bid is not cryptographically tied to a session.
- Images are stored as base64 data URLs in the `image_urls` column rather than in object storage, which makes auction rows large.
- Auctions end by timestamp comparison rather than a scheduled job, so `status` may still read `active` in the database after `end_time` has passed; the client treats `end_time <= now` as ended.
- The watchlist and the signed-in session are both browser `localStorage` values (`msa_watchlist_ids` and `msa_auction_user`) and are not synced across devices.

---

Built by [dragonfisher29](https://github.com/dragonfisher29) for MSA Southampton.
