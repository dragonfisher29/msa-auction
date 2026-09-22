/**
 * Logic shared by the Cloudflare Worker (`workers/index.ts`) and the local
 * Express dev server (`server.ts`).
 *
 * Anything in here must stay runtime-agnostic: no Node built-ins, no Express,
 * no Socket.io. The Supabase client is always passed in by the caller so the
 * same code runs on Workers and on Node.
 */

export interface ActivityBid {
  userId: string;
  userName: string;
  amount: number;
  timestamp: number;
}

/**
 * The minimal camelCase auction shape the shared helpers need. Both
 * `mapAuctionRow` (Worker) and `sanitizeAuction` (dev server) produce a
 * superset of this, so each file keeps using its own row mapper.
 */
export interface ActivityAuction {
  id: string;
  title: string;
  sellerId: string;
  status: string;
  currentPrice: number;
  highestBidderId: string | null;
  endTime: number;
  createdAt: number;
  bids: ActivityBid[];
  winnerId?: string | null;
  winningBid?: number | null;
}

/**
 * The slim shape `GET /api/auctions` returns. Deliberately carries NO image
 * payload: shipping images to every polling client was the single largest
 * source of traffic on the site. Clients read `imageCount` and fetch the
 * references from `GET /api/auctions/:id/images` when they need to paint them.
 *
 * `image_urls` holds base64 `data:` URLs today - R2 is implemented but switched
 * off, see the image storage section below - so the bytes themselves come out
 * of Postgres and this omission is worth a great deal. It stays worth keeping
 * even if R2 is switched on and the column shrinks to `/images/<key>` paths:
 * the list endpoint is polled continuously and has no reason to carry images in
 * either form.
 */
export interface AuctionSummary {
  id: string;
  title: string;
  description: string;
  phoneNumber: string;
  startingPrice: number;
  currentPrice: number;
  sellerId: string;
  sellerName: string;
  highestBidderId: string | null;
  highestBidderName: string | null;
  durationMinutes: number;
  startTime: number;
  endTime: number;
  status: string;
  category: string;
  imageCount: number;
  bids: ActivityBid[];
  winnerId: string | null;
  winnerName: string | null;
  winningBid: number | null;
  createdAt: number;
}

export interface NotificationItem {
  id: string;
  type: 'outbid' | 'won' | 'lost' | 'sold';
  auctionId: string;
  auctionTitle: string;
  amount: number;
  timestamp: number;
}

export interface SettleOptions {
  /** Injectable clock, mainly for tests. */
  now?: number;
  /** Restrict the sweep to a single auction (used by GET /api/auctions/:id). */
  auctionId?: string;
}

/**
 * The four values the `auctions.status` column is allowed to hold.
 *
 * `cancelled` is a SOFT delete by the seller: the row (and its bid history)
 * stays readable by id forever, it is hidden from the default list, and
 * settlement ignores it.
 *
 * `hidden` is the same shape of soft-hide, applied by an ADMIN instead of the
 * seller (`POST /api/admin/auctions/:id/hide`). It behaves exactly like
 * `cancelled` for the list and for settlement; it is a separate value purely so
 * a takedown is distinguishable from a seller withdrawing their own listing.
 */
export const AUCTION_STATUS = {
  active: 'active',
  ended: 'ended',
  cancelled: 'cancelled',
  hidden: 'hidden',
} as const;

/**
 * Statuses kept out of `GET /api/auctions`. Both stay fetchable by id so a
 * bidder keeps their history and an admin can still review a takedown.
 */
export const LIST_EXCLUDED_STATUSES = [AUCTION_STATUS.cancelled, AUCTION_STATUS.hidden] as const;

function toBidArray(value: unknown): ActivityBid[] {
  if (Array.isArray(value)) {
    return value as ActivityBid[];
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as ActivityBid[]) : [];
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Winner of an auction, derived from its bid history. The highest amount wins;
 * ties go to whoever placed the bid first. Auctions with no bids have no
 * winner and keep null winner columns.
 */
export function resolveWinner(row: any): {
  winnerId: string | null;
  winnerName: string | null;
  winningBid: number | null;
} {
  const bids = toBidArray(row?.bids);

  let best: ActivityBid | null = null;
  for (const bid of bids) {
    const amount = Number(bid?.amount);
    if (!Number.isFinite(amount)) {
      continue;
    }

    if (
      !best ||
      amount > Number(best.amount) ||
      (amount === Number(best.amount) && Number(bid.timestamp) < Number(best.timestamp))
    ) {
      best = bid;
    }
  }

  const fallbackId = row?.highest_bidder_id ?? row?.highestBidderId ?? null;

  if (best) {
    // A prior bid-race bug could clobber an entry out of `bids` while `current_price` kept
    // the higher value it was last written with. When that value beats the top of the bid
    // array and a highest bidder is on record, the column is the authoritative one -- trust
    // it over the damaged array instead of settling the wrong winner.
    const currentPrice = Number(row?.current_price ?? row?.currentPrice);
    if (fallbackId && Number.isFinite(currentPrice) && currentPrice > Number(best.amount)) {
      return {
        winnerId: fallbackId,
        winnerName: row?.highest_bidder_name ?? row?.highestBidderName ?? null,
        winningBid: currentPrice,
      };
    }

    return {
      winnerId: best.userId ?? null,
      winnerName: best.userName ?? null,
      winningBid: Number(best.amount),
    };
  }

  // Defensive fallback for legacy rows that recorded a highest bidder without a
  // bid history. No bidder at all means no winner.
  if (fallbackId) {
    const fallbackPrice = Number(row?.current_price ?? row?.currentPrice);
    return {
      winnerId: fallbackId,
      winnerName: row?.highest_bidder_name ?? row?.highestBidderName ?? null,
      winningBid: Number.isFinite(fallbackPrice) ? fallbackPrice : null,
    };
  }

  return { winnerId: null, winnerName: null, winningBid: null };
}

/**
 * THE settle path. Used by the Worker cron trigger, by the lazy settle in both
 * GET handlers, and by the dev server's interval sweep, so dev and prod cannot
 * drift.
 *
 * Every UPDATE is guarded on `status = 'active'` so two concurrent settlers
 * cannot both write a winner. Returns the rows this call actually settled.
 */
export async function settleEndedAuctions(supabase: any, options: SettleOptions = {}): Promise<any[]> {
  const now = options.now ?? Date.now();

  // `.eq('status', 'active')` is what keeps CANCELLED and HIDDEN listings out of
  // settlement: such a row is neither selected here nor matched by the guarded
  // UPDATE below, so it can never be handed a winner. Do not relax this filter.
  let query = supabase.from('auctions').select('*').eq('status', AUCTION_STATUS.active).lte('end_time', now);
  if (options.auctionId) {
    query = query.eq('id', options.auctionId);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  const settled: any[] = [];

  for (const row of data ?? []) {
    const { winnerId, winnerName, winningBid } = resolveWinner(row);
    const patch = {
      status: 'ended',
      winner_id: winnerId,
      winner_name: winnerName,
      winning_bid: winningBid,
    };

    const { data: updated, error: updateError } = await supabase
      .from('auctions')
      .update(patch)
      .eq('id', row.id)
      .eq('status', AUCTION_STATUS.active)
      .select();

    if (updateError) {
      throw updateError;
    }

    // Zero rows means another settler (cron vs. a concurrent read) got there
    // first. Leave their write alone.
    if (!Array.isArray(updated) || updated.length === 0) {
      continue;
    }

    settled.push(updated[0] ?? { ...row, ...patch });
  }

  return settled;
}

function latestOwnBidTimestamp(auction: ActivityAuction, userId: string): number | null {
  let latest: number | null = null;
  for (const bid of auction.bids ?? []) {
    if (bid?.userId !== userId) {
      continue;
    }
    const timestamp = Number(bid.timestamp);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    if (latest === null || timestamp > latest) {
      latest = timestamp;
    }
  }
  return latest;
}

function hasBidFrom(auction: ActivityAuction, userId: string): boolean {
  return (auction.bids ?? []).some((bid) => bid?.userId === userId);
}

/** Auctions a user listed, bid on, and won. */
export function selectActivity<T extends ActivityAuction>(
  auctions: T[],
  userId: string,
): { listings: T[]; bids: T[]; wins: T[] } {
  const listings = auctions
    .filter((auction) => auction.sellerId === userId)
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));

  const bids = auctions
    .filter((auction) => hasBidFrom(auction, userId))
    .sort((a, b) => (latestOwnBidTimestamp(b, userId) ?? 0) - (latestOwnBidTimestamp(a, userId) ?? 0));

  const wins = auctions
    .filter((auction) => auction.status === 'ended' && auction.winnerId === userId)
    .sort((a, b) => Number(b.endTime) - Number(a.endTime));

  return { listings, bids, wins };
}

const MAX_NOTIFICATIONS = 50;

/**
 * Notifications are derived on every request from the auction rows themselves
 * - there is no notifications table and no read/unread column. Ids are stable
 * for a given event so the client can keep dismissed ids in localStorage.
 */
