/**
 * Logic used by the Cloudflare Worker (`workers/index.ts`).
 *
 * Anything in here must stay runtime-agnostic: no Node built-ins. The Supabase
 * client is always passed in by the caller, which is what lets the unit tests
 * drive these helpers against an in-memory fake.
 *
 * PRODUCT MODEL (v1). MSA Auction is a fixed-price classifieds board, not an
 * auction: a listing has one asking `price`, stays on the browse page until the
 * seller marks it sold, cancels it, or `LISTING_TTL_DAYS` pass since creation,
 * and buyers contact the seller on WhatsApp. There is no bidding, no settlement
 * and no winner. The table is still called `auctions` and the wire type is still
 * `AuctionItem` purely to limit churn.
 */

/* -------------------------------------------------------------------------- */
/* Listing status                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The values the `auctions.status` column may hold (after migration 007).
 *
 * `cancelled` is a SOFT delete by the seller: the row stays readable by id, it
 * is hidden from the browse list.
 *
 * `hidden` is the same shape of soft-hide, applied by an ADMIN instead of the
 * seller (`POST /api/admin/auctions/:id/hide`). Unlike `cancelled` it is also
 * invisible by id to everyone but an admin - see `isAuctionVisible`.
 *
 * `sold` is set by the seller through `POST /api/auctions/:id/sold`.
 *
 * `expired` is NOT in this map on purpose: it is never stored. A row is expired
 * when it is stored `active` and its `expires_at` has passed - see
 * `deriveListingStatus`, the one place that decision is made in JS, and the
 * `status = 'active' AND expires_at > now` predicate that mirrors it in SQL.
 */
export const AUCTION_STATUS = {
  active: 'active',
  sold: 'sold',
  cancelled: 'cancelled',
  hidden: 'hidden',
} as const;

/** The derived status. Never written to the database. */
export const EXPIRED_STATUS = 'expired' as const;

/**
 * The value the pre-v1 settlement cron wrote. Migration 006 converts every
 * such row, but the OLD worker keeps settling auctions until the new one is
 * deployed, so a handful can appear between 006 and 007. 007 converts those
 * too; until then `deriveListingStatus` reads them as sold/expired.
 */
export const LEGACY_ENDED_STATUS = 'ended';

export type ListingStatus = 'active' | 'sold' | 'expired' | 'cancelled' | 'hidden';

/** Default lifetime of a listing, overridable with the `LISTING_TTL_DAYS` [vars] entry. */
export const DEFAULT_LISTING_TTL_DAYS = 30;
const MAX_LISTING_TTL_DAYS = 365;
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `LISTING_TTL_DAYS` from the Worker env, in milliseconds. A missing, non-integer
 * or out-of-range value falls back to the default rather than producing a
 * listing that expires instantly or never.
 */
export function listingTtlMs(env: Record<string, any> | undefined | null): number {
  const parsed = Number(env?.LISTING_TTL_DAYS);
  const days =
    Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_LISTING_TTL_DAYS ? parsed : DEFAULT_LISTING_TTL_DAYS;
  return days * DAY_MS;
}

/**
 * Epoch-millisecond columns (`created_at`, `expires_at`, `sold_at`) are
 * `bigint`, which PostgREST may serialise as a JSON number or - for values
 * beyond 2^53, which ours never are - a string. Either way this lands on a
 * number, or null for NULL / garbage.
 */
export function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * THE status derivation. `expired` is computed here from the stored status and
 * `expires_at`; it is the JS mirror of the browse query's
 * `status = 'active' AND expires_at > now` predicate, so a row this calls
 * `active` is exactly a row the browse list shows.
 *
 * A stored-active row with a NULL `expires_at` is treated as expired, matching
 * SQL (`NULL > now` is not true). Migration 006's trigger means that should not
 * happen, but the two sides must agree if it ever does.
 */
export function deriveListingStatus(row: any, now: number = Date.now()): ListingStatus {
  const stored = String(row?.status ?? '');

  if (stored === AUCTION_STATUS.active) {
    const expiresAt = toEpochMs(row?.expires_at ?? row?.expiresAt);
    return expiresAt !== null && expiresAt > now ? 'active' : EXPIRED_STATUS;
  }

  if (stored === AUCTION_STATUS.sold || stored === AUCTION_STATUS.cancelled || stored === AUCTION_STATUS.hidden) {
    return stored;
  }

  if (stored === LEGACY_ENDED_STATUS) {
    return toEpochMs(row?.sold_at ?? row?.soldAt) !== null ? AUCTION_STATUS.sold : EXPIRED_STATUS;
  }

  // Unknown value: not live, and not a takedown. Never shown on browse.
  return EXPIRED_STATUS;
}

/** True when the listing is on the browse page right now: stored active AND not expired. */
export function isLiveListing(row: any, now: number = Date.now()): boolean {
  return deriveListingStatus(row, now) === AUCTION_STATUS.active;
}

/* -------------------------------------------------------------------------- */
/* Stale image cleanup - run by the Worker's daily cron                        */
/* -------------------------------------------------------------------------- */

/**
 * The gate. Only the exact string `true` turns the sweep on.
 *
 * Deliberately strict rather than truthy: `ENABLE_STALE_IMAGE_CLEANUP=false`,
 * `=0` and `=no` must all mean off, and anyone who typed one of those was
 * plainly trying to say off. An unset variable is off, which is the default.
 */
export const STALE_IMAGE_CLEANUP_ENV = 'ENABLE_STALE_IMAGE_CLEANUP';

