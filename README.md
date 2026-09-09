# MSA Auction

A full-stack auction app with React + Vite on the frontend, an Express + Socket.io backend, and a Supabase-backed database for authentication, auctions, and listing persistence.

## Features

- Real-time bidding and auction lifecycle handling
- Register/login-only auth flow
- Create listings with up to 3 images per auction
- Client-side image compression before submission
- Supabase-backed persistence for users and auctions
- Configurable listing limit per user via environment variables

## Current Architecture

The app now uses:

- Frontend: React + Vite + TypeScript
- Backend: Express + Socket.io + TypeScript
- Database: Supabase
- Storage: Supabase tables for `users` and `auctions`

The local development server in `server.ts` now talks directly to Supabase using the service-role key.

## Tech Stack

- Frontend: React + Vite + TypeScript
- Backend: Express + Socket.io + TypeScript
- Database: Supabase
- Styling: Tailwind CSS

## Prerequisites

- Node.js 18+
- npm
- Supabase project with a URL and service-role key

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Create environment variables

Add the following values to a `.env` file:

```bash
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
MAX_LISTINGS_PER_USER="20"
```

### 3. Start the app

```bash
npm run dev
```

This launches the local Express server on port `3000`, which serves the Vite frontend and uses Supabase for the API and live auction data.

### 4. Build and run locally

```bash
npm run build
npm run start
```

### 5. Type-check and lint

```bash
npm run lint
```

## Cloudflare + Supabase Deployment

This project is currently structured as:

- Frontend: React + Vite
- Backend: Express + Socket.io
- Database: Supabase
- Hosting: Cloudflare Pages for the static frontend, with the Express backend running on a Node-compatible host

> The current code in `server.ts` is an Express server, so it is not a direct Cloudflare Worker deployment. The simplest Cloudflare setup is to deploy the frontend to Cloudflare Pages and keep the backend running on a Node host (for example Railway, Render, DigitalOcean, or another VPS/provider).

### 1. Create the Supabase project

1. Create a new Supabase project in the Supabase dashboard.
2. Go to Project Settings → API and copy:
   - `Project URL`
   - `service_role` key
3. Create the `users` and `auctions` tables using the SQL shown in the Supabase Setup section below.

### 2. Configure environment variables

For local development, use a `.env` file with:

```bash
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
MAX_LISTINGS_PER_USER="20"
```

For deployment, keep the Supabase service-role key on the backend only. Do not expose it in the browser or in Cloudflare Pages environment variables if you are not using a backend on Cloudflare.

### 3. Deploy the frontend to Cloudflare Pages

1. Push the project to GitHub.
2. In Cloudflare Dashboard → Pages, create a new project from the repository.
3. Use these build settings:
   - Build command: `npm run build`
   - Output directory: `dist`
4. If you want the frontend to reach a hosted backend, add a frontend environment variable such as:

```bash
VITE_API_BASE_URL="https://your-backend-domain.com"
```

> The current frontend code uses relative API paths (`/api/...`), so the built frontend will work correctly when served together with the Express backend locally.

### 4. Deploy the backend separately

Because `server.ts` is an Express app, deploy it to a Node-capable environment and set the same environment variables there:

```bash
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
MAX_LISTINGS_PER_USER="20"
```

Then start the server with:

```bash
npm install
npm run build
npm run start
```

This is the recommended deployment flow if you want Cloudflare Pages for hosting and Supabase for the database.

### 5. Optional: Cloudflare R2 for images

If you later want to store uploaded listing images in Cloudflare instead of only storing image URLs, you can add Cloudflare R2 support as a separate step. The current app already supports compressed image uploads and stores image URLs in the auction record, so R2 is optional and not required for the current setup.

## Supabase Setup

### 1. Add your env values
In your local .env, make sure you have:
```bash
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
MAX_LISTINGS_PER_USER="20"
```

> You can copy from .env.example and replace the placeholder values.

### 2. Create the Supabase tables
Open Supabase → SQL Editor and run this:

```SQL
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

create index if not exists idx_users_username
  on public.users (username);

create index if not exists idx_auctions_seller_id
  on public.auctions (seller_id);

create index if not exists idx_auctions_status
  on public.auctions (status);
```

> The column names above are important because server.ts expects password_hash, phone_number, starting_price, seller_id, image_urls, etc.

### 3. Get your Supabase credentials
In Supabase Dashboard:

- Project URL:
  +  Go to Project Settings → API
  + Copy the Project URL

- Service role key:
   + Go to Project Settings → API
   + Copy the service_role key
> Keep that key server-side only. Do not expose it to the browser.


## Image Upload Rules

- Up to 3 images per listing
- Images are compressed client-side before upload
- Images are passed as `data:image/...` payloads or public URLs
- The server expects those URLs to be stored in the auction record

## Auth Flow

The app uses a login/register-only flow.

- Register creates a user and returns a bearer token
- Login verifies credentials and returns a bearer token
- `Authorization: Bearer <token>` is required for protected endpoints

## Notes

- Demo users are intentionally removed from the app, so new accounts must be created through the UI.
- The app currently expects a Supabase service-role key on the server for authenticated database operations.
- If you want to harden the setup, you can replace the server-side service-role usage with Supabase Row Level Security policies and a separate anon client later.
