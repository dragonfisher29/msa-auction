export interface User {
  id: string;
  name: string;
  username: string;
  token?: string;
  createdAt: number;
  /**
   * `'member'` or `'admin'`, echoed by `/api/auth/me|login|register` from the database row.
   *
   * DISPLAY ONLY. It decides whether admin controls are RENDERED and nothing else. Every
   * `/api/admin/*` route is gated server-side by `requireAdmin`, which re-reads this column
   * on each request, so editing this value in localStorage grants exactly nothing: the
   * panel would render and every call it makes would come back 403 NOT_ADMIN.
   */
  role?: string;
  /** Recovery address, or null for the many accounts created before emails existed. */
  email?: string | null;
}

/**
 * Where a listing is in its life. The server derives `'expired'` itself (30 days after
 * `createdAt`, see `expiresAt`), so the client only ever renders it. `'hidden'` is a committee
 * takedown and never reaches a non-admin: `GET /api/auctions/:id` answers 404 for it.
 */
export type ListingStatus = 'active' | 'sold' | 'expired' | 'cancelled' | 'hidden';

/**
 * One fixed-price listing. Still called `AuctionItem` (and still served from `/api/auctions`)
 * because the routes and the name predate the move away from bidding; nothing about it is an
 * auction any more.
 */
export interface AuctionItem {
  id: string;
  title: string;
  description: string;
  /**
   * Absent on the public list (`GET /api/auctions`, never carries a phone number - see
   * `AUCTION_LIST_COLUMNS` in `workers/shared.ts`) and on `GET /api/auctions/:id` when the caller
   * is not signed in. Present everywhere else: the activity feed (own data only) and an
   * authenticated detail fetch.
   */
  phoneNumber?: string;
  /** Fixed asking price in GBP (pounds, up to two decimal places). */
  price: number;
  sellerId: string;
  sellerName: string;
  status: ListingStatus;
  /** ms epoch. The listing drops off the browse page at this moment (30 days after creation). */
  expiresAt: number;
  /** ms epoch the seller marked it sold, or null while it is not sold. */
  soldAt: number | null;
  category?: string;
  imageUrl?: string;
  imageUrls?: string[];
  /**
   * Present instead of `imageUrls` on rows from the paginated `GET /api/auctions` list endpoint
   * AND on `GET /api/auctions/:id` (single-item detail) - neither ships any image data at all
   * (see `mapAuctionDetailRow` in `workers/index.ts`), to keep both the list page and the
   * detail fetch light. `AuctionCard`/`AuctionDetailModal` use this to decide whether to fetch
   * real image data from `GET /api/auctions/:id/images`, at most once per id.
   * `imageUrls`/`imageUrl` are only ever present on a row from that images route, from `POST
   * /api/auctions` (create), or from a `PATCH` (edit) response.
   */
  imageCount?: number;
  /**
   * Bumped (epoch ms) whenever the listing's photos change; 0 for listings untouched since v1.
   * Sent as `?v=` to `GET /api/auctions/:id/images` so a cached response is only reused while it
   * still matches. Present on list and detail rows.
   */
  imagesVersion?: number;
  createdAt: number;
}

/** Shape returned by `GET /api/auctions?limit=&cursor=`. */
export interface AuctionsPage {
  auctions: AuctionItem[];
  nextCursor: string | null;
}

/** Shape returned by `GET /api/users/me/activity` (auth required). */
export interface UserActivity {
  listings: AuctionItem[];
}

/** One row of `GET /api/admin/reports` (admin only). Mirrors `ReportView` in workers/shared.ts. */
export interface AdminReport {
  id: string;
  auctionId: string;
  auctionTitle: string | null;
  sellerId: string | null;
  sellerName: string | null;
  reporterId: string;
  reason: string;
  details: string | null;
  status: string;
  createdAt: number;
  resolvedBy: string | null;
  resolvedAt: number | null;
}

/**
 * One row of `GET /api/admin/reset-requests` (admin only). `token` is a RAW reset token,
 * freshly minted by that read -- see the warning the admin panel shows before loading it.
 */
export interface AdminResetRequest {
  userId: string;
  username: string;
  name: string;
  email: string | null;
  token: string;
  expiresAt: number;
}