/** A finished listing is in scope once this long has passed since its `expires_at`. */
export const STALE_IMAGE_GRACE_MS = 30 * DAY_MS;

/**
 * Per-run cap on how many listings one sweep blanks, so a large backlog cannot turn one cron
 * tick into an unbounded UPDATE.
 *
 * Kept well under what would risk an over-long request URL: the UPDATE below matches by
 * `.in('id', ids)`, and PostgREST puts that id list in the URL's query string rather than the
 * body. 100 ids of this project's `auc_<millis>_<base36>` id shape keeps that URL well short of
 * any limit, and at once a day that is ample throughput for a ~300-member community.
 */
export const STALE_IMAGE_CLEANUP_BATCH_LIMIT = 100;

export function isStaleImageCleanupEnabled(env: Record<string, string | undefined> | undefined | null): boolean {
  return String(env?.[STALE_IMAGE_CLEANUP_ENV] ?? '').trim().toLowerCase() === 'true';
}

/**
 * Blanks `image_url`/`image_urls` on every FINISHED listing - sold, cancelled, admin-hidden, or
 * expired - whose `expires_at` is more than `STALE_IMAGE_GRACE_MS` in the past and that still has
 * at least one image. IRREVERSIBLE: images are base64 inside Postgres, so the row is the only
 * copy and there is no backup.
 *
 * WHY ONE `expires_at` PREDICATE COVERS EVERY FINISHED STATUS, AND NEVER A LIVE LISTING.
 *   - A live listing (stored active, not expired) has `expires_at > now`, which can never also be
 *     `< now - 30 days`. So a live listing is excluded by construction, not by a status filter
 *     someone could later loosen.
 *   - An expired listing is stored `active` with a past `expires_at`, so a `status <> 'active'`
 *     filter - what the pre-v1 sweep used - would wrongly skip it forever.
 *   - A sold / cancelled / hidden listing always has an `expires_at` too (set at creation; set by
 *     migration 006 to the old `end_time` for pre-v1 rows). It is never EARLIER than the moment the
 *     listing finished (you cannot sell or cancel a listing after it expires), so measuring the
 *     grace period from it is never more aggressive than the owner-approved "30 days after the
 *     listing ended" retention - at worst it keeps photos a little longer.
 *
 * Deliberately reads no image column. The first query selects only `id`, and the UPDATE writes
 * by that id list - the whole point of this sweep is to stop spending egress on images nobody can
 * see any more. The UPDATE also re-asserts the `expires_at` cutoff, so a row whose expiry somehow
 * moved between the two statements is left alone.
 */