export function buildNotifications(auctions: ActivityAuction[], userId: string): NotificationItem[] {
  const notifications: NotificationItem[] = [];

  for (const auction of auctions) {
    const isSeller = auction.sellerId === userId;
    const didBid = hasBidFrom(auction, userId);
    const ended = auction.status === 'ended';
    const winnerId = auction.winnerId ?? null;
    const winningBid = Number(auction.winningBid ?? 0);

    if (!ended && didBid && auction.highestBidderId && auction.highestBidderId !== userId) {
      const mine = latestOwnBidTimestamp(auction, userId);
      const sortedBids = [...(auction.bids ?? [])].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
      // The bid that actually overtook me: the first one placed by someone else
      // after my most recent bid. Picking the *first* such bid (rather than the
      // newest) keeps the notification id stable as later bids arrive.
      const outbiddingBid =
        sortedBids.find((bid) => bid.userId !== userId && mine !== null && Number(bid.timestamp) > mine) ??
        sortedBids[sortedBids.length - 1];

      if (outbiddingBid) {
        notifications.push({
          id: `outbid_${auction.id}_${Number(outbiddingBid.timestamp)}`,
          type: 'outbid',
          auctionId: auction.id,
          auctionTitle: auction.title,
          amount: Number(auction.currentPrice),
          timestamp: Number(outbiddingBid.timestamp),
        });
      }
    }

    if (ended && winnerId && winnerId === userId) {
      notifications.push({
        id: `won_${auction.id}`,
        type: 'won',
        auctionId: auction.id,
        auctionTitle: auction.title,
        amount: winningBid,
        timestamp: Number(auction.endTime),
      });
    }

    if (ended && didBid && winnerId && winnerId !== userId) {
      notifications.push({
        id: `lost_${auction.id}`,
        type: 'lost',
        auctionId: auction.id,
        auctionTitle: auction.title,
        amount: winningBid,
        timestamp: Number(auction.endTime),
      });
    }

    if (ended && isSeller && winnerId) {
      notifications.push({
        id: `sold_${auction.id}`,
        type: 'sold',
        auctionId: auction.id,
        auctionTitle: auction.title,
        amount: winningBid,
        timestamp: Number(auction.endTime),
      });
    }
  }

  return notifications.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_NOTIFICATIONS);
}

/* -------------------------------------------------------------------------- */
/* Listing edit / cancel                                                       */
/* -------------------------------------------------------------------------- */

/** Fields a seller may change after the listing is live. Nothing else is writable. */
export const EDITABLE_AUCTION_FIELDS = [
  'title',
  'description',
  'phoneNumber',
  'category',
  'imageUrls',
  'startingPrice',
] as const;

export type EditableAuctionField = (typeof EDITABLE_AUCTION_FIELDS)[number];

export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Merges a PATCH body over the stored row so the SAME `validateAuctionInput`
 * that guards listing creation can validate a partial edit. Only the fields in
 * `EDITABLE_AUCTION_FIELDS` are taken from the body; everything else (notably
 * `durationMinutes`, which would move `end_time` and break the list's keyset
 * cursor) comes from the row and is therefore unchangeable.
 */
export function mergeAuctionEdit(row: any, body: any): Record<string, unknown> {
  const patch = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const has = (field: EditableAuctionField) => Object.prototype.hasOwnProperty.call(patch, field);

  return {
    title: has('title') ? patch.title : row.title,
    description: has('description') ? patch.description : row.description,
    phoneNumber: has('phoneNumber') ? patch.phoneNumber : (row.phone_number ?? row.phoneNumber),
    category: has('category') ? patch.category : (row.category ?? 'General'),
    imageUrls: has('imageUrls') ? patch.imageUrls : toStringArray(row.image_urls ?? row.imageUrls),
    startingPrice: has('startingPrice') ? patch.startingPrice : (row.starting_price ?? row.startingPrice),
    // Not editable - carried over purely so the shared validator is satisfied.
    durationMinutes: Number(row.duration_minutes ?? row.durationMinutes),
  };
}

/* -------------------------------------------------------------------------- */
/* Auction list: slim columns + keyset pagination                              */
/* -------------------------------------------------------------------------- */

/**
 * Explicit column list for `GET /api/auctions`.
 *
 * `image_url` and `image_urls` are absent ON PURPOSE - see `AuctionSummary`.
 * `image_count` is a STORED GENERATED column added by
 * `migrations/001_listing_lifecycle_and_list_payload.sql`; that migration must
 * be applied before this build is deployed or the list query will fail with
 * Postgres 42703 (undefined column).
 */
export const AUCTION_LIST_COLUMNS = [
  'id',
  'title',
  'description',
  'phone_number',
  'starting_price',
  'current_price',
  'seller_id',
  'seller_name',
  'highest_bidder_id',
  'highest_bidder_name',
  'duration_minutes',
  'start_time',
  'end_time',
  'status',
  'category',
  'image_count',
  'bids',
  'winner_id',
  'winner_name',
  'winning_bid',
  'created_at',
].join(',');

/**
 * Explicit column list for `GET /api/notifications`. Only what
 * `buildNotifications` actually reads off an `ActivityAuction` - no image
 * columns, and no seller/bidder display names either, since notifications
 * carry no name of their own.
 */
export const NOTIFICATION_COLUMNS = [
  'id',
  'title',
  'seller_id',
  'status',
  'current_price',
  'highest_bidder_id',
  'end_time',
  'created_at',
  'bids',
  'winner_id',
  'winning_bid',
].join(',');

export const DEFAULT_AUCTION_PAGE_SIZE = 24;
export const MAX_AUCTION_PAGE_SIZE = 60;

/** Ids are generated as `auc_<millis>_<base36>`; anything else is not one of ours. */
const AUCTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface AuctionCursor {
  endTime: number;
  id: string;
}

export function normalizeAuctionLimit(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AUCTION_PAGE_SIZE;
  }
  return Math.min(Math.floor(parsed), MAX_AUCTION_PAGE_SIZE);
}

function toBase64Url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

/** Opaque to the client: `<end_time>:<id>`, base64url encoded. */
export function encodeAuctionCursor(endTime: unknown, id: unknown): string {
  return toBase64Url(`${Number(endTime)}:${String(id)}`);
}

/**
 * Returns null for anything malformed. The decoded id is pattern-checked
 * because it is interpolated into a PostgREST `or=` filter string, which is
 * parsed as an expression by the server - an unchecked value there is an
 * injection sink.
 */
export function decodeAuctionCursor(cursor: unknown): AuctionCursor | null {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 256) {
    return null;
  }

  let decoded: string;
  try {
    decoded = fromBase64Url(cursor);
  } catch {
    return null;
  }

  const separator = decoded.indexOf(':');
  if (separator <= 0) {
    return null;
  }

  const endTime = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (!Number.isFinite(endTime) || !id || !AUCTION_ID_PATTERN.test(id)) {
    return null;
  }

  return { endTime, id };
}

/** Row -> `AuctionSummary`. Mirrors the field names of the full row mappers. */
/**
 * Coerces a money column to a number, preserving NULL as null.
 *
 * NEEDED BECAUSE OF MIGRATION 004. PostgREST serialises a Postgres `numeric` as
 * a JSON **string** ("400.00"), not a number - JSON numbers cannot carry
 * arbitrary precision, so the wire format keeps the decimal as text. Every
 * other money field here was already wrapped in `Number(...)`; `winning_bid`
 * was not, because as a `double precision` it arrived as a JSON number and the
 * declared `winningBid: number | null` happened to be true by accident.
 *
 * After 004 it stops being true unless it is coerced here. Doing it at the
 * mapping boundary keeps the API contract honest and is why no client change is
 * needed: `src/` never sees the raw row.
 *
 * `?? null` is not enough on its own - it would pass the string straight
 * through. `Number('')` is 0, so a non-finite result falls back to null rather
 * than inventing a zero winning bid.
 */
export function toNullableMoney(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function mapAuctionSummaryRow(row: any): AuctionSummary {
  const rawCount = row.image_count ?? row.imageCount;
  const imageCount = Number.isFinite(Number(rawCount))
    ? Number(rawCount)
    : toStringArray(row.image_urls ?? row.imageUrls).length;

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    phoneNumber: row.phone_number ?? row.phoneNumber,
    startingPrice: Number(row.starting_price ?? row.startingPrice),
    currentPrice: Number(row.current_price ?? row.currentPrice),
    sellerId: row.seller_id ?? row.sellerId,
    sellerName: row.seller_name ?? row.sellerName,
    highestBidderId: row.highest_bidder_id ?? row.highestBidderId ?? null,
    highestBidderName: row.highest_bidder_name ?? row.highestBidderName ?? null,
    durationMinutes: Number(row.duration_minutes ?? row.durationMinutes),
    startTime: Number(row.start_time ?? row.startTime),
    endTime: Number(row.end_time ?? row.endTime),
    status: row.status,
    category: row.category ?? 'General',
    imageCount,
    bids: toBidArray(row.bids),
    winnerId: row.winner_id ?? row.winnerId ?? null,
    winnerName: row.winner_name ?? row.winnerName ?? null,
    winningBid: toNullableMoney(row.winning_bid ?? row.winningBid),
    createdAt: Number(row.created_at ?? row.createdAt),
  };
}

export interface AuctionListPage {
  auctions: AuctionSummary[];
  nextCursor: string | null;
}

/**
 * One page of the public auction list, newest-ending first.
 *
 * Ordered on `(end_time DESC, id DESC)`: a total order over two values that
 * never change after a listing is created, which is what makes the keyset
 * cursor stable while bids land and auctions settle underneath it. It also
 * keeps already-ended listings at the tail instead of at the head.
 *
 * Cancelled and admin-hidden listings are excluded here; both stay fetchable by
 * id.
 */
