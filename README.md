# MSA Auction

A full-stack auction app with React + Vite on the frontend and a local SQLite-backed Express server for development. The project also includes a Cloudflare-ready D1 + R2 structure for deployment, including authenticated register/login, image uploads, and listing limits.

## Features

- Real-time bidding and auction lifecycle handling
- Register/login-only auth flow
- Create listings with up to 3 images per auction
- Client-side image compression before submission
- Persistent local SQLite storage for development
- Cloudflare D1 + R2 route scaffolding for deployment
- Configurable limits for listings per user and images per listing

## Current Architecture

This workspace currently supports two environments:

1. Local development: Express + Socket.io + better-sqlite3
2. Cloudflare deployment: Pages Functions with D1 and R2 bindings

The local development path remains in `server.ts`, while the Cloudflare-specific API routes live in `functions/` and use `wrangler.toml` bindings.

## Tech Stack

- Frontend: React + Vite + TypeScript
- Local backend: Express + Socket.io + TypeScript + SQLite
- Cloudflare backend: Pages Functions, D1, R2
- Styling: Tailwind CSS

## Prerequisites

- Node.js 18+
- npm
- Cloudflare account if you want to deploy the D1/R2 version

## Local Development

### Install dependencies

```bash
npm install
```

### Start the app

```bash
npm run dev
```

This launches the local Express server on port `3000`, which serves the Vite frontend and provides the API and live auction features.

### Build for local production

```bash
npm run build
```

### Run the built local server

```bash
npm run start
```

### Type-check and lint

```bash
npm run lint
```

## Cloudflare D1 + R2 Setup

The Cloudflare deployment files are already scaffolded in this repo:

- `functions/api/auth/register.ts`
- `functions/api/auth/login.ts`
- `functions/api/auth/me.ts`
- `functions/api/auctions.ts`
- `functions/lib/cloudflare.ts`
- `wrangler.toml`

### Required Cloudflare configuration

1. Create or select a D1 database.
2. Create an R2 bucket for uploaded listing images.
3. Update `wrangler.toml` with your real D1 database id and R2 bucket name.
4. Deploy with Wrangler.

Example values to replace in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "msa-auction"
database_id = "replace-with-your-d1-database-id"

[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "msa-auction-images"
```

### Cloudflare limits

The current `wrangler.toml` sets:

- `MAX_LISTINGS_PER_USER = "20"`
- `MAX_IMAGES_PER_LISTING = "3"`

These values can be adjusted in the `[vars]` section.

## Image Upload Rules

- Up to 3 images per listing
- Images are compressed client-side before upload
- Images must be valid `data:image/...` payloads or public URLs
- The Cloudflare version uploads image data directly to R2

## Auth Flow

The app uses a login/register-only flow.

- Register creates a user and returns a bearer token
- Login verifies credentials and returns a bearer token
- `Authorization: Bearer <token>` is required for protected endpoints

## Notes

- Local development uses the persistent `auction.db` SQLite file.
- Cloudflare routes are separate from the local Express server and are intended for deployment use.
- The README assumes you will configure the Cloudflare bindings yourself before deployment.
- Demo users are intentionally removed from the app, so new accounts must be created through the UI.
