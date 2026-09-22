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

export interface Bid {
  id: string;
  auctionId: string;
  userId: string;
  userName: string;
  amount: number;
  timestamp: number;
}

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
  startingPrice: number;
  currentPrice: number;
  sellerId: string;
  sellerName: string;
  highestBidderId: string | null;
  highestBidderName: string | null;
  durationMinutes: number;
  startTime: number;
  endTime: number;
  status: 'active' | 'ended' | 'cancelled' | 'hidden';
  category?: string;
  imageUrl?: string;
  imageUrls?: string[];
  /**
   * Present instead of `imageUrls` on rows from the paginated `GET /api/auctions` list endpoint
   * AND on `GET /api/auctions/:id` (single-item detail) - neither ships any image data at all
   * (see `mapAuctionDetailRow` in `workers/index.ts`), to keep both the list page and the
   * every-3s-polled detail modal light. `AuctionCard`/`AuctionDetailModal` use this to decide
   * whether to fetch real image data from `GET /api/auctions/:id/images`, at most once per id.
   * `imageUrls`/`imageUrl` are only ever present on a row from that images route, from `POST
   * /api/auctions` (create), or from a `PATCH` (edit) response.
   */
  imageCount?: number;
  bids: Bid[];
  winnerId?: string | null;
  winnerName?: string | null;
  winningBid?: number | null;
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
  bids: AuctionItem[];
  wins: AuctionItem[];
}

export type NotificationType = 'outbid' | 'won' | 'lost' | 'sold';

/** One row of `GET /api/notifications` (auth required). `id` is stable across calls. */
export interface AppNotification {
  id: string;
  type: NotificationType;
  auctionId: string;
  auctionTitle: string;
  amount: number;
  timestamp: number;
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

export interface PlaceBidPayload {
  auctionId: string;
  userId: string;
  userName: string;
  amount: number;
}

export interface BidUpdatePayload {
  auctionId: string;
  currentPrice: number;
  highestBidderId: string;
  highestBidderName: string;
  bid: Bid;
  auction: AuctionItem;
}

export interface AuctionEndedPayload {
  auctionId: string;
  winnerId: string | null;
  winnerName: string | null;
  winningBid: number | null;
  auction: AuctionItem;
}