export async function fetchAuctionListPage(
  supabase: any,
  options: { limit?: unknown; cursor?: unknown } = {},
): Promise<AuctionListPage> {
  const limit = normalizeAuctionLimit(options.limit);

  let cursor: AuctionCursor | null = null;
  if (options.cursor !== undefined && options.cursor !== null && options.cursor !== '') {
    cursor = decodeAuctionCursor(options.cursor);
    if (!cursor) {
      throw Object.assign(new Error('Invalid pagination cursor.'), { code: 'INVALID_CURSOR' });
    }
  }

  // Two chained `neq`s rather than a `not.in`: PostgREST ANDs them, and the
  // partial index from migration 001 (`where status <> 'cancelled'`) still
  // covers the narrower predicate. Migration 003 adds an exact-match index.
  let query = supabase
    .from('auctions')
    .select(AUCTION_LIST_COLUMNS)
    .neq('status', AUCTION_STATUS.cancelled)
    .neq('status', AUCTION_STATUS.hidden);

  if (cursor) {
    query = query.or(`end_time.lt.${cursor.endTime},and(end_time.eq.${cursor.endTime},id.lt."${cursor.id}")`);
  }

  // Fetch one extra row: its existence is what tells us another page exists,
  // without a second COUNT query.
  const { data, error } = await query
    .order('end_time', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  if (error) {
    throw error;
  }

  const rows = Array.isArray(data) ? data : [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    auctions: page.map((row: any) => mapAuctionSummaryRow(row)),
    nextCursor: hasMore && last ? encodeAuctionCursor(last.end_time ?? last.endTime, last.id) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Per-auction Open Graph tags                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every value injected into the HTML shell passes through here first. Listing
 * titles and descriptions are user-supplied and land inside a quoted attribute,
 * so this is a live XSS sink - `"` and `<` MUST both be neutralised.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface AuctionMetaTags {
  title: string;
  description: string;
  /**
   * Absolute `https://` URL - the listing's own image once it is in R2, the
   * site logo until then. See `resolveOgImage`. Optional only so that a
   * malformed page URL degrades to omitting the tag rather than throwing.
   */
  image?: string;
  url: string;
}

const META_DESCRIPTION_LIMIT = 160;
export const DEFAULT_OG_IMAGE = '/MSA_Logo.png';

function truncate(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 3).trimEnd()}...`;
}

/** Raw (unescaped) preview values for one auction row. */
export function buildAuctionMetaTags(row: any, pageUrl: string): AuctionMetaTags {
  const price = Number(row?.current_price ?? row?.currentPrice);
  const status = String(row?.status ?? AUCTION_STATUS.active);
  const priceLabel = Number.isFinite(price) ? `£${price.toLocaleString('en-GB')}` : '';
  const statusLabel =
    status === AUCTION_STATUS.ended
      ? 'Ended'
      : status === AUCTION_STATUS.cancelled
        ? 'Withdrawn'
        : status === AUCTION_STATUS.hidden
          ? 'Unavailable'
          : 'Bidding now';

  const title = String(row?.title ?? 'Auction');
  // Either column may hold either storage form during the rollout, so the
  // reference is resolved rather than emitted verbatim.
  const reference = String(row?.image_url ?? row?.imageUrl ?? '') || toStringArray(row?.image_urls)[0] || '';

  return {
    title: priceLabel ? `${title} - ${priceLabel} | MSA Auction` : `${title} | MSA Auction`,
    description: truncate(
      `${statusLabel}${priceLabel ? ` at ${priceLabel}` : ''}. ${String(row?.description ?? '')}`,
      META_DESCRIPTION_LIMIT,
    ),
    image: resolveOgImage(reference, pageUrl),
    url: pageUrl,
  };
}

// The shell ships one static title/description/og:* set. Leaving those in place
// and appending ours would give crawlers two of each - most take the first - so
// the originals are stripped before the auction-specific block is inserted.
const STATIC_TITLE_PATTERN = /<title\b[^>]*>[\s\S]*?<\/title>\s*/i;
const STATIC_META_PATTERN =
  /<meta\b[^>]*?(?:name|property)\s*=\s*["'](?:description|og:title|og:description|og:image|og:url|og:type|twitter:card|twitter:title|twitter:description|twitter:image)["'][^>]*>\s*/gi;

/**
 * Returns the shell with auction-specific preview tags. Pure string work: the
 * caller is responsible for never letting a failure here break the page.
 */
export function injectAuctionMeta(html: string, meta: AuctionMetaTags): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const url = escapeHtml(meta.url);

  const block = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    // Omitted entirely when there is no URL a crawler could actually fetch.
    ...(meta.image ? [`<meta property="og:image" content="${escapeHtml(meta.image)}" />`] : []),
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:type" content="product" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ].join('\n    ');

  const stripped = html.replace(STATIC_TITLE_PATTERN, '').replace(STATIC_META_PATTERN, '');

  if (/<\/head>/i.test(stripped)) {
    return stripped.replace(/<\/head>/i, `  ${block}\n  </head>`);
  }

  return `${block}\n${stripped}`;
}

/** `/auction/:id` -> the id, or null for any other path. */
export function matchAuctionSharePath(pathname: string): string | null {
  const match = pathname.match(/^\/auction\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }
  const id = decodeURIComponent(match[1]);
  return AUCTION_ID_PATTERN.test(id) ? id : null;
}

/**
 * Columns the OG path needs.
 *
 * `image_url` is here because `og:image` needs the listing's first image, and
 * a listing stored in R2 needs it to emit a working preview.
 *
 * COST NOTE, while R2 is off. Every value in this column is a base64 `data:`
 * URL, so each crawler hit on `/auction/:id` pulls a whole image out of
 * Postgres in order for `resolveOgImage` to look at it, reject it, and emit the
 * logo instead. That is real egress for no benefit. It is left in place anyway:
 * dropping it would silently break previews the moment R2 is switched on, and
 * this route is hit by crawlers rather than by the polling clients that
 * dominate the traffic. Revisit it if egress measurement singles this out.
 */
export const AUCTION_META_COLUMNS = 'id,title,description,current_price,status,image_url';

/* -------------------------------------------------------------------------- */
/* Result type shared by the route helpers below                               */
/* -------------------------------------------------------------------------- */

/**
 * The helpers in the rest of this file are called from BOTH entry points, which
 * return errors in different ways (`Response` in the Worker, `res.status().json()`
 * in Express). They therefore return a plain result the caller maps, rather
 * than building a response themselves.
 */
export interface SharedFailure {
  ok: false;
  status: number;
  message: string;
  code: string;
}

export interface SharedSuccess<T> {
  ok: true;
  data: T;
}

export type SharedResult<T> = SharedSuccess<T> | SharedFailure;

/**
 * Use this rather than `if (!result.ok)`: this project compiles without
 * `strictNullChecks`, and TypeScript will not narrow a boolean-literal
 * discriminant in that mode. An explicit type predicate narrows either way.
 */
export function isFailure<T>(result: SharedResult<T>): result is SharedFailure {
  return result.ok === false;
}

function fail(status: number, message: string, code: string): SharedFailure {
  return { ok: false, status, message, code };
}

function succeed<T>(data: T): SharedSuccess<T> {
  return { ok: true, data };
}

/* -------------------------------------------------------------------------- */
/* Passwords                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * PBKDF2-HMAC-SHA256 over WebCrypto, which both runtimes expose: Workers has it
 * as a global, Node 18+ as `globalThis.crypto`. No Node built-in is imported
 * here, so this file stays runtime-agnostic.
 *
 * Stored form is self-describing so the parameters can be raised later without
 * another migration:
 *
 *     pbkdf2$<iterations>$<saltBase64>$<hashBase64>
 *
 * It replaces a single-round unsalted SHA-256 hex digest. That legacy format is
 * still ACCEPTED at login (see `verifyPassword`) and rewritten to this one on
 * the first successful sign-in - see `verifyAndUpgradePassword`. Nothing ever
 * rejects a password purely for being stored in the old format.
 *
 * ITERATION COUNT: set to 10,000, down from an earlier 100,000. At 100,000
 * rounds a single derivation measured ~12.1ms of CPU, which exceeds
 * Cloudflare's free Workers tier 10ms CPU cap and would break login and
 * registration on the deployed site. The owner made an explicit call that this
 * is an acceptable trade-off here: these accounts only gate editing your own
 * listing and guard no sensitive data, so a lower iteration count is fine.
 *
 * Because the iteration count is embedded in the stored string above, raising
 * this constant again later needs no migration - `verifyPassword` reads the
 * count FROM the stored hash, not from this constant, so old hashes keep
 * verifying at whatever count they were written with.
 */
export const PBKDF2_ITERATIONS = 10_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BITS = 256;
const PBKDF2_PREFIX = 'pbkdf2';

/** The old format: a bare 64-character SHA-256 hex digest, no salt, one round. */
const LEGACY_HASH_PATTERN = /^[0-9a-f]{64}$/i;

function webCrypto(): Crypto {
  const available = (globalThis as any).crypto;
  if (!available || !available.subtle) {
    throw new Error('WebCrypto is not available in this runtime.');
  }
  return available as Crypto;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let index = 0; index < bytes.length; index += 1) {
    hex += bytes[index].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Byte-wise comparison whose running time does not depend on WHERE the first
 * difference is. A plain `===` on a secret leaks that position through timing,
 * which is enough to walk a hash out of the server one byte at a time.
 *
 * Length is compared up front on purpose: both operands here are fixed-width
 * digests, so their length is not itself a secret.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

/** As `timingSafeEqualBytes`, for two ASCII strings (hex digests, token hashes). */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return timingSafeEqualBytes(encoder.encode(a), encoder.encode(b));
}

/** SHA-256 as lowercase hex. Also the legacy password format, hence the reuse. */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await webCrypto().subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const subtle = webCrypto().subtle;
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    PBKDF2_KEY_BITS,
  );
  return new Uint8Array(derived);
}

/**
 * Hashes a password for storage. A fresh random salt per call, so two accounts
 * that pick the same password never share a stored value.
 *
 * `options` exists for tests (and for a future parameter bump); production
 * never passes it.
 */
export async function hashPassword(
  password: string,
  options: { iterations?: number; salt?: Uint8Array } = {},
): Promise<string> {
  const iterations = options.iterations ?? PBKDF2_ITERATIONS;
  const salt = options.salt ?? webCrypto().getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const derived = await deriveBits(password, salt, iterations);
  return `${PBKDF2_PREFIX}$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

export type StoredPassword =
  | { format: 'pbkdf2'; iterations: number; salt: Uint8Array; hash: Uint8Array }
  | { format: 'legacy-sha256'; hex: string }
  | { format: 'unknown' };

/** Classifies a stored `password_hash`. Never throws on a malformed value. */
export function parseStoredPassword(stored: unknown): StoredPassword {
  if (typeof stored !== 'string' || stored.length === 0) {
    return { format: 'unknown' };
  }

  if (LEGACY_HASH_PATTERN.test(stored)) {
    return { format: 'legacy-sha256', hex: stored.toLowerCase() };
  }

  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PBKDF2_PREFIX) {
    return { format: 'unknown' };
  }

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    return { format: 'unknown' };
  }

  try {
    return { format: 'pbkdf2', iterations, salt: base64ToBytes(parts[2]), hash: base64ToBytes(parts[3]) };
  } catch {
    return { format: 'unknown' };
  }
}