export async function cleanupStaleImages(supabase: any, now: number = Date.now()): Promise<number> {
  try {
    const cutoff = now - STALE_IMAGE_GRACE_MS;

    const { data, error } = await supabase
      .from('auctions')
      .select('id')
      .lt('expires_at', cutoff)
      .gt('image_count', 0)
      .limit(STALE_IMAGE_CLEANUP_BATCH_LIMIT);

    if (error) {
      console.error('Failed to find stale images:', error);
      return 0;
    }

    if (!Array.isArray(data) || data.length === 0) {
      return 0;
    }

    const ids = data.map((row: any) => row.id).filter((id: unknown) => typeof id === 'string' || typeof id === 'number');
    if (ids.length === 0) {
      return 0;
    }

    // images_version is bumped so a browser that cached these images under the old version
    // stops being served them (see imageCacheControl).
    const { error: updateError } = await supabase
      .from('auctions')
      .update({ image_url: null, image_urls: [], images_version: now })
      .in('id', ids)
      .lt('expires_at', cutoff);

    if (updateError) {
      console.error('Failed to clean up stale images:', updateError);
      return 0;
    }

    console.log(`[Maintenance] Cleaned stale images for ${ids.length} listing(s) finished more than 30 days ago.`);
    return ids.length;
  } catch (err) {
    console.error('Failed to clean up stale images:', err);
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Listing input validation                                                    */
/* -------------------------------------------------------------------------- */

/** Server-side length caps on listing text. Enforced on trimmed values. */
export const LISTING_LIMITS = {
  title: 100,
  description: 2000,
  phoneNumber: 30,
} as const;

/** Server-side length caps on account fields. Enforced on trimmed values. */
export const ACCOUNT_LIMITS = {
  name: 60,
  username: 32,
  password: 200,
} as const;

/** Highest asking price accepted, in GBP. */
export const MAX_LISTING_PRICE = 100_000;

/**
 * The categories a listing may be saved with.
 *
 * A deliberate MIRROR of `SELECTABLE_CATEGORIES` in `src/lib/categories.ts` (every entry there
 * except the `All` filter pseudo-category). It is duplicated rather than imported because that
 * module imports `lucide-react` icon components, which have no business in the Worker bundle.
 * Drift is loud: a category the server does not know comes straight back as a 400
 * INVALID_CATEGORY.
 */
export const LISTING_CATEGORIES = [
  'Electronics',
  'Vehicles',
  'Collectibles',
  'Art & Antiques',
  'Books & Media',
  'Fashion',
  'General',
] as const;

export const DEFAULT_LISTING_CATEGORY = 'General';

/**
 * Parses an asking price. Accepts a JSON number or a numeric string (PostgREST returns
 * `numeric(12,2)` as a string, and `mergeAuctionEdit` feeds the stored value back through here).
 * Returns the price rounded to exact pence, or null when it is not > 0, is over
 * `MAX_LISTING_PRICE`, or is not a whole number of pence.
 *
 * The pence check uses an epsilon rather than `Number.isInteger(price * 100)`: 19.99 * 100 is
 * 1998.9999999999998 in binary floating point, and a user who typed 19.99 did enter whole pence.
 */
export function parseListingPrice(raw: unknown): number | null {
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    value = Number(raw.trim());
  } else {
    return null;
  }

  if (!Number.isFinite(value) || value <= 0 || value > MAX_LISTING_PRICE) {
    return null;
  }

  const pence = value * 100;
  const wholePence = Math.round(pence);
  if (Math.abs(pence - wholePence) > 1e-6) {
    return null;
  }

  return wholePence / 100;
}

/** The validated, normalised fields of a listing create or edit. */
export interface ValidatedListing {
  title: string;
  description: string;
  phoneNumber: string;
  category: string;
  price: number;
  imageUrls: string[];
}

/**
 * The values already stored on the listing being edited. A submitted field that is IDENTICAL to
 * its stored value is exempt from the length / category / price-range checks, so a listing
 * created before those checks existed never becomes uneditable because of a field the seller is
 * not even touching. Required-ness is still enforced. `undefined` on create.
 */
export interface ListingBaseline {
  title?: unknown;
  description?: unknown;
  phoneNumber?: unknown;
  category?: unknown;
  price?: unknown;
  imageUrls?: string[];
}

function sameStoredValue(value: string, stored: unknown): boolean {
  return typeof stored === 'string' && stored.trim() === value;
}

/**
 * THE listing validator, used by both `POST /api/auctions` and (over `mergeAuctionEdit`'s row +
 * patch merge) `PATCH /api/auctions/:id`.
 */
export function validateListingInput(raw: any, baseline?: ListingBaseline): SharedResult<ValidatedListing> {
  if (!raw || typeof raw !== 'object') {
    return fail(400, 'Invalid listing payload.', 'INVALID_PAYLOAD');
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const phoneNumber = typeof raw.phoneNumber === 'string' ? raw.phoneNumber.trim() : '';

  if (!title || !description || !phoneNumber) {
    return fail(400, 'Title, description, and phone number are required.', 'MISSING_FIELDS');
  }

  if (title.length > LISTING_LIMITS.title && !sameStoredValue(title, baseline?.title)) {
    return fail(400, `Keep the title under ${LISTING_LIMITS.title} characters.`, 'TITLE_TOO_LONG');
  }

  if (description.length > LISTING_LIMITS.description && !sameStoredValue(description, baseline?.description)) {
    return fail(400, `Keep the description under ${LISTING_LIMITS.description} characters.`, 'DESCRIPTION_TOO_LONG');
  }

  if (phoneNumber.length > LISTING_LIMITS.phoneNumber && !sameStoredValue(phoneNumber, baseline?.phoneNumber)) {
    return fail(400, `Keep the phone number under ${LISTING_LIMITS.phoneNumber} characters.`, 'PHONE_TOO_LONG');
  }

  const rawCategory = typeof raw.category === 'string' ? raw.category.trim() : '';
  const category = rawCategory || DEFAULT_LISTING_CATEGORY;
  if (!(LISTING_CATEGORIES as readonly string[]).includes(category) && !sameStoredValue(category, baseline?.category)) {
    return fail(400, `Pick a category from: ${LISTING_CATEGORIES.join(', ')}.`, 'INVALID_CATEGORY');
  }

  let price = parseListingPrice(raw.price);
  if (price === null && baseline && raw.price !== undefined && raw.price !== null && raw.price !== '') {
    // Exempt an unchanged stored price that predates the range/pence rules.
    const stored = Number(baseline.price);
    const submitted = Number(raw.price);
    if (Number.isFinite(stored) && stored > 0 && submitted === stored) {
      price = stored;
    }
  }
  if (price === null) {
    return fail(
      400,
      `Price must be more than £0 and at most £${MAX_LISTING_PRICE.toLocaleString('en-GB')}, in whole pence.`,
      'INVALID_PRICE',
    );
  }

  const normalizedImageUrls: string[] = Array.isArray(raw.imageUrls)
    ? raw.imageUrls
        .filter((value: unknown): value is string => typeof value === 'string')
        .map((value: string) => value.trim())
        .filter((value: string) => value.length > 0)
    : [];

  const fallbackImage = typeof raw.imageUrl === 'string' ? raw.imageUrl.trim() : '';
  if (fallbackImage && normalizedImageUrls.length === 0) {
    normalizedImageUrls.push(fallbackImage);
  }

  if (normalizedImageUrls.length === 0) {
    return fail(400, 'Please upload at least one image for the listing.', 'MISSING_IMAGES');
  }

  if (normalizedImageUrls.length > 3) {
    return fail(400, 'You can upload up to 3 images per listing.', 'TOO_MANY_IMAGES');
  }

  // Each entry must be an image this site itself holds: an inline `data:` URL, or an
  // `/images/<key>` path from `POST /api/images`. An arbitrary external URL is refused.
  //
  // BOTH FORMS ARE ACCEPTED UNCONDITIONALLY, and must stay that way. R2 is off today, so every
  // new listing arrives as `data:` URLs; if it is switched on, new listings arrive as paths while
  // old rows keep their `data:` URLs, and a single listing can hold a mixture of the two.
  if (!normalizedImageUrls.every((value: string) => isAllowedImageRef(value))) {
    return fail(400, 'Listing images must be uploaded through this site.', 'INVALID_IMAGE_URL');
  }

  // Shape/size guard on a NEW inline image. An entry byte-identical to one already stored on this
  // listing is exempt, so editing an old listing never gets blocked by its own existing photos.
  const newImageFailure = validateNewInlineImages(normalizedImageUrls, baseline?.imageUrls ?? []);
  if (newImageFailure) {
    return fail(400, newImageFailure.message, newImageFailure.code);
  }

  return succeed({ title, description, phoneNumber, category, price, imageUrls: normalizedImageUrls });
}

/**
 * Account-field length caps shared by registration and password reset. Returns the failure, or
 * null when every supplied field fits.
 */
export function validateAccountFieldLengths(fields: {
  name?: string;
  username?: string;
  password?: string;
}): SharedFailure | null {
  if (fields.username !== undefined && fields.username.length > ACCOUNT_LIMITS.username) {
    return fail(400, `Keep the username under ${ACCOUNT_LIMITS.username} characters.`, 'USERNAME_TOO_LONG');
  }
  if (fields.name !== undefined && fields.name.length > ACCOUNT_LIMITS.name) {
    return fail(400, `Keep the display name under ${ACCOUNT_LIMITS.name} characters.`, 'NAME_TOO_LONG');
  }
  if (fields.password !== undefined && fields.password.length > ACCOUNT_LIMITS.password) {
    return fail(400, `Keep the password under ${ACCOUNT_LIMITS.password} characters.`, 'PASSWORD_TOO_LONG');
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Listing edit                                                                */
/* -------------------------------------------------------------------------- */

/** Fields a seller may change after the listing is live. Nothing else is writable. */
export const EDITABLE_AUCTION_FIELDS = ['title', 'description', 'phoneNumber', 'category', 'imageUrls', 'price'] as const;

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
 * Merges a PATCH body over the stored row so the SAME `validateListingInput` that guards listing
 * creation can validate a partial edit. Only the fields in `EDITABLE_AUCTION_FIELDS` are taken
 * from the body; everything else - notably `expires_at`, which an edit must never extend - comes
 * from the row and is therefore unchangeable.
 */
export function mergeAuctionEdit(row: any, body: any): Record<string, unknown> {
  const patch = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const has = (field: EditableAuctionField) => Object.prototype.hasOwnProperty.call(patch, field);

  return {
    title: has('title') ? patch.title : row.title,
    description: has('description') ? patch.description : row.description,
    phoneNumber: has('phoneNumber') ? patch.phoneNumber : (row.phone_number ?? row.phoneNumber),
    category: has('category') ? patch.category : (row.category ?? DEFAULT_LISTING_CATEGORY),
    imageUrls: has('imageUrls') ? patch.imageUrls : toStringArray(row.image_urls ?? row.imageUrls),
    price: has('price') ? patch.price : row.price,
  };
}

/** The stored values `validateListingInput` exempts on an edit - see `ListingBaseline`. */
export function listingBaselineFromRow(row: any): ListingBaseline {
  return {
    title: row?.title,
    description: row?.description,
    phoneNumber: row?.phone_number ?? row?.phoneNumber,
    category: row?.category,
    price: row?.price,
    imageUrls: toStringArray(row?.image_urls ?? row?.imageUrls),
  };
}

/* -------------------------------------------------------------------------- */
/* Column lists                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Explicit column list for `GET /api/auctions`.
 *
 * `image_url` and `image_urls` are absent ON PURPOSE: shipping images to every polling client was
 * the single largest source of traffic on the site. Clients read `image_count` (a STORED
 * GENERATED column from migration 001) and fetch the references from
 * `GET /api/auctions/:id/images` when they need to paint them.
 *
 * `phone_number` is also absent ON PURPOSE: this is the unauthenticated public list, paged
 * through by anyone, and a phone number is not something a scraper should be able to harvest
 * one page at a time. See `AUCTION_DETAIL_COLUMNS` for the routes allowed to carry it.
 *
 * `price`, `expires_at` and `sold_at` come from migration 006, which must run before this build
 * is deployed or this query fails with Postgres 42703 (undefined column).
 */
export const AUCTION_LIST_COLUMNS = [
  'id',
  'title',
  'description',
  'price',
  'seller_id',
  'seller_name',
  'status',
  'category',
  'image_count',
  'images_version',
  'created_at',
  'expires_at',
  'sold_at',
].join(',');

/**
 * `GET /api/auctions/:id` and `GET /api/users/me/activity`: the list columns plus
 * `phone_number`. The detail route only puts the number on the wire for an authenticated caller,
 * and the activity route is authenticated end to end and own-data only.
 */
export const AUCTION_DETAIL_COLUMNS = `${AUCTION_LIST_COLUMNS},phone_number`;

/**
 * The seller's own write paths (PATCH, and the row they get back): everything, including the
 * image payload, because the edit validator needs the stored images to exempt unchanged ones and
 * the response hands the edited listing straight back to the edit form.
 */
export const AUCTION_OWNER_COLUMNS = `${AUCTION_DETAIL_COLUMNS},image_url,image_urls`;

/** `GET /api/auctions/:id/images` - every image, plus what the visibility and cache checks need. */
export const AUCTION_IMAGES_COLUMNS = 'id,status,images_version,image_urls';

/**
 * `GET /api/auctions/:id/images?first=1` - the FIRST image only, for a browse card.
 *
 * `first_image:image_urls->>0` is PostgREST's JSON-operator select with an alias: Postgres
 * extracts element 0 of the jsonb array itself, and only that one string crosses the wire. The
 * other images never leave the database, which is the point - a card shows one photo, and each
 * inline photo is up to ~400 KB of base64 of Supabase egress.
 */
export const AUCTION_FIRST_IMAGE_COLUMNS = 'id,status,images_version,first_image:image_urls->>0';

/** Served for a request whose `?v=` matches the listing's current images_version. */
export const IMAGE_RESPONSE_CACHE_LONG = 'public, max-age=86400';
/** Served for an unversioned or out-of-date request: the old 5-minute window. */
export const IMAGE_RESPONSE_CACHE_SHORT = 'public, max-age=300';
/** A hidden listing's images (only ever served to an admin) are never stored by any cache. */
export const IMAGE_RESPONSE_CACHE_PRIVATE = 'private, no-store';

/**
 * The `Cache-Control` for an images response.
 *
 * A browser may keep a listing's images for a DAY only when the request named the listing's
 * CURRENT images_version (`?v=`). The version changes whenever the images do, and clients read it
 * off the (uncached) list/detail rows, so the next view after an edit asks for a new URL and a
 * day-long cache can never pin an old photo. A request with no `v`, a malformed one, or an
 * out-of-date one gets only the old 5-minute window, so a stale or older client degrades to
 * today's behaviour rather than to a day of staleness.
 */
export function imageCacheControl(row: any, requestedVersion: string | null): string {
  if (String(row?.status ?? '') === AUCTION_STATUS.hidden) {
    return IMAGE_RESPONSE_CACHE_PRIVATE;
  }

  const current = toEpochMs(row?.images_version) ?? 0;
  if (requestedVersion !== null && /^\d{1,16}$/.test(requestedVersion) && Number(requestedVersion) === current) {
    return IMAGE_RESPONSE_CACHE_LONG;
  }

  return IMAGE_RESPONSE_CACHE_SHORT;
}

/** True when an edit's image list differs from what is stored (order matters: [0] is the cover). */
export function imageListChanged(next: readonly string[], stored: readonly string[]): boolean {
  if (next.length !== stored.length) {
    return true;
  }
  // `!==` on two strings of equal length is a memcmp, not a scan per character in JS.
  return next.some((value, index) => value !== stored[index]);
}

/** What the ownership / state checks on DELETE and mark-sold need, and nothing heavier. */
export const AUCTION_STATE_COLUMNS = 'id,seller_id,status,expires_at';

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Coerces a money column to a number, preserving NULL as null.
 *
 * PostgREST serialises a Postgres `numeric` as a JSON **string** ("400.00"), not a number, so
 * every money field is coerced at this mapping boundary and `src/` never sees the raw row.
 * `Number('')` is 0, so a non-finite result falls back to null rather than inventing a zero.
 */
export function toNullableMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * The camelCase listing shape every route returns (`AuctionItem` on the client).
 *
 * `phoneNumber` is present only when the caller passed `includePhone` - see `mapListingRow`.
 * `imageUrl` / `imageUrls` are present only with `includeImages`; every read route carries
 * `imageCount` instead.
 */
export interface AuctionSummary {
  id: string;
  title: string;
  description: string;
  phoneNumber?: string;
  price: number;
  sellerId: string;
  sellerName: string;
  status: ListingStatus;
  category: string;
  imageCount: number;
  /**
   * Epoch ms of the last change to this listing's images; 0 = unchanged since v1. Clients pass it
   * as `?v=` to `GET /api/auctions/:id/images` so the response can be cached for a day and still
   * never be stale - see `imageCacheControl`.
   */
  imagesVersion: number;
  imageUrl?: string;
  imageUrls?: string[];
  createdAt: number;
  expiresAt: number;
  soldAt: number | null;
}

export interface MapListingOptions {
  /** Clock used to derive `expired`. */
  now?: number;
  /**
   * Whether `phoneNumber` goes on the wire. The CALLER decides, from the route and the request's
   * authentication - never from whether the row happens to carry the column.
   */
  includePhone?: boolean;
  /** Whether `imageUrl` / `imageUrls` go on the wire (create / edit responses only). */
  includeImages?: boolean;
}

/** THE row -> `AuctionSummary` mapper. Every route goes through here. */
export function mapListingRow(row: any, options: MapListingOptions = {}): AuctionSummary {
  const now = options.now ?? Date.now();
  const imageUrls = toStringArray(row.image_urls ?? row.imageUrls);
  const rawCount = row.image_count ?? row.imageCount;
  const imageCount = rawCount !== null && rawCount !== undefined && Number.isFinite(Number(rawCount))
    ? Number(rawCount)
    : imageUrls.length;
  const createdAt = toEpochMs(row.created_at ?? row.createdAt) ?? 0;

  const mapped: AuctionSummary = {
    id: row.id,
    title: row.title,
    description: row.description,
    price: toNullableMoney(row.price) ?? 0,
    sellerId: row.seller_id ?? row.sellerId,
    sellerName: row.seller_name ?? row.sellerName,
    status: deriveListingStatus(row, now),
    category: row.category ?? DEFAULT_LISTING_CATEGORY,
    imageCount,
    imagesVersion: toEpochMs(row.images_version ?? row.imagesVersion) ?? 0,
    createdAt,
    // A NULL expiry (which migration 006's trigger prevents) is reported as the creation time:
    // consistent with the derived `expired` status such a row gets, rather than a 1970 date.
    expiresAt: toEpochMs(row.expires_at ?? row.expiresAt) ?? createdAt,
    soldAt: toEpochMs(row.sold_at ?? row.soldAt),
  };

  if (options.includePhone) {
    mapped.phoneNumber = row.phone_number ?? row.phoneNumber;
  }

  if (options.includeImages) {
    mapped.imageUrl = row.image_url || imageUrls[0] || undefined;
    mapped.imageUrls = imageUrls;
  }

  return mapped;
}

/* -------------------------------------------------------------------------- */
/* Browse list: slim columns + keyset pagination                               */
/* -------------------------------------------------------------------------- */

export const DEFAULT_AUCTION_PAGE_SIZE = 24;
export const MAX_AUCTION_PAGE_SIZE = 60;

/** Ids are generated as `auc_<millis>_<base36>`; anything else is not one of ours. */
const AUCTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface AuctionCursor {
  createdAt: number;
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

/** Opaque to the client: `<created_at>:<id>`, base64url encoded. */
export function encodeAuctionCursor(createdAt: unknown, id: unknown): string {
  return toBase64Url(`${Number(createdAt)}:${String(id)}`);
}

/**
 * Returns null for anything malformed. The decoded values are checked because they are
 * interpolated into a PostgREST `or=` filter string, which the server parses as an expression -
 * an unchecked value there is an injection sink. `createdAt` must be an integer (it is epoch
 * millis) and the id must match `AUCTION_ID_PATTERN`.
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

  const createdAt = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (!Number.isSafeInteger(createdAt) || !id || !AUCTION_ID_PATTERN.test(id)) {
    return null;
  }

  return { createdAt, id };
}

export interface AuctionListPage {
  auctions: AuctionSummary[];
  nextCursor: string | null;
}

/**
 * One page of the public browse list, newest first.
 *
 * ONLY LIVE LISTINGS, filtered in SQL: `status = 'active' AND expires_at > now`. Sold, cancelled,
 * hidden and expired listings never leave the database on this route. Migration 006 adds the
 * partial index `(created_at desc, id desc) where status = 'active'` that serves it.
 *
 * Ordered on `(created_at DESC, id DESC)`: a total order over two values that never change after
 * a listing is created, which is what keeps the keyset cursor stable while listings sell, expire
 * or get edited underneath it.
 */
export async function fetchAuctionListPage(
  supabase: any,
  options: { limit?: unknown; cursor?: unknown; now?: number } = {},
): Promise<AuctionListPage> {
  const limit = normalizeAuctionLimit(options.limit);
  const now = options.now ?? Date.now();

  let cursor: AuctionCursor | null = null;
  if (options.cursor !== undefined && options.cursor !== null && options.cursor !== '') {
    cursor = decodeAuctionCursor(options.cursor);
    if (!cursor) {
      throw Object.assign(new Error('Invalid pagination cursor.'), { code: 'INVALID_CURSOR' });
    }
  }

  let query = supabase
    .from('auctions')
    .select(AUCTION_LIST_COLUMNS)
    .eq('status', AUCTION_STATUS.active)
    .gt('expires_at', now);

  if (cursor) {
    query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt."${cursor.id}")`);
  }

  // Fetch one extra row: its existence is what tells us another page exists,
  // without a second COUNT query.
  const { data, error } = await query
    .order('created_at', { ascending: false })
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
    auctions: page.map((row: any) => mapListingRow(row, { now })),
    nextCursor: hasMore && last ? encodeAuctionCursor(last.created_at ?? last.createdAt, last.id) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* The caller's own listings                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Upper bound on `GET /api/users/me/activity`. The live-listing cap is `MAX_LISTINGS_PER_USER`,
 * but finished listings accumulate; this keeps one very long-lived account from turning the
 * route into an unbounded read. Newest first, so what is cut is the oldest history.
 */
export const ACTIVITY_LISTING_LIMIT = 200;

/**
 * `GET /api/users/me/activity`: the caller's own listings, every status including hidden,
 * filtered IN SQL on `seller_id` (served by the index migration 006 adds). The pre-v1 route read
 * every row of the table and filtered in JS.
 */
export async function fetchSellerListings(
  supabase: any,
  sellerId: string,
  now: number = Date.now(),
): Promise<AuctionSummary[]> {
  const { data, error } = await supabase
    .from('auctions')
    .select(AUCTION_DETAIL_COLUMNS)
    .eq('seller_id', sellerId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(ACTIVITY_LISTING_LIMIT);

  if (error) {
    throw error;
  }

  return (Array.isArray(data) ? data : []).map((row: any) => mapListingRow(row, { now, includePhone: true }));
}

/**
 * How many LIVE listings (active and not expired) a seller has - what `MAX_LISTINGS_PER_USER`
 * caps. `head: true` returns only the count, never the rows or their images.
 */
export async function countLiveListings(supabase: any, sellerId: string, now: number = Date.now()): Promise<number> {
  const { count, error } = await supabase
    .from('auctions')
    .select('id', { count: 'exact', head: true })
    .eq('seller_id', sellerId)
    .eq('status', AUCTION_STATUS.active)
    .gt('expires_at', now);

  if (error) {
    throw error;
  }

  return Number(count) || 0;
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

/** How each derived status reads in a link preview. */
const META_STATUS_LABELS: Record<ListingStatus, string> = {
  active: 'For sale',
  sold: 'Sold',
  expired: 'No longer listed',
  cancelled: 'Withdrawn',
  hidden: 'Unavailable',
};

/** `£250`, `£12.50`, `£1,200` - whole pounds without a trailing `.00`, pence always as two digits. */
export function formatPriceLabel(price: number): string {
  const hasPence = Math.round(price * 100) % 100 !== 0;
  return `£${price.toLocaleString('en-GB', {
    minimumFractionDigits: hasPence ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/** Raw (unescaped) preview values for one listing row: its fixed asking price and derived status. */
export function buildAuctionMetaTags(row: any, pageUrl: string, now: number = Date.now()): AuctionMetaTags {
  const price = toNullableMoney(row?.price);
  const priceLabel = price !== null ? formatPriceLabel(price) : '';
  const statusLabel = META_STATUS_LABELS[deriveListingStatus(row, now)];

  const title = String(row?.title ?? 'Listing');
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
    // A replacer FUNCTION, not a string: a replacement string interprets `$&`, `` $` ``, `$'` and
    // `$$`, and `block` carries listing text a seller typed. "Lamp $` offer" as a string would
    // splice the whole HTML before </head> into the page; returned from a function it is inert.
    return stripped.replace(/<\/head>/i, () => `  ${block}\n  </head>`);
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
export const AUCTION_META_COLUMNS = 'id,title,description,price,status,expires_at,sold_at,image_url';

/* -------------------------------------------------------------------------- */
/* Result type shared by the route helpers below                               */
/* -------------------------------------------------------------------------- */

/**
 * The helpers in this file return a plain result the caller maps onto a
 * `Response` (see `failureResponse` in `workers/index.ts`), rather than
 * building a response themselves, so they stay unit-testable on their own.
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

  const lengthFailure = validateAccountFieldLengths({ password });
  if (lengthFailure) {
    return lengthFailure;
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
  options: {
    auctionId: string;
    reporterId: string;
    reason: unknown;
    details?: unknown;
    now?: number;
    /** Resolved from the reporter's DATABASE ROW by the caller. Only an admin may see a hidden listing. */
    reporterIsAdmin?: boolean;
  },
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
    .select('id,title,seller_id,seller_name,status')
    .eq('id', options.auctionId)
    .maybeSingle();

  if (auctionError) {
    throw auctionError;
  }

  // A hidden listing answers exactly like one that never existed, for everyone but an admin -
  // the same rule as the detail route (`isAuctionVisible`). Otherwise this route would confirm a
  // takedown exists and echo its title and seller back in `report`.
  if (!auction || !isAuctionVisible(auction, Boolean(options.reporterIsAdmin))) {
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
 * exactly as `'cancelled'` does, while leaving it fetchable by id for an admin
 * only (see `isAuctionVisible`), so the committee can still see what was taken
 * down. Any open reports on the listing are closed as `actioned` in
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
 * only for humans.
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
  // Lower-cases the 11-character prefix only. `value.toLowerCase()` would copy the whole string -
  // megabytes of base64 - on every create and edit.
  return typeof value === 'string' && value.trimStart().slice(0, 11).toLowerCase() === 'data:image/';
}

/** The strict prefix, tested against the first few dozen characters only - see below. */
const STRICT_NEW_DATA_IMAGE_PREFIX = /^data:image\/(?:jpeg|png|webp|gif);base64,/i;

/** Positions inspected at each end of the payload, and spread evenly through the middle. */
const BASE64_SAMPLE_SIZE = 64;

/** `A-Z a-z 0-9 + /` - the base64 alphabet, without padding. */
function isBase64CharCode(code: number): boolean {
  return (
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47
  );
}

/**
 * The EXACT shape a NEW inline image must have to be accepted at all: `compressImageToBlob`
 * (`src/lib/images.ts`) always emits `data:image/<jpeg|png|webp|gif>;base64,<payload>` with no
 * other parameters, and this is the only shape `estimateDataUrlBytes` below can size correctly.
 *
 * `isDataImageUrl` above stays deliberately permissive - it also has to accept whatever odd but
 * long-standing value is already sitting in an old row, via `mergeAuctionEdit`. This is the
 * narrower gate applied only to a genuinely NEW entry in `validateAuctionInput` (see the call
 * site in `workers/index.ts`), which is why a listing can still be edited as long as an existing
 * oddly-shaped image is carried over byte-for-byte rather than replaced.
 *
 * Rejecting anything else here is also what closes the size-cap bypass `estimateDataUrlBytes`
 * used to have: `data:image/jpeg;name=x.jpg;base64,<payload>`, `data:image/jpeg;charset=utf-8;
 * base64,<payload>`, and an unencoded `data:image/svg+xml,<payload>` (no `;base64,` at all) each
 * used to make that function's regex fail to match and silently return 0 - i.e. "free" storage
 * for an arbitrarily large inline image. None of those match this pattern, so all three are now
 * refused outright as a NEW image, at any size.
 *
 * CPU BUDGET. This runs on every create/edit over up to ~1.2 MB of base64, inside a Workers free
 * plan request capped at 10 ms of CPU. It used to be one anchored regex over the whole string
 * (`^data:image/...;base64,[a-z0-9+/]+={0,2}$`), which walks every byte. It is now O(1):
 *   - the exact prefix (type whitelist, no extra parameters) is matched on the first 32 chars;
 *   - up to two `=` of padding are allowed, at the very end only;
 *   - the base64 alphabet is checked on the first and last 64 payload chars and on 64 positions
 *     spread evenly through the middle.
 * The prefix check is the security-relevant part and stays exact: it is what closes the size-cap
 * bypass above, and what keeps anything but a whitelisted raster type out. The sampled alphabet
 * check is a sanity check, not a guarantee - a stray invalid character between two sample points
 * gets through. That is acceptable because this string is only ever used as an `<img src>` (a
 * corrupt `data:image/jpeg` payload fails to decode; it cannot execute), and its SIZE is measured
 * from its length, which such a character can only over-estimate.
 */
export function isStrictNewDataImageUrl(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  const prefix = STRICT_NEW_DATA_IMAGE_PREFIX.exec(trimmed.slice(0, 32));
  if (!prefix) {
    return false;
  }

  const start = prefix[0].length;
  let end = trimmed.length;
  // Up to two `=` of padding, and only at the very end.
  for (let padding = 0; padding < 2 && end > start && trimmed.charCodeAt(end - 1) === 61; padding += 1) {
    end -= 1;
  }

  const payloadLength = end - start;
  if (payloadLength <= 0) {
    return false;
  }

  const headEnd = Math.min(end, start + BASE64_SAMPLE_SIZE);
  for (let index = start; index < headEnd; index += 1) {
    if (!isBase64CharCode(trimmed.charCodeAt(index))) return false;
  }

  for (let index = Math.max(start, end - BASE64_SAMPLE_SIZE); index < end; index += 1) {
    if (!isBase64CharCode(trimmed.charCodeAt(index))) return false;
  }

  const stride = Math.max(1, Math.floor(payloadLength / BASE64_SAMPLE_SIZE));
  for (let index = start; index < end; index += stride) {
    if (!isBase64CharCode(trimmed.charCodeAt(index))) return false;
  }

  return true;
}

/**
 * Hard ceiling on a NEW inline `data:` image, enforced in `validateAuctionInput`. Now that
 * `compressImageToBlob` targets ~100-150KB per photo (see `src/lib/images.ts`), anything still
 * arriving above this is either an old, uncompressed client or a payload crafted by hand -
 * either way it is the size Supabase egress was being spent on and it is refused outright,
 * EXCEPT when it is byte-identical to an image already stored on the listing being edited (see
 * the call site in `workers/index.ts`).
 */
export const MAX_INLINE_IMAGE_BYTES = 300 * 1024;

/**
 * The decoded byte length of a `data:` URL's payload, computed from the base64 TEXT length
 * rather than by decoding it - this runs on every listing create/edit, so it stays a cheap
 * length calculation rather than an `atob` over what could be a multi-megabyte string.
 *
 * FAILS SAFE rather than returning 0 for anything that merely claims to be an image but isn't in
 * the exact `data:<type>;base64,<payload>` shape this function knows how to measure - an extra
 * `;name=...`/`;charset=...` parameter, or no `;base64,` marker at all (e.g. an unencoded
 * `data:image/svg+xml,<xml>`). `validateAuctionInput` already refuses all of those outright for a
 * NEW image via `isStrictNewDataImageUrl`, so this defends the same ground a second way: `0`
 * bytes for an unparseable "image" used to mean "free, no size limit applies", which is precisely
 * the bypass this exists to close. `value.length` is a real, if loose, upper bound on the decoded
 * size of anything base64-shaped, so treating it as the size is conservative, never an
 * under-count. A value that is not a `data:image/...` string at all (an `/images/<key>` path, or
 * anything the whitelist would reject on other grounds) still returns 0 - it is not a size this
 * function is meant to be measuring in the first place.
 */
export function estimateDataUrlBytes(value: unknown): number {
  if (typeof value !== 'string') {
    return 0;
  }

  const trimmed = value.trim();
  // The header is matched on the first 128 characters only, and the payload is measured by
  // arithmetic on the string length - no regex, copy or whitespace strip walks the payload (see
  // the CPU note on `isStrictNewDataImageUrl`). Whitespace inside the payload is therefore counted
  // as if it were data, which can only OVER-estimate: never an under-count, so never a bypass.
  const header = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,/i.exec(trimmed.slice(0, 128));
  if (!header) {
    return isDataImageUrl(trimmed) ? trimmed.length : 0;
  }

  const payloadLength = trimmed.length - header[0].length;
  if (payloadLength <= 0) {
    return 0;
  }

  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payloadLength * 3) / 4) - padding);
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

/** What `validateNewInlineImages` returns when it finds a problem. */
export interface NewInlineImageFailure {
  message: string;
  code: string;
}

/**
 * The size/shape guard on every NEW inline image in a listing (Fix 1b/1c and the V1 revision
 * that closed the size-cap bypass). Called from `validateListingInput`, over the SAME
 * `normalizedImageUrls` that whitelist check (`isAllowedImageRef`) already accepted.
 *
 * `existingImageUrls` are the images already stored on the listing being edited (empty on
 * create). An entry byte-identical to one of them is exempt from both checks below, so an old
 * listing's existing photo - whatever shape or size it happens to be - never blocks an otherwise
 * unrelated edit; only a genuinely NEW entry has to pass.
 *
 * Returns `null` when every new entry is acceptable, or the `{ message, code }` to surface as a
 * 400 otherwise.
 */
export function validateNewInlineImages(
  imageUrls: readonly string[],
  existingImageUrls: readonly string[] = [],
): NewInlineImageFailure | null {
  const existingSet = new Set(existingImageUrls);

  for (const value of imageUrls) {
    if (existingSet.has(value) || !isDataImageUrl(value)) {
      continue;
    }

    if (!isStrictNewDataImageUrl(value)) {
      return { message: 'Listing images must be uploaded through this site.', code: 'INVALID_IMAGE_URL' };
    }

    if (estimateDataUrlBytes(value) > MAX_INLINE_IMAGE_BYTES) {
      return { message: 'Images must be 300KB or smaller. Please choose a smaller photo.', code: 'IMAGE_TOO_LARGE' };
    }
  }

  return null;
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
  // `auctions` has no row-version column that an edit bumps, and the value
  // that WOULD be exact - the old
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