export interface PasswordVerification {
  valid: boolean;
  /** True when the password checked out but is stored in the legacy format. */
  needsUpgrade: boolean;
}

/**
 * Checks a supplied password against whatever is on the row - PBKDF2 or the
 * legacy digest. A legacy hit reports `needsUpgrade` so the caller can rewrite
 * it; it is NEVER a rejection.
 */
export async function verifyPassword(password: string, stored: unknown): Promise<PasswordVerification> {
  const parsed = parseStoredPassword(stored);

  if (parsed.format === 'pbkdf2') {
    const derived = await deriveBits(password, parsed.salt, parsed.iterations);
    return { valid: timingSafeEqualBytes(derived, parsed.hash), needsUpgrade: false };
  }

  if (parsed.format === 'legacy-sha256') {
    const digest = await sha256Hex(password);
    const valid = timingSafeEqualStrings(digest, parsed.hex);
    return { valid, needsUpgrade: valid };
  }

  return { valid: false, needsUpgrade: false };
}

/**
 * THE login password check, used by both entry points.
 *
 * On a correct password stored in the legacy format the row is rewritten to
 * PBKDF2 in place, so the whole user table migrates itself as people sign in.
 * The rewrite is guarded on the old value, so a concurrent login or password
 * reset cannot be clobbered by a slower upgrade. A failed rewrite is logged and
 * swallowed: it must never turn a valid sign-in into an error.
 *
 * Nothing here logs the password or the stored hash.
 */
export async function verifyAndUpgradePassword(supabase: any, userRow: any, password: string): Promise<boolean> {
  const stored = userRow?.password_hash ?? userRow?.passwordHash;
  const { valid, needsUpgrade } = await verifyPassword(password, stored);

  if (!valid) {
    return false;
  }

  if (needsUpgrade) {
    try {
      const upgraded = await hashPassword(password);
      await supabase
        .from('users')
        .update({ password_hash: upgraded })
        .eq('id', userRow.id)
        .eq('password_hash', stored);
    } catch (error) {
      console.error('Password hash upgrade failed for user', userRow?.id, error);
    }
  }

  return true;
}

/* -------------------------------------------------------------------------- */
/* Email addresses                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately loose: a local part, an `@`, and a domain with at least one dot
 * and no empty labels. Anything stricter starts rejecting real addresses, and
 * the only thing that actually proves an address works is sending to it.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const EMAIL_MAX_LENGTH = 254;

/** Lowercased and trimmed, or null when it is not a plausible address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const email = raw.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX_LENGTH) {
    return null;
  }

  return EMAIL_PATTERN.test(email) ? email : null;
}

/** Registration: an absent email is fine, a malformed one is not. */
export function validateOptionalEmail(raw: unknown): SharedResult<string | null> {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return succeed(null);
  }

  const email = normalizeEmail(raw);
  if (!email) {
    return fail(400, 'Enter a valid email address.', 'INVALID_EMAIL');
  }

  return succeed(email);
}

/**
 * `POST /api/auth/email` - attach or change the caller's recovery address.
 * The case-insensitive unique index from migration 002 is the real guard; this
 * pre-check only turns the resulting 23505 into a readable message.
 */
export async function setUserEmail(supabase: any, userId: string, raw: unknown): Promise<SharedResult<{ email: string }>> {
  const email = normalizeEmail(raw);
  if (!email) {
    return fail(400, 'Enter a valid email address.', 'INVALID_EMAIL');
  }

  const { data: existing, error: existingError } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existing && existing.id !== userId) {
    return fail(409, 'That email address is already attached to another account.', 'EMAIL_TAKEN');
  }

  const { error: updateError } = await supabase.from('users').update({ email }).eq('id', userId);
  if (updateError) {
    throw updateError;
  }

  return succeed({ email });
}

/* -------------------------------------------------------------------------- */
/* Password reset                                                              */
/* -------------------------------------------------------------------------- */

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const RESET_TOKEN_BYTES = 32;

/** 256 bits of CSPRNG output, base64url so it is safe in a link. */
export function generateResetToken(): string {
  return bytesToBase64Url(webCrypto().getRandomValues(new Uint8Array(RESET_TOKEN_BYTES)));
}

/**
 * `POST /api/auth/request-reset`.
 *
 * Returns NOTHING - not the token, not whether the account exists. The caller
 * always answers with the same generic 200, which is what stops this route
 * being a username/email oracle.
 *
 * Only the SHA-256 hash of the token is stored. The raw token exists in memory
 * for the length of this call and is then gone; it is never written, returned
 * or logged.
 */
export async function createPasswordResetRequest(
  supabase: any,
  usernameOrEmail: unknown,
  options: { now?: number } = {},
): Promise<void> {
  const identifier = typeof usernameOrEmail === 'string' ? usernameOrEmail.trim().toLowerCase() : '';
  if (!identifier) {
    return;
  }

  const { data: byUsername, error: usernameError } = await supabase
    .from('users')
    .select('*')
    .eq('username', identifier)
    .maybeSingle();

  if (usernameError) {
    throw usernameError;
  }

  let user = byUsername ?? null;

  if (!user) {
    const { data: byEmail, error: emailError } = await supabase
      .from('users')
      .select('*')
      .eq('email', identifier)
      .maybeSingle();

    if (emailError) {
      throw emailError;
    }

    user = byEmail ?? null;
  }

  // No account, no recovery address, or a banned account: do the same nothing,
  // and still answer 200 upstream.
  if (!user || !user.email || isBannedUser(user)) {
    return;
  }

  const now = options.now ?? Date.now();
  const token = generateResetToken();

  const { error: updateError } = await supabase
    .from('users')
    .update({
      reset_token_hash: await sha256Hex(token),
      reset_token_expires: now + RESET_TOKEN_TTL_MS,
    })
    .eq('id', user.id);

  if (updateError) {
    throw updateError;
  }
}

export interface ResetPasswordResult {
  user: { id: string; name: string; username: string; token: string };
}

/**
 * `POST /api/auth/reset-password`.
 *
 * Single use: the UPDATE is guarded on the same token hash it matched, so a
 * replayed token touches zero rows. A successful reset also mints a fresh
 * session token, which - because `users.token` is single-valued - signs every
 * other session out.
 */
export async function resetPasswordWithToken(
  supabase: any,
  rawToken: unknown,
  newPassword: unknown,
  options: { now?: number } = {},
): Promise<SharedResult<ResetPasswordResult>> {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  const password = typeof newPassword === 'string' ? newPassword.trim() : '';

  if (!token || !password) {
    return fail(400, 'A reset token and a new password are required.', 'MISSING_FIELDS');
  }

  const tokenHash = await sha256Hex(token);

  const { data: user, error: lookupError } = await supabase
    .from('users')
    .select('*')
    .eq('reset_token_hash', tokenHash)
    .maybeSingle();

  if (lookupError) {
    throw lookupError;
  }

  if (!user) {
    return fail(400, 'That reset link is not valid. Please request a new one.', 'INVALID_RESET_TOKEN');
  }

  const now = options.now ?? Date.now();
  if (!user.reset_token_expires || Number(user.reset_token_expires) <= now) {
    return fail(400, 'That reset link has expired. Please request a new one.', 'RESET_TOKEN_EXPIRED');
  }

  if (isBannedUser(user)) {
    return fail(403, bannedMessage(user), 'ACCOUNT_BANNED');
  }

  const sessionToken = `tok_${webCrypto().randomUUID()}`;

  const { data: updated, error: updateError } = await supabase
    .from('users')
    .update({
      password_hash: await hashPassword(password),
      token: sessionToken,
      reset_token_hash: null,
      reset_token_expires: null,
    })
    .eq('id', user.id)
    .eq('reset_token_hash', tokenHash)
    .select();

  if (updateError) {
    throw updateError;
  }

  // Zero rows: the token was consumed between the read and the write.
  if (!Array.isArray(updated) || updated.length === 0) {
    return fail(400, 'That reset link has already been used. Please request a new one.', 'RESET_TOKEN_USED');
  }

  return succeed({
    user: { id: user.id, name: user.name, username: user.username, token: sessionToken },
  });
}

export interface PendingResetRequest {
  userId: string;
  username: string;
  name: string;
  email: string | null;
  token: string;
  expiresAt: number;
}

/**
 * Backs `GET /api/admin/reset-requests`. INTERIM MEASURE - see the route.
 *
 * Because only the token HASH is stored, a pending request's raw token cannot
 * be read back. This therefore MINTS a fresh token for every account with a
 * live request, stores the new hash, and returns the new raw token once. Two
 * consequences worth knowing:
 *   - reading this list invalidates any link handed out from a previous read;
 *   - the 60-minute window restarts at each read.
 * Both are preferable to keeping raw reset tokens in the database.
 */
export async function listPendingResetRequests(
  supabase: any,
  options: { now?: number } = {},
): Promise<PendingResetRequest[]> {
  const now = options.now ?? Date.now();

  // A NULL `reset_token_expires` never satisfies `>`, so accounts with no
  // pending request are excluded without a second predicate.
  const { data, error } = await supabase
    .from('users')
    .select('id,username,name,email,reset_token_expires')
    .gt('reset_token_expires', now);

  if (error) {
    throw error;
  }

  const pending: PendingResetRequest[] = [];

  for (const row of data ?? []) {
    const token = generateResetToken();
    const expiresAt = now + RESET_TOKEN_TTL_MS;

    const { error: updateError } = await supabase
      .from('users')
      .update({ reset_token_hash: await sha256Hex(token), reset_token_expires: expiresAt })
      .eq('id', row.id);

    if (updateError) {
      throw updateError;
    }

    pending.push({
      userId: row.id,
      username: row.username,
      name: row.name,
      email: row.email ?? null,
      token,
      expiresAt,
    });
  }

  return pending;
}

/* -------------------------------------------------------------------------- */
/* Roles and bans                                                              */
/* -------------------------------------------------------------------------- */

export const USER_ROLE = {
  member: 'member',
  admin: 'admin',
} as const;

/**
 * Role is read from the DATABASE ROW and nowhere else. A `role` in a request
 * body is never consulted by anything in this file, and must never be.
 */
export function isAdminUser(row: any): boolean {
  return String(row?.role ?? USER_ROLE.member) === USER_ROLE.admin;
}

export function isBannedUser(row: any): boolean {
  const bannedAt = row?.banned_at ?? row?.bannedAt ?? null;
  return bannedAt !== null && bannedAt !== undefined && Number(bannedAt) > 0;
}

export function bannedMessage(row: any): string {
  const reason = row?.banned_reason ?? row?.bannedReason;
  return reason
    ? `Your account has been suspended. Reason: ${String(reason)}`
    : 'Your account has been suspended. Contact the committee if you think this is a mistake.';
}

/**
 * Whether a caller may see a `'hidden'` auction row. Every other status is
 * visible to everyone; `'hidden'` is visible ONLY to an admin - it exists so
 * an admin can review what a takedown removed, not so the link keeps working
 * for whoever already had it. This is the ONE place that decision is made:
 * the detail fetch, the images fetch, and the Open Graph injector all call
 * this rather than re-deriving the rule.
 */
export function isAuctionVisible(row: any, isAdmin: boolean): boolean {
  return String(row?.status ?? '') !== AUCTION_STATUS.hidden || isAdmin;
}

/**
 * Resolves whether an `Authorization` header belongs to an admin, WITHOUT
 * ever turning a missing or invalid token into an error: `GET /api/auctions/:id`
 * and its `/images` sibling are intentionally unauthenticated routes, so a
 * caller with no header or a dead token is simply "not an admin", exactly
 * like an anonymous visitor.
 */
export async function isBearerTokenAdmin(supabase: any, authorizationHeader: unknown): Promise<boolean> {
  if (!supabase || typeof authorizationHeader !== 'string' || !authorizationHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authorizationHeader.slice('Bearer '.length).trim();
  if (!token) {
    return false;
  }

  try {
    const { data, error } = await supabase.from('users').select('role').eq('token', token).maybeSingle();
    if (error || !data) {
      return false;
    }
    return isAdminUser(data);
  } catch {
    return false;
  }
}

const BAN_REASON_LIMIT = 500;

export interface BanResult {
  user: { id: string; username: string; name: string; bannedAt: number | null; bannedReason: string | null };
}

/**
 * `POST /api/admin/users/:id/ban` and `.../unban`.
 *
 * The session token is deliberately LEFT INTACT: authentication still resolves
 * the row, so `requireUser` can answer 403 ACCOUNT_BANNED everywhere at once.
 * Clearing the token instead would produce a misleading "session expired".
 */
export async function setUserBan(
  supabase: any,
  options: { userId: string; adminId: string; banned: boolean; reason?: unknown; now?: number },
): Promise<SharedResult<BanResult>> {
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';

  if (options.banned) {
    if (!reason) {
      return fail(400, 'A reason is required to ban an account.', 'MISSING_REASON');
    }
    if (reason.length > BAN_REASON_LIMIT) {
      return fail(400, `Keep the reason under ${BAN_REASON_LIMIT} characters.`, 'REASON_TOO_LONG');
    }
    if (options.userId === options.adminId) {
      return fail(400, 'You cannot ban your own account.', 'CANNOT_BAN_SELF');
    }
  }

  const { data: target, error: lookupError } = await supabase
    .from('users')
    .select('*')
    .eq('id', options.userId)
    .maybeSingle();

  if (lookupError) {
    throw lookupError;
  }

  if (!target) {
    return fail(404, 'That account was not found.', 'USER_NOT_FOUND');
  }

  // Admins cannot ban each other: one compromised or angry committee account
  // should not be able to lock the rest of the committee out of the site.
  if (options.banned && isAdminUser(target)) {
    return fail(403, 'Admin accounts cannot be banned from here.', 'CANNOT_BAN_ADMIN');
  }

  const bannedAt = options.banned ? (options.now ?? Date.now()) : null;
  const bannedReason = options.banned ? reason : null;

  const { error: updateError } = await supabase
    .from('users')
    .update({ banned_at: bannedAt, banned_reason: bannedReason })
    .eq('id', options.userId);

  if (updateError) {
    throw updateError;
  }

  return succeed({
    user: {
      id: target.id,
      username: target.username,
      name: target.name,
      bannedAt,
      bannedReason,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Reporting and takedowns                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The ONLY accepted reasons. Free text goes in `details`; the reason itself is
 * a closed set so the admin queue can be triaged and counted.
 */
export const REPORT_REASONS = ['scam', 'prohibited', 'offensive', 'wrong_category', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUS = {
  open: 'open',
  actioned: 'actioned',
  dismissed: 'dismissed',
} as const;

const REPORT_DETAILS_LIMIT = 1000;
const HIDE_REASON_LIMIT = 500;
const ADMIN_REPORT_PAGE_SIZE = 200;

export interface ReportView {
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

export function mapReportRow(row: any, auction?: any): ReportView {
  return {
    id: row.id,
    auctionId: row.auction_id ?? row.auctionId,
    auctionTitle: auction?.title ?? null,
    sellerId: auction?.seller_id ?? auction?.sellerId ?? null,
    sellerName: auction?.seller_name ?? auction?.sellerName ?? null,
    reporterId: row.reporter_id ?? row.reporterId,
    reason: row.reason,
    details: row.details ?? null,
    status: row.status,
    createdAt: Number(row.created_at ?? row.createdAt),
    resolvedBy: row.resolved_by ?? row.resolvedBy ?? null,
    resolvedAt: row.resolved_at ?? row.resolvedAt ?? null,
  };
}

export interface CreateReportResult {
  report: ReportView;
  /** True when the caller already had an open report on this listing. */
  duplicate: boolean;
}

/**
 * `POST /api/auctions/:id/report`.
 *
 * One OPEN report per user per listing. A second one is not an error - the
 * reporter did nothing wrong and should not be told whether their first report
 * landed - so a duplicate returns the existing report with `duplicate: true`.
 */
export async function createAuctionReport(
  supabase: any,
  options: { auctionId: string; reporterId: string; reason: unknown; details?: unknown; now?: number },
): Promise<SharedResult<CreateReportResult>> {
  const reason = typeof options.reason === 'string' ? options.reason.trim().toLowerCase() : '';

  if (!(REPORT_REASONS as readonly string[]).includes(reason)) {
    return fail(400, `Pick a reason from: ${REPORT_REASONS.join(', ')}.`, 'INVALID_REPORT_REASON');
  }

  const details = typeof options.details === 'string' ? options.details.trim() : '';
  if (details.length > REPORT_DETAILS_LIMIT) {
    return fail(400, `Keep the extra detail under ${REPORT_DETAILS_LIMIT} characters.`, 'REPORT_DETAILS_TOO_LONG');
  }

  const { data: auction, error: auctionError } = await supabase
    .from('auctions')
    .select('id,title,seller_id,seller_name')
    .eq('id', options.auctionId)
    .maybeSingle();

  if (auctionError) {
    throw auctionError;
  }

  if (!auction) {
    return fail(404, 'Auction not found', 'AUCTION_NOT_FOUND');
  }

  const { data: existing, error: existingError } = await supabase
    .from('reports')
    .select('*')
    .eq('auction_id', options.auctionId)
    .eq('reporter_id', options.reporterId)
    .eq('status', REPORT_STATUS.open)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existing) {
    return succeed({ report: mapReportRow(existing, auction), duplicate: true });
  }

  const now = options.now ?? Date.now();
  const row = {
    id: `rep_${now}_${Math.random().toString(36).slice(2, 6)}`,
    auction_id: options.auctionId,
    reporter_id: options.reporterId,
    reason,
    details: details || null,
    status: REPORT_STATUS.open,
    created_at: now,
    resolved_by: null,
    resolved_at: null,
  };

  const { error: insertError } = await supabase.from('reports').insert([row]);
  if (insertError) {
    throw insertError;
  }

  return succeed({ report: mapReportRow(row, auction), duplicate: false });
}

/**
 * `GET /api/admin/reports` - open reports first, each carrying the reported
 * listing's title and seller so an admin can triage without opening every one.
 */
export async function listReportsForAdmin(supabase: any): Promise<ReportView[]> {
  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(ADMIN_REPORT_PAGE_SIZE);

  if (error) {
    throw error;
  }

  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) {
    return [];
  }

  const auctionIds = Array.from(new Set(rows.map((row: any) => row.auction_id ?? row.auctionId)));
  const { data: auctionRows, error: auctionError } = await supabase
    .from('auctions')
    .select('id,title,seller_id,seller_name')
    .in('id', auctionIds);

  if (auctionError) {
    throw auctionError;
  }

  const byId = new Map<string, any>();
  for (const auction of auctionRows ?? []) {
    byId.set(auction.id, auction);
  }

  return rows
    .map((row: any) => mapReportRow(row, byId.get(row.auction_id ?? row.auctionId)))
    .sort((a, b) => {
      const aOpen = a.status === REPORT_STATUS.open ? 0 : 1;
      const bOpen = b.status === REPORT_STATUS.open ? 0 : 1;
      return aOpen !== bOpen ? aOpen - bOpen : b.createdAt - a.createdAt;
    });
}

export interface HideAuctionResult {
  auctionId: string;
  status: string;
  hiddenReason: string;
  /** Open reports on this listing that were closed as `actioned` by the hide. */
  reportsActioned: number;
}

/**
 * `POST /api/admin/auctions/:id/hide` - a soft takedown.
 *
 * Sets `status = 'hidden'`, which drops the listing out of `GET /api/auctions`
 * and out of settlement exactly as `'cancelled'` does, while leaving it
 * fetchable by id so an admin (or anyone holding the link) can still see what
 * was taken down. Any open reports on the listing are closed as `actioned` in
 * the same call, so the queue does not grow forever.
 */
export async function hideAuction(
  supabase: any,
  options: { auctionId: string; adminId: string; reason: unknown; now?: number },
): Promise<SharedResult<HideAuctionResult>> {
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';

  if (!reason) {
    return fail(400, 'A reason is required to hide a listing.', 'MISSING_REASON');
  }

  if (reason.length > HIDE_REASON_LIMIT) {
    return fail(400, `Keep the reason under ${HIDE_REASON_LIMIT} characters.`, 'REASON_TOO_LONG');
  }

  const { data: row, error: fetchError } = await supabase
    .from('auctions')
    .select('id,status')
    .eq('id', options.auctionId)
    .maybeSingle();

  if (fetchError) {
    throw fetchError;
  }

  if (!row) {
    return fail(404, 'Auction not found', 'AUCTION_NOT_FOUND');
  }

  const now = options.now ?? Date.now();

  const { error: updateError } = await supabase
    .from('auctions')
    .update({
      status: AUCTION_STATUS.hidden,
      hidden_reason: reason,
      hidden_by: options.adminId,
      hidden_at: now,
    })
    .eq('id', options.auctionId);

  if (updateError) {
    throw updateError;
  }

  const { data: actioned, error: reportError } = await supabase
    .from('reports')
    .update({ status: REPORT_STATUS.actioned, resolved_by: options.adminId, resolved_at: now })
    .eq('auction_id', options.auctionId)
    .eq('status', REPORT_STATUS.open)
    .select();

  if (reportError) {
    throw reportError;
  }

  return succeed({
    auctionId: options.auctionId,
    status: AUCTION_STATUS.hidden,
    hiddenReason: reason,
    reportsActioned: Array.isArray(actioned) ? actioned.length : 0,
  });
}

// ---------------------------------------------------------------------------
// The bid optimistic lock
// ---------------------------------------------------------------------------

/**
 * THE bid optimistic lock, shared by the Worker and the dev server so the two
 * cannot drift.
 *
 * WHY THIS IS NOT GUARDED ON THE PRICE ANY MORE. The guard used to be
 * `.eq('current_price', <the value read off the row>)`. `auctions.current_price`
 * was `double precision` on the live database, so that was exact equality on a
 * binary float, asserted across a read -> JSON -> JS number -> PostgREST text
 * filter -> float8 parse round trip. A pence value such as 150.10 has no exact
 * binary representation, and nothing in that chain guarantees identical bits for
 * such a value - it depends on the server's float output precision, on the
 * driver's number formatting, and on whether the value needs all 17 significant
 * digits to round-trip. When it does not reproduce, the UPDATE matches zero
 * rows, all three retries burn, and an entirely uncontended bid answers 409
 * BID_CONFLICT.
 *
 * Migration 004 converts the money columns to `numeric(12,2)`, which fixes the
 * storage. But guarding a lock on a *money value* stays fragile no matter what
 * type holds it, so the guard now rides on `auctions.bid_version`: a monotonic
 * integer, bumped by exactly one per successful bid. Integer equality has no
 * representation to get wrong.
 */
export const BID_VERSION_COLUMN = 'bid_version';

export interface BidLock {
  /**
   * True when the row carried a usable `bid_version`, i.e. migration 004 has
   * run. False means the Worker is deployed ahead of the migration.
   */
  hasVersion: boolean;
  /** The version read off the row. Only meaningful when `hasVersion`. */
  version: number;
  /**
   * The raw `current_price` off the row, kept verbatim for the pre-004 fallback
   * guard: Postgres `=` never matches NULL, so a null price needs `.is(_, null)`
   * rather than `.eq(_, null)`.
   */
  rawCurrentPrice: unknown;
  hasCurrentPrice: boolean;
  /** The price a new bid has to beat. */
  currentPrice: number;
}

/**
 * Reads the lock state off a freshly-fetched auction row.
 *
 * `startingPrice` is the fallback for a row that has never been bid on and so
 * carries a NULL `current_price`.
 */
export function readBidLock(rawAuction: any, startingPrice: number): BidLock {
  const rawCurrentPrice = rawAuction?.current_price ?? rawAuction?.currentPrice ?? null;
  const hasCurrentPrice = rawCurrentPrice !== null && rawCurrentPrice !== undefined;

  // A row from before migration 004 has no such property at all; a row from
  // after it always has an integer, because the column is NOT NULL DEFAULT 0.
  // Anything else - null, a non-integer, a negative - is treated as absent,
  // which degrades to the old guard rather than to no guard.
  const rawVersion = rawAuction?.[BID_VERSION_COLUMN] ?? rawAuction?.bidVersion;
  const version = Number(rawVersion);
  const hasVersion =
    rawVersion !== null && rawVersion !== undefined && Number.isInteger(version) && version >= 0;

  return {
    hasVersion,
    version: hasVersion ? version : 0,
    rawCurrentPrice,
    hasCurrentPrice,
    currentPrice: hasCurrentPrice ? Number(rawCurrentPrice) : startingPrice,
  };
}

/**
 * The lock's own contribution to the UPDATE payload.
 *
 * When `bid_version` exists it is advanced by one. When it does not, nothing is
 * written - naming a column PostgREST does not know about would fail the whole
 * UPDATE with PGRST204, which is precisely the "deployed before the migration"
 * case this has to survive.
 */
export function bidLockUpdate(lock: BidLock): Record<string, number> {
  return lock.hasVersion ? { [BID_VERSION_COLUMN]: lock.version + 1 } : {};
}

/**
 * Applies the guard predicate to the bid UPDATE.
 *
 * Exactly one predicate is applied on every path - the guard is never dropped:
 *   - `bid_version` present  ->  `.eq('bid_version', <version read>)`
 *   - absent, price non-null ->  `.eq('current_price', <raw value read>)`
 *   - absent, price NULL     ->  `.is('current_price', null)`   (first bid)
 *
 * The second and third are the pre-004 behaviour, kept verbatim so a Worker
 * running ahead of the migration is no worse off than it is today.
 */
export function applyBidLock(query: any, lock: BidLock): any {
  if (lock.hasVersion) {
    return query.eq(BID_VERSION_COLUMN, lock.version);
  }

  return lock.hasCurrentPrice
    ? query.eq('current_price', lock.rawCurrentPrice)
    : query.is('current_price', null);
}

/* -------------------------------------------------------------------------- */
/* Image storage: Cloudflare R2                                                */
/* -------------------------------------------------------------------------- */

/**
 * WHY THIS EXISTS.
 *
 * Images are stored as base64 `data:` URLs inside `auctions.image_urls`.
 * Postgres holds the bytes, so every image a browser paints is Supabase egress
 * - 21GB against a 5GB allowance. R2 has no egress fee, so the code below moves
 * the bytes there and leaves the database holding only a short `/images/<key>`
 * path.
 *
 * ...EXCEPT THAT R2 IS CURRENTLY TURNED OFF. Enabling R2 needs a payment method
 * on the Cloudflare account, and this is a society's project, so the
 * `[[r2_buckets]]` block in wrangler.toml is commented out. Everything in this
 * section still works and is still tested; it simply has no bucket bound, and
 * every caller checks for that before using it. Base64 is therefore the live
 * default, and the first measure being tried against egress is the polling fix
 * rather than object storage. See wrangler.toml for how to switch R2 on.
 *
 * MIXED STATE IS THE NORMAL STATE. From the moment R2 is switched on until the
 * last backfill batch finishes, one listing's `image_urls` can hold a legacy
 * `data:` URL and an `/images/<key>` path side by side. Nothing here may assume
 * a row is entirely one form or entirely the other, which is why every
 * predicate below tests a single entry rather than a whole row. That stays true
 * in the other direction too: if R2 is switched on, used, and switched off
 * again, already-migrated rows keep their paths and new listings go back to
 * base64. Both remain valid input to `validateAuctionInput`.
 */

/**
 * The single wire contract for "object storage is not available right now".
 *
 * Returned by `POST /api/images` with status 503 and code
 * `IMAGE_STORAGE_UNAVAILABLE`. The client keys off that CODE to fall back to
 * inlining a base64 `data:` URL, so the code is load-bearing and the message is
 * only for humans. Both the Worker and the Express dev server return the same
 * pair, so a fallback that works locally works in production.
 */
export const IMAGE_STORAGE_UNAVAILABLE_MESSAGE =
  'Object storage is not configured, so images cannot be uploaded to it. The listing will store its images inline instead.';

/** The admin-facing version, which names the binding rather than reassuring. */
export const IMAGE_BACKFILL_UNAVAILABLE_MESSAGE =
  'The IMAGES R2 binding is not configured, so there is nothing to migrate images into. Create the bucket and uncomment [[r2_buckets]] in wrangler.toml, then redeploy and run this again.';

/** Hard ceiling on an uploaded image, enforced on the decoded byte length. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The only types accepted on upload, and the extension each is stored under.
 * Deliberately not a general MIME table: these bytes are served back from our
 * own origin, so the list stays as small as the product actually needs.
 */
export const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Path prefix under which R2 objects are served. */
export const IMAGE_PATH_PREFIX = '/images/';

/**
 * Objects are keyed by a random UUID, never by anything the uploader supplied,
 * so a key is unguessable and a filename can never steer the storage path.
 */
const IMAGE_UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IMAGE_EXTENSION_SOURCE = 'jpg|png|webp|gif';

/** A bare object key: `<uuid>.<ext>`. */
export const IMAGE_KEY_PATTERN = new RegExp(`^${IMAGE_UUID_SOURCE}\\.(?:${IMAGE_EXTENSION_SOURCE})$`);

/** A stored reference as it appears in `image_urls`: `/images/<uuid>.<ext>`. */
export const IMAGE_PATH_PATTERN = new RegExp(`^${IMAGE_PATH_PREFIX}${IMAGE_UUID_SOURCE}\\.(?:${IMAGE_EXTENSION_SOURCE})$`);

/**
 * Keys are unique per upload and an object is never rewritten under an existing
 * key, so the bytes at a given key are immutable and can be cached forever.
 */
export const IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Canonicalises a `Content-Type` header down to one of the four accepted types,
 * or null. Parameters (`; charset=...`) are dropped and case is normalised;
 * nothing else is accepted, including the common-but-invalid `image/jpg`.
 */
export function normalizeImageMime(contentType: unknown): string | null {
  if (typeof contentType !== 'string') {
    return null;
  }

  const base = contentType.split(';')[0].trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME_EXTENSIONS, base) ? base : null;
}

/**
 * Identifies the real format from the leading bytes.
 *
 * The declared `Content-Type` is a claim by whoever is uploading; this is the
 * bytes themselves. `POST /api/images` requires the two to agree, because the
 * object it writes is later served from our own origin - a file that claims to
 * be a PNG while actually being something a browser will run as another type is
 * the whole attack this closes.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 12) {
    return null;
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 "PNG" CR LF SUB LF
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // GIF: "GIF87a" or "GIF89a"
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }

  // WebP: "RIFF" <4 byte length> "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

/** True for a reference this codebase stored in R2. */
export function isStoredImagePath(value: unknown): boolean {
  return typeof value === 'string' && IMAGE_PATH_PATTERN.test(value.trim());
}

/**
 * True for a legacy inline image.
 *
 * Deliberately permissive about the exact media type and payload: these strings
 * are already in the database and `mergeAuctionEdit` feeds them back through
 * `validateAuctionInput` on every edit. A stricter test here would make an old
 * listing uneditable, which is a worse outcome than accepting an odd but
 * long-standing `data:image/...` value.
 */
export function isDataImageUrl(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('data:image/');
}

/**
 * The whitelist `validateAuctionInput` applies to every image entry.
 *
 * An arbitrary `https://` URL is NOT acceptable. Storing one would let listing
 * creation point the site's own markup at any third-party host, which is an
 * open-redirect / SSRF-adjacent surface and would also hand that host a log of
 * every visitor who viewed the listing.
 */
export function isAllowedImageRef(value: unknown): boolean {
  return isStoredImagePath(value) || isDataImageUrl(value);
}

/**
 * `/images/<key>` -> the key, or null when the path is not one of ours.
 *
 * The pattern is anchored and allows only hex, dashes and a known extension, so
 * traversal (`..`, an embedded `/`) and any other crafted key are refused
 * before R2 is ever consulted.
 */
export function matchImageServePath(pathname: string): string | null {
  if (typeof pathname !== 'string' || !pathname.startsWith(IMAGE_PATH_PREFIX)) {
    return null;
  }

  const key = pathname.slice(IMAGE_PATH_PREFIX.length);
  return IMAGE_KEY_PATTERN.test(key) ? key : null;
}

/** A fresh, unguessable object key for a known-good MIME type. */
export function newImageKey(mime: string): string {
  const extension = IMAGE_MIME_EXTENSIONS[mime];
  if (!extension) {
    throw new Error(`newImageKey: unsupported image type "${mime}"`);
  }

  return `${crypto.randomUUID()}.${extension}`;
}

export interface ValidatedImageUpload {
  /** The sniffed type, which is also what the object is stored and served as. */
  mime: string;
  key: string;
}

/**
 * The full upload gate: declared type, size, then the bytes themselves.
 *
 * Ordered cheapest-first - a header check, then a length check, then the sniff -
 * so a junk request is refused before anything is read into R2.
 */
export function validateImageUpload(declaredType: unknown, bytes: Uint8Array): SharedResult<ValidatedImageUpload> {
  const declared = normalizeImageMime(declaredType);
  if (!declared) {
    return fail(400, 'Upload a JPEG, PNG, WebP, or GIF image.', 'UNSUPPORTED_IMAGE_TYPE');
  }

  if (!bytes || bytes.length === 0) {
    return fail(400, 'The uploaded image was empty.', 'UNSUPPORTED_IMAGE_TYPE');
  }

  if (bytes.length > MAX_IMAGE_BYTES) {
    return fail(413, 'Images must be 5 MB or smaller.', 'IMAGE_TOO_LARGE');
  }

  const sniffed = sniffImageMime(bytes);
  if (!sniffed || sniffed !== declared) {
    return fail(400, 'That file is not a valid JPEG, PNG, WebP, or GIF image.', 'UNSUPPORTED_IMAGE_TYPE');
  }

  return succeed({ mime: sniffed, key: newImageKey(sniffed) });
}

export interface DecodedImage {
  mime: string;
  bytes: Uint8Array;
}

/**
 * Decodes a legacy `data:` URL into raw bytes for the backfill.
 *
 * `atob` is used rather than a Node Buffer so this file stays runtime-agnostic;
 * both Workers and Node 18+ expose it as a global.
 */
export function decodeImageDataUrl(value: unknown): DecodedImage | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,([\s\S]*)$/i.exec(value.trim());
  if (!match) {
    return null;
  }

  const base64 = (match[2] ?? '').replace(/\s+/g, '');
  if (!base64) {
    return null;
  }

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  // The declared type in the data URL is ignored in favour of the bytes, so a
  // mislabelled legacy row cannot put a wrongly-typed object into R2.
  const sniffed = sniffImageMime(bytes);
  return sniffed ? { mime: sniffed, bytes } : null;
}

/** Writes one object, tagging it with the type the serve route will echo back. */
export async function putImage(bucket: any, key: string, bytes: Uint8Array, mime: string): Promise<void> {
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: mime, cacheControl: IMAGE_CACHE_CONTROL },
  });
}

/* -------------------------------------------------------------------------- */
/* Open Graph image                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the `og:image` value. Always absolute, because crawlers do not
 * resolve a relative path.
 *
 *   R2 path -> that image.
 *   anything else -> the site logo.
 *
 * WITH R2 OFF, THE SECOND BRANCH IS THE ONLY ONE THAT RUNS. Every listing's
 * first image is a `data:` URL, so every shared link previews as the MSA logo.
 * That is not a regression - it is exactly what the live site does today - and
 * it is the reason the fallback below has to stay.
 *
 * WHY A `data:` URL FALLS BACK TO THE LOGO RATHER THAN EMITTING NOTHING.
 *
 * A base64 `data:` URL is rejected by every link-preview crawler, so it can
 * never be emitted. The tempting conclusion is to emit no `og:image` at all for
 * such a listing - but that would be a REGRESSION against what is live today.
 * The static shell carries a logo `og:image`, and
 * `injectAuctionMeta` strips the shell's tags before inserting these; emitting
 * nothing would therefore turn today's logo preview into a blank card in
 * iMessage, Slack and WhatsApp, for precisely the listings that are most
 * numerous on day one, and it would stay that way until the backfill finished.
 *
 * A logo preview is worse than the listing's photo and better than nothing.
 */
export function resolveOgImage(reference: unknown, pageUrl: string): string | undefined {
  const toAbsolute = (relative: string): string | undefined => {
    try {
      return new URL(relative, pageUrl).toString();
    } catch {
      return undefined;
    }
  };

  if (isStoredImagePath(reference)) {
    return toAbsolute(String(reference).trim());
  }

  // Legacy inline image, no image, or anything unrecognised.
  return toAbsolute(DEFAULT_OG_IMAGE);
}

/* -------------------------------------------------------------------------- */
/* Backfill: data: URLs -> R2                                                  */
/* -------------------------------------------------------------------------- */

export interface ImageMigrationFailure {
  auctionId: string;
  error: string;
}

/**
 * How the batch found its work.
 *
 * This exists to keep two very different situations from looking identical
 * from the outside. The backfill loop stops when `migrated` comes back 0, and
 * "there is nothing left to do" is not the only way to get that number: if the
 * indexed `image_url like 'data:%'` filter ever matched nothing on a database
 * that really does hold inline images, phase 1 would also report 0.
 *
 * `listingsWithImages` is counted WITHOUT that filter, so the two cases can be
 * told apart. See DEPLOY.md 5.5.3 for what the owner should see on call one.
 */
export interface ImageMigrationScan {
  /** Rows the indexed `image_url like 'data:%'` filter returned this call. */
  fastPathMatched: number;
  /** Rows the phase-2 full scan examined this call. */
  fallbackScanned: number;
  /**
   * Listings holding at least one image at all, via `image_count`. Does not go
   * through the `like` filter, and so is the control value for it.
   */
  listingsWithImages: number;
}

export interface ImageMigrationResult {
  migrated: number;
  remaining: number;
  failures: ImageMigrationFailure[];
  scan: ImageMigrationScan;
}

export const IMAGE_MIGRATION_DEFAULT_LIMIT = 10;
export const IMAGE_MIGRATION_MAX_LIMIT = 50;

/** Columns the backfill reads. `image_urls` is the payload; the rest are guards. */
const IMAGE_MIGRATION_COLUMNS = 'id,image_url,image_urls,image_count,status';

/** Rows pulled per scan query. Independent of `limit`, which counts conversions. */
const IMAGE_MIGRATION_PAGE = 25;

/** Stops a pathological scan from running unbounded inside one request. */
const IMAGE_MIGRATION_MAX_PAGES = 20;

/** PostgREST `like` pattern matching a legacy inline image. */
const LEGACY_IMAGE_LIKE = 'data:%';

export function clampImageMigrationLimit(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return IMAGE_MIGRATION_DEFAULT_LIMIT;
  }

  const floored = Math.floor(parsed);
  if (floored < 1) {
    return IMAGE_MIGRATION_DEFAULT_LIMIT;
  }

  return Math.min(floored, IMAGE_MIGRATION_MAX_LIMIT);
}

/** True when any entry on the row is still inline, in either column. */
export function rowHasLegacyImage(row: any): boolean {
  if (isDataImageUrl(row?.image_url)) {
    return true;
  }

  return toStringArray(row?.image_urls).some((entry) => isDataImageUrl(entry));
}

/**
 * Converts one row's inline images and writes the row back.
 *
 * Returns false when there was nothing to do, which is what makes a second run
 * over an already-migrated row a no-op rather than a duplicate upload.
 */
async function migrateOneAuction(supabase: any, bucket: any, row: any): Promise<boolean> {
  const stored = toStringArray(row?.image_urls);
  // A row whose array is empty but whose legacy singular column still holds an
  // image is rebuilt from that column, so no image is left behind.
  const source = stored.length > 0 ? stored : isDataImageUrl(row?.image_url) ? [String(row.image_url)] : [];

  if (source.length === 0) {
    return false;
  }

  const converted: string[] = [];
  let changed = false;

  for (const entry of source) {
    // Already an R2 path (or anything else non-inline) - carried through
    // untouched. This is the mixed-array case, and it is the common one.
    if (!isDataImageUrl(entry)) {
      converted.push(entry);
      continue;
    }

    const decoded = decodeImageDataUrl(entry);
    if (!decoded) {
      throw new Error('Inline image is not decodable base64 in a supported format.');
    }

    const key = newImageKey(decoded.mime);
    await putImage(bucket, key, decoded.bytes, decoded.mime);
    converted.push(`${IMAGE_PATH_PREFIX}${key}`);
    changed = true;
  }

  if (!changed) {
    return false;
  }

  // GUARD. The row is rewritten only while it still looks the way it did when
  // it was read, so a seller who edited this listing between the read and the
  // write is not silently overwritten with the images they just replaced.
  //
  // `auctions` has no row-version column that an edit bumps (`bid_version`
  // tracks bids, not edits), and the value that WOULD be exact - the old
  // `image_urls` - is megabytes of base64 and cannot go in a query string. So
  // the guard rides on the two cheap columns an edit does move: the image count
  // and the status.
  let update = supabase
    .from('auctions')
    .update({ image_urls: converted, image_url: converted[0] })
    .eq('id', row.id);

  if (typeof row?.status === 'string' && row.status) {
    update = update.eq('status', row.status);
  }

  const count = Number(row?.image_count);
  if (Number.isInteger(count)) {
    update = update.eq('image_count', count);
  }

  const { data, error } = await update.select('id');
  if (error) {
    throw error;
  }

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Listing changed while it was being migrated; left for the next run.');
  }

  return true;
}

/**
 * Walks one candidate query, converting rows until `budget` conversions land.
 *
 * A row that throws is recorded and added to `skipIds`; it never aborts the
 * batch and is not attempted twice within the same call.
 */
async function migrateCandidatePages(
  supabase: any,
  bucket: any,
  buildPage: (cursor: string, pageSize: number) => any,
  budget: number,
  failures: ImageMigrationFailure[],
  skipIds: Set<string>,
): Promise<{ migrated: number; exhausted: boolean; examined: number }> {
  let cursor = '';
  let migrated = 0;
  let examined = 0;

  for (let page = 0; page < IMAGE_MIGRATION_MAX_PAGES; page += 1) {
    if (migrated >= budget) {
      return { migrated, exhausted: false, examined };
    }

    const { data, error } = await buildPage(cursor, IMAGE_MIGRATION_PAGE);
    if (error) {
      throw error;
    }

    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      return { migrated, exhausted: true, examined };
    }

    examined += rows.length;
    cursor = String(rows[rows.length - 1]?.id ?? '');

    for (const row of rows) {
      if (migrated >= budget) {
        return { migrated, exhausted: false, examined };
      }

      const auctionId = String(row?.id ?? '');
      if (!auctionId || skipIds.has(auctionId) || !rowHasLegacyImage(row)) {
        continue;
      }

      try {
        if (await migrateOneAuction(supabase, bucket, row)) {
          migrated += 1;
        }
      } catch (error) {
        // Recorded and stepped over. The owner sees it in `failures`; the rest
        // of the batch still runs.
        skipIds.add(auctionId);
        failures.push({
          auctionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (rows.length < IMAGE_MIGRATION_PAGE) {
      return { migrated, exhausted: true, examined };
    }
  }

  return { migrated, exhausted: false, examined };
}

/**
 * One resumable backfill batch.
 *
 * Idempotent: the work is driven entirely by what is still a `data:` URL in the
 * database, so a row that has already moved is skipped rather than re-uploaded,
 * and the whole endpoint can be called repeatedly until it reports no progress.
 *
 * Two phases, because the cheap server-side filter only covers the first image:
 *
 *   1. `image_url like 'data:%'` - every listing whose FIRST image is still
 *      inline. This is the entire backlog at the start of the rollout, and
 *      Postgres does the filtering, so no row is fetched that is not about to
 *      be converted.
 *   2. Only once phase 1 is empty: a scan of every listing that has images, to
 *      catch an inline entry sitting BEHIND an already-migrated one - the shape
 *      a seller creates by editing a half-migrated listing. This scan is only
 *      affordable because by then every first image is a short path, so the
 *      rows it reads are small.
 */
export async function migrateAuctionImages(
  supabase: any,
  bucket: any,
  options: { limit?: unknown } = {},
): Promise<ImageMigrationResult> {
  const limit = clampImageMigrationLimit(options.limit);
  const failures: ImageMigrationFailure[] = [];
  const skipIds = new Set<string>();

  const phaseOne = await migrateCandidatePages(
    supabase,
    bucket,
    (cursor, pageSize) => {
      let query = supabase.from('auctions').select(IMAGE_MIGRATION_COLUMNS).like('image_url', LEGACY_IMAGE_LIKE);
      if (cursor) {
        query = query.gt('id', cursor);
      }
      return query.order('id', { ascending: true }).limit(pageSize);
    },
    limit,
    failures,
    skipIds,
  );

  let migrated = phaseOne.migrated;
  let fallbackScanned = 0;

  // `remaining` for phase 1 is a HEAD count: PostgREST returns the number and
  // no rows, so asking costs no image bytes.
  const { count: phaseOneCount, error: countError } = await supabase
    .from('auctions')
    .select('id', { count: 'exact', head: true })
    .like('image_url', LEGACY_IMAGE_LIKE);

  if (countError) {
    throw countError;
  }

  // The control value for the `like` filter above: same table, same HEAD-only
  // cost, but reached through `image_count` instead. When this is large and
  // `fastPathMatched` is zero on a database that still holds inline images,
  // the filter is the thing at fault, not the backlog.
  const { count: withImagesCount, error: withImagesError } = await supabase
    .from('auctions')
    .select('id', { count: 'exact', head: true })
    .gt('image_count', 0);

  if (withImagesError) {
    throw withImagesError;
  }

  const listingsWithImages = Number(withImagesCount) || 0;
  let remaining = Number(phaseOneCount) || 0;

  // Phase 2 only opens once phase 1 is genuinely finished - both drained by
  // this call and reporting zero rows left.
  if (phaseOne.exhausted && remaining === 0) {
    if (migrated < limit) {
      const phaseTwo = await migrateCandidatePages(
        supabase,
        bucket,
        (cursor, pageSize) => {
          let query = supabase.from('auctions').select(IMAGE_MIGRATION_COLUMNS).gt('image_count', 0);
          if (cursor) {
            query = query.gt('id', cursor);
          }
          return query.order('id', { ascending: true }).limit(pageSize);
        },
        limit - migrated,
        failures,
        skipIds,
      );

      migrated += phaseTwo.migrated;
      fallbackScanned = phaseTwo.examined;
    }

    remaining = await countPhaseTwoRemaining(supabase);
  }

  return {
    migrated,
    remaining,
    failures,
    scan: {
      fastPathMatched: phaseOne.examined,
      fallbackScanned,
      listingsWithImages,
    },
  };
}

/**
 * Counts leftover inline entries hiding behind a migrated first image.
 *
 * There is no server-side filter for "some entry other than the first is still
 * inline", so this reads the rows - which is only acceptable because it runs
 * exclusively after phase 1, when those arrays are short paths rather than
 * base64.
 */
async function countPhaseTwoRemaining(supabase: any): Promise<number> {
  let cursor = '';
  let remaining = 0;

  for (let page = 0; page < IMAGE_MIGRATION_MAX_PAGES; page += 1) {
    let query = supabase.from('auctions').select('id,image_url,image_urls').gt('image_count', 0);
    if (cursor) {
      query = query.gt('id', cursor);
    }

    const { data, error } = await query.order('id', { ascending: true }).limit(IMAGE_MIGRATION_PAGE);
    if (error) {
      throw error;
    }

    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      return remaining;
    }

    cursor = String(rows[rows.length - 1]?.id ?? '');
    remaining += rows.filter((row: any) => rowHasLegacyImage(row)).length;

    if (rows.length < IMAGE_MIGRATION_PAGE) {
      return remaining;
    }
  }

  return remaining;
}
