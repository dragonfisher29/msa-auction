import { createClient } from '@supabase/supabase-js';
import {
  AUCTION_DETAIL_COLUMNS,
  AUCTION_META_COLUMNS,
  AUCTION_STATUS,
  applyBidLock,
  bannedMessage,
  BID_READ_COLUMNS,
  bidLockUpdate,
  buildAuctionMetaTags,
  buildNotifications,
  cleanupStaleImages,
  createAuctionReport,
  createPasswordResetRequest,
  fetchAuctionListPage,
  hashPassword,
  hideAuction,
  IMAGE_BACKFILL_UNAVAILABLE_MESSAGE,
  IMAGE_CACHE_CONTROL,
  IMAGE_PATH_PREFIX,
  IMAGE_STORAGE_UNAVAILABLE_MESSAGE,
  injectAuctionMeta,
  isAdminUser,
  isAllowedImageRef,
  isAuctionVisible,
  isBannedUser,
  isBearerTokenAdmin,
  isFailure,
  isStaleImageCleanupEnabled,
  isStoredImagePath,
  listPendingResetRequests,
  listReportsForAdmin,
  mapAuctionSummaryRow,
  matchAuctionSharePath,
  matchImageServePath,
  MAX_IMAGE_BYTES,
  mergeAuctionEdit,
  migrateAuctionImages,
  NOTIFICATION_COLUMNS,
  putImage,
  readBidLock,
  resetPasswordWithToken,
  selectActivity,
  setUserBan,
  setUserEmail,
  settleEndedAuctions,
  toNullableMoney,
  toStringArray,
  USER_ROLE,
  validateImageUpload,
  validateNewInlineImages,
  validateOptionalEmail,
  verifyAndUpgradePassword,
  type SharedFailure,
} from './shared';

function getSupabaseClient(env: Record<string, any>) {
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const supabaseSecretKey = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!supabaseUrl || !supabaseSecretKey || supabaseUrl.includes('your-project')) {
    return null;
  }

  return createClient(supabaseUrl, supabaseSecretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    // PATCH is listed because `PATCH /api/auctions/:id` exists; without it a
    // cross-origin preflight (VITE_API_BASE_URL pointed at another domain)
    // would reject the edit before it was ever sent.
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(body: any, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      ...corsHeaders(),
      ...(init?.headers ?? {}),
    },
    ...init,
  });
}

async function getAuthenticatedUser(supabase: any, token: string) {
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}

/**
 * The body of every 500. The underlying error - a Postgres/PostgREST message, constraint name,
 * column name, SQLSTATE, or a JS exception - is LOGGED here (Workers observability keeps it) and
 * never sent to the client: those messages describe the schema and the query, which is exactly
 * what an attacker probing for injection wants to read. The client gets the route's own generic
 * message and a stable route-level code it can branch on.
 */
function getErrorMessageAndCode(fallbackMessage: string, defaultCode: string, error?: unknown): { error: string; code: string } {
  if (error !== undefined) {
    const detail =
      typeof error === 'object' && error !== null
        ? {
            message: (error as any).message,
            code: (error as any).code,
            details: (error as any).details,
            hint: (error as any).hint,
          }
        : error;
    console.error(`[${defaultCode}] ${fallbackMessage}`, detail);
  }

  return makeError(fallbackMessage, defaultCode);
}

function makeError(message: string, code: string): { error: string; code: string } {
  return {
    error: `${message} [Code: ${code}]`,
    code,
  };
}

/** Maps a `SharedFailure` from `workers/shared.ts` onto the wire format. */
function failureResponse(failure: SharedFailure): Response {
  return jsonResponse(makeError(failure.message, failure.code), { status: failure.status });
}

/**
 * What to persist in the `image_url` column, given a listing's resolved `imageUrls[0]`.
 *
 * Fix 1c: `image_url` is a legacy mirror of the first entry of `image_urls`, but it is not purely
 * decorative - `buildAuctionMetaTags` resolves the Open Graph image from `AUCTION_META_COLUMNS`,
 * which selects `image_url` alone (no `image_urls`), so an `/images/<key>` path still needs to
 * land here for a listing's share link to preview correctly once R2 is on. A base64 `data:` URL
 * is the opposite case: every reader (`mapAuctionRow` here and `buildAuctionMetaTags`'s own
 * fallback) already falls back to `image_urls[0]`, and a `data:` URL is never usable as an
 * `og:image` regardless, so writing the full image a second time bought nothing but egress.
 */
function imageUrlMirror(firstImage: string | undefined): string | null {
  return typeof firstImage === 'string' && isStoredImagePath(firstImage) ? firstImage : null;
}

/** The single snake_case row -> camelCase Auction mapper used by every route. */
function mapAuctionRow(row: any) {
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
    imageUrl: row.image_url || row.imageUrl || (Array.isArray(row.image_urls) ? row.image_urls[0] : undefined),
    imageUrls: Array.isArray(row.image_urls) ? row.image_urls : [],
    bids: Array.isArray(row.bids) ? row.bids : [],
    winnerId: row.winner_id ?? row.winnerId ?? null,
    winnerName: row.winner_name ?? row.winnerName ?? null,
    winningBid: toNullableMoney(row.winning_bid ?? row.winningBid),
    createdAt: Number(row.created_at ?? row.createdAt),
  };
}

/**
 * Row -> Auction shape returned by `GET /api/auctions/:id`.
 *
 * No `imageUrl`/`imageUrls` - the row was fetched with `AUCTION_DETAIL_COLUMNS`,
 * which does not select them, so this endpoint carries `imageCount` instead
 * (mirroring the list endpoint) and the client fetches real image data at most
 * once, from `GET /api/auctions/:id/images`, rather than on every 3s poll.
 *
 * `phoneNumber` is included only when `includePhone` is true - the caller
 * resolves that from the request's `Authorization` header before calling this,
 * so an anonymous visitor viewing a listing cannot harvest a seller's number.
 */
function mapAuctionDetailRow(row: any, includePhone: boolean) {
  const rawCount = row.image_count ?? row.imageCount;
  const imageCount = Number.isFinite(Number(rawCount)) ? Number(rawCount) : 0;

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    ...(includePhone ? { phoneNumber: row.phone_number ?? row.phoneNumber } : {}),
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
    bids: Array.isArray(row.bids) ? row.bids : [],
    winnerId: row.winner_id ?? row.winnerId ?? null,
    winnerName: row.winner_name ?? row.winnerName ?? null,
    winningBid: toNullableMoney(row.winning_bid ?? row.winningBid),
    createdAt: Number(row.created_at ?? row.createdAt),
  };
}

/**
 * Lazy settle backstop: a missed cron tick must not strand an ended auction
 * with no winner. A settle failure here must never fail the read.
 */
async function settleBeforeRead(supabase: any, auctionId?: string) {
  try {
    await settleEndedAuctions(supabase, auctionId ? { auctionId } : {});
  } catch (error) {
    console.error('Lazy settle failed:', error);
  }
}

/**
 * Resolves the caller from `Authorization: Bearer <token>`. Returns the user
 * row, or the 401 Response to send back.
 */
interface AuthResult {
  /** The resolved user row, or null when `response` is set. */
  user: any;
  /** The 401 to return, or null when the caller is authenticated. */
  response: Response | null;
}

async function requireUser(supabase: any, request: Request, missingHeaderMessage: string): Promise<AuthResult> {
  const authHeader = request.headers.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return {
      user: null,
      response: jsonResponse(makeError(missingHeaderMessage, 'UNAUTHORIZED'), { status: 401 }),
    };
  }

  const token = authHeader.replace('Bearer ', '').trim();
  const user = await getAuthenticatedUser(supabase, token);

  if (!user) {
    return {
      user: null,
      response: jsonResponse(makeError('Your session has expired. Please sign in again.', 'SESSION_EXPIRED'), {
        status: 401,
      }),
    };
  }

  // A ban is enforced HERE, at authentication, so that it takes effect on every
  // authenticated route at once instead of having to be remembered route by
  // route. The banned user's session token is deliberately left valid so this
  // answers 403 ACCOUNT_BANNED rather than a misleading "session expired".
  if (isBannedUser(user)) {
    return {
      user: null,
      response: jsonResponse(makeError(bannedMessage(user), 'ACCOUNT_BANNED'), { status: 403 }),
    };
  }

  return { user, response: null };
}

/**
 * `requireUser` plus a role check. The role is read from the DATABASE ROW that
 * `getAuthenticatedUser` returned - never from the request body, which a caller
 * controls.
 */
async function requireAdmin(supabase: any, request: Request): Promise<AuthResult> {
  const auth = await requireUser(supabase, request, 'Authentication required.');
  if (auth.response) {
    return auth;
  }

  if (!isAdminUser(auth.user)) {
    return {
      user: null,
      response: jsonResponse(makeError('This area is for committee admins only.', 'NOT_ADMIN'), { status: 403 }),
    };
  }

  return auth;
}

/** Optimistic-lock retries before a concurrent bid is reported as a conflict. */
const MAX_BID_ATTEMPTS = 3;

/** The second `[triggers]` cron in wrangler.toml - see `scheduled()` below. */
const STALE_IMAGE_CLEANUP_CRON = '0 3 * * *';

/**
 * `existingImageUrls` are the images already stored on the listing being edited (empty on
 * create), passed straight through to `validateNewInlineImages` in `workers/shared.ts` - see
 * there for the shape/size rules applied to a genuinely NEW image. An entry byte-identical to one
 * already on the row is exempt, so an existing photo already sitting in the database never blocks
 * an otherwise-unrelated edit to the title or price.
 */
function validateAuctionInput(raw: any, existingImageUrls: string[] = []) {
  if (!raw || typeof raw !== 'object') {
    return makeError('Invalid auction payload.', 'INVALID_PAYLOAD');
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const phoneNumber = typeof raw.phoneNumber === 'string' ? raw.phoneNumber.trim() : '';

  if (!title || !description || !phoneNumber) {
    return makeError('Title, description, and phone number are required.', 'MISSING_FIELDS');
  }

  const parsedPrice = Number(raw.startingPrice);
  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
    return makeError('Starting price must be greater than £0.', 'INVALID_PRICE');
  }

  const parsedDuration = Number(raw.durationMinutes);
  if (!Number.isInteger(parsedDuration) || parsedDuration <= 0) {
    return makeError('Auction duration must be at least 1 minute.', 'INVALID_DURATION');
  }

  const normalizedImageUrls = Array.isArray(raw.imageUrls)
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
    return makeError('Please upload at least one image for the listing.', 'MISSING_IMAGES');
  }

  if (normalizedImageUrls.length > 3) {
    return makeError('You can upload up to 3 images per listing.', 'TOO_MANY_IMAGES');
  }

  // Each entry must be an image this site itself holds: an inline `data:` URL,
  // or an `/images/<key>` path from `POST /api/images`. An arbitrary external
  // URL is refused - accepting one would let a listing point the site's own
  // pages at any third-party host.
  //
  // BOTH FORMS ARE ACCEPTED UNCONDITIONALLY, and must stay that way. R2 is off
  // today, so every new listing arrives as `data:` URLs; if it is switched on,
  // new listings arrive as paths while old rows keep their `data:` URLs, and a
  // single listing can hold a mixture of the two. Narrowing this to whichever
  // form happens to be current would make the other kind of listing
  // uneditable - `mergeAuctionEdit` feeds the stored array back through here on
  // every PATCH.
  if (!normalizedImageUrls.every((value: string) => isAllowedImageRef(value))) {
    return makeError('Listing images must be uploaded through this site.', 'INVALID_IMAGE_URL');
  }

  // Server-side guard on a NEW inline image's shape and size (Fix 1b/1c, hardened in a later
  // revision - see `validateNewInlineImages` in `workers/shared.ts` for what this actually
  // checks and why). An entry byte-identical to one already stored on this listing is exempt, so
  // editing an old listing never gets blocked by its own existing photos.
  const newImageFailure = validateNewInlineImages(normalizedImageUrls, existingImageUrls);
  if (newImageFailure) {
    return makeError(newImageFailure.message, newImageFailure.code);
  }

  return {
    title,
    description,
    phoneNumber,
    parsedPrice,
    parsedDuration,
    imageUrls: normalizedImageUrls,
    category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'General',
  };
}

/**
 * `GET /auction/:id` - the SPA shell with that auction's Open Graph tags baked
 * in, so a shared link previews as the listing instead of as the generic site.
 *
 * This route is decoration on top of a page that has to render regardless, so
 * every failure mode (no Supabase, unknown id, a non-HTML asset, a thrown
 * fetch) degrades to the untouched asset response rather than to an error.
 */
async function renderAuctionShare(
  env: Record<string, any>,
  supabase: any,
  request: Request,
  url: URL,
  auctionId: string,
): Promise<Response> {
  try {
    const assetResponse: Response = await env.ASSETS.fetch(request);

    if (!supabase || !assetResponse.ok) {
      return assetResponse;
    }

    const contentType = assetResponse.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      return assetResponse;
    }

    const { data: row, error } = await supabase
      .from('auctions')
      .select(AUCTION_META_COLUMNS)
      .eq('id', auctionId)
      .maybeSingle();

    // A hidden listing gets the default shell, same as an unknown id: the
    // whole point of a takedown is that its title and description must never
    // land in HTML a crawler can cache.
    if (error || !row || !isAuctionVisible(row, false)) {
      return assetResponse;
    }

    const html = await assetResponse.clone().text();
    const meta = buildAuctionMetaTags(row, `${url.origin}/auction/${encodeURIComponent(auctionId)}`);
    const injected = injectAuctionMeta(html, meta);

    const headers = new Headers(assetResponse.headers);
    // The body length changed, and any asset ETag now describes the wrong bytes.
    headers.delete('content-length');
    headers.delete('etag');
    headers.set('content-type', 'text/html; charset=utf-8');

    return new Response(injected, { status: assetResponse.status, headers });
  } catch (metaError) {
    console.error('OG injection failed:', metaError);
    // Worst case this path is exactly as good as not having it at all.
    return env.ASSETS.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Record<string, any>): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight OPTIONS request
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    const supabase = getSupabaseClient(env);

    /* ---------------------------------------------------------------------- */
    /* GET /images/:key - public listing image, streamed from R2.              */
    /*                                                                        */
    /* MUST stay above the static-asset branch below. That branch claims every */
    /* path that is not `/api/`, so an `/images/...` request placed after it   */
    /* would be answered by the SPA shell instead of the image.                */
    /*                                                                        */
    /* R2 IS CURRENTLY DISABLED - see the commented-out `[[r2_buckets]]` block */
    /* in wrangler.toml. With no binding there is no bucket, and because keys  */
    /* are only ever minted by `POST /api/images` writing to that same bucket, */
    /* NO KEY CAN EXIST. So this is a genuine 404, not a configuration error:  */
    /* the answer to "is there an object here" is no, and 404 is what a        */
    /* browser's <img> and every cache already know how to handle.             */
    /* ---------------------------------------------------------------------- */

    const imageKey = request.method === 'GET' ? matchImageServePath(url.pathname) : null;
    if (imageKey) {
      const bucket = env.IMAGES;
      if (!bucket || typeof bucket.get !== 'function') {
        return jsonResponse(makeError('Image not found.', 'IMAGE_NOT_FOUND'), { status: 404 });
      }

      try {
        const object = await bucket.get(imageKey);
        if (!object) {
          return jsonResponse(makeError('Image not found.', 'IMAGE_NOT_FOUND'), { status: 404 });
        }

        const headers = new Headers(corsHeaders());
        headers.set('content-type', object.httpMetadata?.contentType || 'application/octet-stream');
        headers.set('cache-control', IMAGE_CACHE_CONTROL);
        // These bytes were supplied by a user and are served from our own
        // origin. The upload route already pinned the type by sniffing, and
        // this stops a browser from second-guessing that and running the
        // object as something else.
        headers.set('x-content-type-options', 'nosniff');
        if (object.httpEtag) {
          headers.set('etag', object.httpEtag);
        }

        return new Response(object.body, { status: 200, headers });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to load image.', 'IMAGE_FETCH_FAILED', error), {
          status: 500,
        });
      }
    }

    // Serve static frontend assets for non-API routes
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        const shareId = request.method === 'GET' ? matchAuctionSharePath(url.pathname) : null;
        if (shareId) {
          return renderAuctionShare(env, supabase, request, url, shareId);
        }

        return env.ASSETS.fetch(request);
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return jsonResponse({ status: 'ok', serverTime: Date.now() });
    }

    /* ---------------------------------------------------------------------- */
    /* POST /api/images - raw image bytes in, an `/images/<key>` path out.     */
    /*                                                                        */
    /* Signed in only, and the bytes are checked three ways before anything is */
    /* written: declared type, length, and the leading magic bytes. The key is */
    /* a fresh UUID, never anything derived from what the caller sent.         */
    /*                                                                        */
    /* WHEN R2 IS DISABLED this returns 503 IMAGE_STORAGE_UNAVAILABLE. That    */
    /* code is a CONTRACT with the client: `CreateListingModal` reads it and   */
    /* falls back to inlining the image as a base64 `data:` URL, which is what */
    /* the site did before R2 existed and still accepts today. Do not rename   */
    /* it, and do not change the status - a 5xx is correct (the server cannot  */
    /* do this right now), and 503 specifically says "temporarily", which is   */
    /* accurate: adding the binding fixes it with no code change.              */
    /* ---------------------------------------------------------------------- */

    if (request.method === 'POST' && url.pathname === '/api/images') {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      const bucket = env.IMAGES;
      if (!bucket || typeof bucket.put !== 'function') {
        return jsonResponse(makeError(IMAGE_STORAGE_UNAVAILABLE_MESSAGE, 'IMAGE_STORAGE_UNAVAILABLE'), { status: 503 });
      }

      try {
        const auth = await requireUser(supabase, request, 'Authentication required to upload an image.');
        if (auth.response) {
          return auth.response;
        }

        // Refused on the header before the body is read, when the sender
        // declared a length. The real check is on the decoded bytes below,
        // because Content-Length is a claim like any other.
        const declaredLength = Number(request.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
          return jsonResponse(makeError('Images must be 5 MB or smaller.', 'IMAGE_TOO_LARGE'), { status: 413 });
        }

        const bytes = new Uint8Array(await request.arrayBuffer());
        const validated = validateImageUpload(request.headers.get('content-type'), bytes);
        if (isFailure(validated)) {
          return failureResponse(validated);
        }

        await putImage(bucket, validated.data.key, bytes, validated.data.mime);

        return jsonResponse({ url: `${IMAGE_PATH_PREFIX}${validated.data.key}`, key: validated.data.key });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to upload image.', 'IMAGE_UPLOAD_FAILED', error), {
          status: 500,
        });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const body = await request.json();
        const username = String(body.username ?? '').trim().toLowerCase();
        const name = String(body.name ?? '').trim();
        const password = String(body.password ?? '').trim();

        if (!username || !name || !password) {
          return jsonResponse(makeError('Username, name, and password are required.', 'MISSING_FIELDS'), { status: 400 });
        }

        // Optional: an account with no email simply has no way to self-recover.
        const emailResult = validateOptionalEmail(body.email);
        if (isFailure(emailResult)) {
          return failureResponse(emailResult);
        }

        const { data: existingUser, error: existingError } = await supabase
          .from('users')
          .select('id')
          .eq('username', username)
          .maybeSingle();

        if (existingError) {
          throw existingError;
        }

        if (existingUser) {
          return jsonResponse(makeError('Username is already taken. Please choose another.', 'USERNAME_TAKEN'), { status: 409 });
        }

        // PBKDF2 with a fresh per-user salt. See hashPassword in shared.ts.
        const passwordHash = await hashPassword(password);
        const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const token = `tok_${crypto.randomUUID()}`;
        const email = emailResult.data;

        const { error: insertError } = await supabase.from('users').insert([
          {
            id,
            name,
            username,
            password_hash: passwordHash,
            token,
            created_at: Date.now(),
            // Only sent when supplied, so registration still works on a schema
            // where migration 002 has not been applied yet. `role` is left to
            // the column default from migration 003 and is NEVER taken from the
            // request body.
            ...(email ? { email } : {}),
          },
        ]);

        if (insertError) {
          throw insertError;
        }

        // `role` is reported, never accepted: the INSERT above does not send one, so a brand
        // new account is always the column default. It is echoed here only so the client can
        // decide whether to SHOW admin controls -- enforcement is `requireAdmin`, below.
        return jsonResponse(
          { user: { id, name, username, email, role: USER_ROLE.member, token } },
          { status: 201 },
        );
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Registration failed.', 'REGISTER_FAILED', error), { status: 500 });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const body = await request.json();
        const username = String(body.username ?? '').trim().toLowerCase();
        const password = String(body.password ?? '').trim();

        if (!username || !password) {
          return jsonResponse(makeError('Username and password are required.', 'MISSING_FIELDS'), { status: 400 });
        }

        const { data: storedUser, error: fetchError } = await supabase
          .from('users')
          .select('*')
          .eq('username', username)
          .maybeSingle();

        if (fetchError) {
          throw fetchError;
        }

        if (!storedUser) {
          return jsonResponse(makeError('Invalid username or password.', 'INVALID_CREDENTIALS'), { status: 401 });
        }

        // Accepts BOTH the PBKDF2 format and the legacy unsalted SHA-256 hex
        // digest, and silently rewrites a legacy row to PBKDF2 on success.
        // Constant-time comparison lives in verifyPassword.
        const passwordValid = await verifyAndUpgradePassword(supabase, storedUser, password);
        if (!passwordValid) {
          return jsonResponse(makeError('Invalid username or password.', 'INVALID_CREDENTIALS'), { status: 401 });
        }

        if (isBannedUser(storedUser)) {
          return jsonResponse(makeError(bannedMessage(storedUser), 'ACCOUNT_BANNED'), { status: 403 });
        }

        const token = `tok_${crypto.randomUUID()}`;
        const { error: updateError } = await supabase.from('users').update({ token }).eq('id', storedUser.id);

        if (updateError) {
          throw updateError;
        }

        return jsonResponse({
          user: {
            id: storedUser.id,
            name: storedUser.name,
            username: storedUser.username,
            email: storedUser.email ?? null,
            // Read from the DATABASE ROW. Display-only for the client; every admin route is
            // gated by `requireAdmin` against this same column.
            role: storedUser.role ?? USER_ROLE.member,
            token,
          },
        });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Login failed.', 'LOGIN_FAILED', error), { status: 500 });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      try {
        const authHeader = request.headers.get('authorization') ?? '';
        if (!authHeader.startsWith('Bearer ')) {
          return jsonResponse(makeError('Not authenticated', 'UNAUTHORIZED'), { status: 401 });
        }

        const token = authHeader.replace('Bearer ', '').trim();
        const user = await getAuthenticatedUser(supabase, token);

        if (!user) {
          return jsonResponse(makeError('Session expired or invalid', 'SESSION_INVALID'), { status: 401 });
        }

        // Checked inline rather than via requireUser so the existing 401 codes
        // this route returns (UNAUTHORIZED / SESSION_INVALID) are unchanged.
        if (isBannedUser(user)) {
          return jsonResponse(makeError(bannedMessage(user), 'ACCOUNT_BANNED'), { status: 403 });
        }

        return jsonResponse({
          user: {
            id: user.id,
            name: user.name,
            username: user.username,
            email: user.email ?? null,
            // Display-only for the client (see the login route). `requireAdmin` re-reads this
            // column on every admin request, so a tampered client copy grants nothing.
            role: user.role ?? USER_ROLE.member,
            token,
          },
        });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to load your session.', 'SESSION_ERROR', error), { status: 500 });
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Account recovery                                                        */
    /* ---------------------------------------------------------------------- */

    if (request.method === 'POST' && url.pathname === '/api/auth/email') {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const auth = await requireUser(supabase, request, 'Authentication required to set an email address.');
        if (auth.response) {
          return auth.response;
        }

        const body = await request.json();
        const result = await setUserEmail(supabase, auth.user.id, body.email);
        if (isFailure(result)) {
          return failureResponse(result);
        }

        return jsonResponse({ success: true, email: result.data.email });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to save your email address.', 'SET_EMAIL_FAILED', error), {
          status: 500,
        });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/request-reset') {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      // ALWAYS the same answer, whatever happened. Telling the caller whether
      // the account existed would turn this into a username/email oracle, and a
      // 500 on a database blip would leak the same thing by omission - hence
      // the catch that still returns 200.
      const genericBody = {
        success: true,
        message: 'If that account exists, a reset link has been created.',
      };

      try {
        const body = await request.json();
        await createPasswordResetRequest(supabase, body.usernameOrEmail);
      } catch (error) {
        console.error('Password reset request failed:', error);
      }

      return jsonResponse(genericBody);
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/reset-password') {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const body = await request.json();
        const result = await resetPasswordWithToken(supabase, body.token, body.newPassword);
        if (isFailure(result)) {
          return failureResponse(result);
        }

        return jsonResponse({ user: result.data.user });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to reset your password.', 'RESET_PASSWORD_FAILED', error), {
          status: 500,
        });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/auctions') {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        // No lazy settle here any more: it rode along on every page of every
        // poll of the list, which is by far this API's hottest read. Settling
        // still happens on the single-auction detail route, the bid route, and
        // the cron trigger (see scheduled() below), so an ended auction still
        // gets its winner promptly - just not on the list's account any more.

        // Slim rows (no image payload) + keyset page. See fetchAuctionListPage.
        const page = await fetchAuctionListPage(supabase, {
          limit: url.searchParams.get('limit') ?? undefined,
          cursor: url.searchParams.get('cursor') ?? undefined,
        });

        return jsonResponse(page);
      } catch (error) {
        if ((error as any)?.code === 'INVALID_CURSOR') {
          return jsonResponse(makeError('Invalid pagination cursor.', 'INVALID_CURSOR'), { status: 400 });
        }
        return jsonResponse(getErrorMessageAndCode('Failed to load auctions.', 'FETCH_AUCTIONS_FAILED', error), { status: 500 });
      }
    }

    const auctionImagesMatch = url.pathname.match(/^\/api\/auctions\/([^/]+)\/images$/);
    if (request.method === 'GET' && auctionImagesMatch) {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const { data: row, error } = await supabase
          .from('auctions')
          .select('id,image_urls,status')
          .eq('id', auctionImagesMatch[1])
          .maybeSingle();

        if (error) throw error;
        if (!row) return jsonResponse(makeError('Auction not found', 'AUCTION_NOT_FOUND'), { status: 404 });

        const isAdmin = await isBearerTokenAdmin(supabase, request.headers.get('authorization'));
        if (!isAuctionVisible(row, isAdmin)) {
          return jsonResponse(makeError('Auction not found', 'AUCTION_NOT_FOUND'), { status: 404 });
        }

        // A listing's images are immutable once it has bids, and this is the
        // heaviest response the API serves - let clients and the edge keep it.
        return jsonResponse(
          { imageUrls: toStringArray(row.image_urls) },
          { headers: { 'Cache-Control': 'public, max-age=300' } },
        );
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to load auction images.', 'FETCH_AUCTION_IMAGES_FAILED', error), {
          status: 500,
        });
      }
    }

    const singleAuctionMatch = url.pathname.match(/^\/api\/auctions\/([^/]+)$/);
    if (request.method === 'GET' && singleAuctionMatch) {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const auctionId = singleAuctionMatch[1];

        await settleBeforeRead(supabase, auctionId);

        // Slim row (no image payload) - see mapAuctionDetailRow and
        // AUCTION_DETAIL_COLUMNS. This route is polled every 3s by an open
        // detail modal, so it was the single largest source of egress before
        // images were split out to GET /api/auctions/:id/images.
        const { data: row, error } = await supabase
          .from('auctions')
          .select(AUCTION_DETAIL_COLUMNS)
          .eq('id', auctionId)
          .maybeSingle();

        if (error) throw error;
        if (!row) return jsonResponse(makeError('Auction not found', 'AUCTION_NOT_FOUND'), { status: 404 });

        // Resolved once, from the same lookup: whether the caller is an admin
        // (for the hidden-listing check below) and whether they are signed in
        // at all (for whether phoneNumber goes on the wire - see
        // mapAuctionDetailRow). A missing or dead token resolves both to false
        // rather than an error, exactly like isBearerTokenAdmin, since this
        // route is intentionally reachable by an anonymous visitor.
        const authHeader = request.headers.get('authorization') ?? '';
        let requester: any = null;
        if (authHeader.startsWith('Bearer ')) {
          const token = authHeader.slice('Bearer '.length).trim();
          if (token) {
            requester = await getAuthenticatedUser(supabase, token);
          }
        }
        const isAdmin = isAdminUser(requester);

        // A hidden listing is invisible to everyone but an admin - it must not
        // survive a takedown via its direct link. Reported the same as an
        // unknown id so a probe cannot tell "hidden" from "never existed".
        if (!isAuctionVisible(row, isAdmin)) {
          return jsonResponse(makeError('Auction not found', 'AUCTION_NOT_FOUND'), { status: 404 });
        }

        return jsonResponse({ auction: mapAuctionDetailRow(row, Boolean(requester)) });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to load auction.', 'FETCH_AUCTION_FAILED', error), { status: 500 });
      }
    }

    if (request.method === 'PATCH' && singleAuctionMatch) {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const auctionId = singleAuctionMatch[1];

        const auth = await requireUser(supabase, request, 'Authentication required to edit a listing.');
        if (auth.response) {
          return auth.response;
        }

        const { data: row, error: fetchError } = await supabase
          .from('auctions')
          .select('*')
          .eq('id', auctionId)
          .maybeSingle();

        if (fetchError) throw fetchError;
        if (!row) return jsonResponse(makeError('Auction not found', 'AUCTION_NOT_FOUND'), { status: 404 });

        if ((row.seller_id ?? row.sellerId) !== auth.user.id) {
          return jsonResponse(makeError('Only the seller can edit this listing.', 'NOT_LISTING_OWNER'), { status: 403 });
        }

        if (row.status !== AUCTION_STATUS.active) {
          return jsonResponse(
            makeError('This listing is no longer active and can no longer be edited.', 'LISTING_NOT_EDITABLE'),
            { status: 409 },
          );
        }

        // A row can still read `status = 'active'` after its end_time if the
        // cron tick that would settle it hasn't run yet - the same gap PATCH's
        // sibling DELETE guards against below. Editing that window away would
        // let a seller change the price on a listing that has already, in
        // effect, ended.
        if (Date.now() >= Number(row.end_time ?? row.endTime)) {
          return jsonResponse(
            makeError('This listing has already ended and can no longer be edited.', 'LISTING_NOT_EDITABLE'),
            { status: 409 },
          );
        }

        // Once money is on the table the terms are frozen - a seller must not be
        // able to move the price out from under a standing bid.
        if ((Array.isArray(row.bids) ? row.bids : []).length > 0) {
          return jsonResponse(
            makeError(
              'This listing already has bids and can no longer be edited. You can cancel it instead.',
              'LISTING_HAS_BIDS',
            ),
            { status: 409 },
          );
        }

        const rawBody = await request.json();
        // Same validator as listing creation, run over row + patch merged. The stored images are
        // passed through too, so an existing (possibly larger, pre-compression) photo that is
        // carried over unchanged is exempt from the new-upload shape/size checks - see `validateNewInlineImages`.
        const validated = validateAuctionInput(mergeAuctionEdit(row, rawBody), toStringArray(row.image_urls ?? row.imageUrls));
        if ('error' in validated) {
          return jsonResponse(validated, { status: 400 });
        }

        const patch = {
          title: validated.title,
          description: validated.description,
          phone_number: validated.phoneNumber,
          category: validated.category,
          image_url: imageUrlMirror(validated.imageUrls[0]),
          image_urls: validated.imageUrls,
          starting_price: validated.parsedPrice,
          // No bids exist, so current_price tracks starting_price exactly.
          current_price: validated.parsedPrice,
        };

        // Optimistic lock: a bid landing between the read above and this write
        // sets highest_bidder_id, so guarding on it still being NULL means the
        // edit matches zero rows rather than overwriting a live auction.
        const { data: updated, error: updateError } = await supabase
          .from('auctions')
          .update(patch)
          .eq('id', auctionId)
          .eq('status', AUCTION_STATUS.active)
          .is('highest_bidder_id', null)
          .select();

        if (updateError) throw updateError;

        if (!Array.isArray(updated) || updated.length === 0) {
          return jsonResponse(
            makeError(
              'This listing already has bids and can no longer be edited. You can cancel it instead.',
              'LISTING_HAS_BIDS',
            ),
            { status: 409 },
          );
        }

        return jsonResponse({ auction: mapAuctionRow(updated[0]) });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to update the listing.', 'UPDATE_LISTING_FAILED', error), {
          status: 500,
        });
      }
    }

    if (request.method === 'DELETE' && singleAuctionMatch) {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const auctionId = singleAuctionMatch[1];

        const auth = await requireUser(supabase, request, 'Authentication required to cancel a listing.');
        if (auth.response) {
          return auth.response;
        }

        const { data: row, error: fetchError } = await supabase
          .from('auctions')
          .select('*')
          .eq('id', auctionId)
          .maybeSingle();

        if (fetchError) throw fetchError;
        if (!row) return jsonResponse(makeError('Auction not found', 'AUCTION_NOT_FOUND'), { status: 404 });

        if ((row.seller_id ?? row.sellerId) !== auth.user.id) {
          return jsonResponse(makeError('Only the seller can cancel this listing.', 'NOT_LISTING_OWNER'), { status: 403 });
        }

        // The end_time check catches the same window PATCH now guards: a row
        // can still read `status = 'active'` after its end_time if the cron
        // tick that would settle it hasn't run yet, and a seller must not be
        // able to withdraw a listing out from under a bidder in that window.
        if (row.status === AUCTION_STATUS.ended || Date.now() >= Number(row.end_time ?? row.endTime)) {
          return jsonResponse(
            makeError('This listing has already ended and can no longer be cancelled.', 'LISTING_NOT_EDITABLE'),
            { status: 409 },
          );
        }

        const hadBids = (Array.isArray(row.bids) ? row.bids : []).length > 0;

        // SOFT delete, always. The bids array is the only record a bidder has of
        // what they offered and when - hard-deleting the row destroys their
        // history along with the seller's listing.
        if (row.status === AUCTION_STATUS.active) {
          const { error: updateError } = await supabase
            .from('auctions')
            .update({
              status: AUCTION_STATUS.cancelled,
              // Bumped so a bid read before this cancel lands loses its
              // optimistic lock (see readBidLock/applyBidLock) instead of
              // writing a bid onto a listing the seller just withdrew.
              ...bidLockUpdate(readBidLock(row, 0)),
            })
            .eq('id', auctionId)
            .eq('status', AUCTION_STATUS.active);

          if (updateError) throw updateError;
        }

        return jsonResponse({
          success: true,
          auction: mapAuctionRow({ ...row, status: AUCTION_STATUS.cancelled }),
          hadBids,
          bidsPreserved: true,
          message: hadBids
            ? 'Listing withdrawn. It no longer appears in the auction list, but everyone who bid can still open it and see their bid history.'
            : 'Listing withdrawn. It no longer appears in the auction list, but anyone holding a direct link can still open it.',
        });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to cancel the listing.', 'CANCEL_LISTING_FAILED', error), {
          status: 500,
        });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/auctions') {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        // Routed through requireUser so a banned account is refused here by the
        // same check that guards every other authenticated route.
        const auth = await requireUser(supabase, request, 'Authentication required to create a listing.');
        if (auth.response) {
          return auth.response;
        }

        const user = auth.user;

        const rawBody = await request.json();
        const validated = validateAuctionInput(rawBody);
        if ('error' in validated) {
          return jsonResponse(validated, { status: 400 });
        }

        const maxListingsPerUser = Number(env.MAX_LISTINGS_PER_USER ?? '20');
        // Counts ACTIVE listings only. Counting every row the user had ever
        // created meant 20 successful sales locked the account out of the site
        // permanently. `head: true` also stops this pulling every base64 image
        // the seller owns just to produce a number.
        const { count, error: countError } = await supabase
          .from('auctions')
          .select('id', { count: 'exact', head: true })
          .eq('seller_id', user.id)
          .eq('status', AUCTION_STATUS.active);

        if (countError) throw countError;
        if ((count ?? 0) >= maxListingsPerUser) {
          return jsonResponse(makeError(`You have reached the limit of ${maxListingsPerUser} active listings. End or cancel a listing before creating another.`, 'LISTING_LIMIT_REACHED'), { status: 429 });
        }

        const now = Date.now();
        const id = `auc_${now}_${Math.random().toString(36).slice(2, 6)}`;
        const imageUrls = validated.imageUrls;

        const auction = {
          id,
          title: validated.title,
          description: validated.description,
          phoneNumber: validated.phoneNumber,
          startingPrice: validated.parsedPrice,
          currentPrice: validated.parsedPrice,
          sellerId: user.id,
          sellerName: user.name,
          highestBidderId: null,
          highestBidderName: null,
          durationMinutes: validated.parsedDuration,
          startTime: now,
          endTime: now + validated.parsedDuration * 60 * 1000,
          status: 'active',
          category: validated.category,
          imageUrl: imageUrls[0],
          imageUrls,
          bids: [],
          winnerId: null,
          winnerName: null,
          winningBid: null,
          createdAt: now,
        };

        const { error: insertError } = await supabase.from('auctions').insert([
          {
            id: auction.id,
            title: auction.title,
            description: auction.description,
            phone_number: auction.phoneNumber,
            starting_price: auction.startingPrice,
            current_price: auction.currentPrice,
            seller_id: auction.sellerId,
            seller_name: auction.sellerName,
            highest_bidder_id: auction.highestBidderId,
            highest_bidder_name: auction.highestBidderName,
            duration_minutes: auction.durationMinutes,
            start_time: auction.startTime,
            end_time: auction.endTime,
            status: auction.status,
            category: auction.category,
            // The client's own copy of the just-created auction (returned below) keeps the full
            // `imageUrl` it was given; only the persisted row's mirror column is pared down. See
            // `imageUrlMirror`.
            image_url: imageUrlMirror(auction.imageUrl),
            image_urls: auction.imageUrls,
            bids: auction.bids,
            winner_id: auction.winnerId,
            winner_name: auction.winnerName,
            winning_bid: auction.winningBid,
            created_at: auction.createdAt,
          },
        ]);

        if (insertError) throw insertError;

        return jsonResponse({ auction }, { status: 201 });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to create auction.', 'CREATE_AUCTION_FAILED', error), { status: 500 });
      }
    }

    const reportMatch = url.pathname.match(/^\/api\/auctions\/([^/]+)\/report$/);
    if (request.method === 'POST' && reportMatch) {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const auth = await requireUser(supabase, request, 'Authentication required to report a listing.');
        if (auth.response) {
          return auth.response;
        }

        const body = await request.json();
        const result = await createAuctionReport(supabase, {
          auctionId: reportMatch[1],
          reporterId: auth.user.id,
          reason: body.reason,
          details: body.details,
        });

        if (isFailure(result)) {
          return failureResponse(result);
        }

        // A duplicate is deliberately a 200, not a 409: the reporter did nothing
        // wrong, and the response must not differ enough to reveal whether an
        // earlier report of theirs is still open.
        return jsonResponse({
          success: true,
          duplicate: result.data.duplicate,
          report: result.data.report,
          message: 'Thanks - the committee has been notified.',
        });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to report the listing.', 'REPORT_FAILED', error), {
          status: 500,
        });
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Admin. Every route here goes through requireAdmin.                      */
    /* ---------------------------------------------------------------------- */

    if (url.pathname.startsWith('/api/admin/')) {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const auth = await requireAdmin(supabase, request);
        if (auth.response) {
          return auth.response;
        }

        if (request.method === 'GET' && url.pathname === '/api/admin/reports') {
          return jsonResponse({ reports: await listReportsForAdmin(supabase) });
        }

        /* ------------------------------------------------------------------ */
        /* POST /api/admin/migrate-images - one batch of the base64 -> R2      */
        /* backfill. Safe to call repeatedly: it is driven by what is still a  */
        /* `data:` URL in the database, so an already-migrated row is skipped  */
        /* rather than re-uploaded.                                            */
        /*                                                                    */
        /* Stop when `migrated` comes back 0, not when `remaining` does - a    */
        /* permanently broken row keeps `remaining` above zero forever and is  */
        /* listed in `failures` for manual attention. See DEPLOY.md.          */
        /* ------------------------------------------------------------------ */
        if (request.method === 'POST' && url.pathname === '/api/admin/migrate-images') {
          const bucket = env.IMAGES;
          if (!bucket || typeof bucket.put !== 'function') {
            // There is nothing to migrate INTO. Answering plainly beats
            // throwing on `bucket.put` of undefined, and names the exact thing
            // that is missing so an admin knows what to fix.
            return jsonResponse(makeError(IMAGE_BACKFILL_UNAVAILABLE_MESSAGE, 'IMAGE_STORAGE_UNAVAILABLE'), {
              status: 503,
            });
          }

          const body = await request.json().catch(() => ({}));
          const result = await migrateAuctionImages(supabase, bucket, { limit: (body as any)?.limit });

          return jsonResponse(result);
        }

        // INTERIM MEASURE - DELETE THIS ROUTE ONCE A MAIL PROVIDER IS WIRED UP.
        //
        // There is no way to send a reset link yet, so a committee member reads
        // the pending requests here and passes the link to the student out of
        // band. `POST /api/auth/request-reset` deliberately does NOT return the
        // token, because that would let anyone reset anyone's password.
        //
        // Only the token HASH is stored, so a pending request's original token
        // cannot be read back: this MINTS a new token per pending request and
        // returns it once. Reading this list therefore invalidates any link
        // handed out from a previous read and restarts the 60-minute window.
        if (request.method === 'GET' && url.pathname === '/api/admin/reset-requests') {
          const pending = await listPendingResetRequests(supabase);
          return jsonResponse({
            resetRequests: pending,
            notice:
              'Interim: no mail provider is configured. Pass the link to the student yourself. Reading this list re-issues each token, so any link from an earlier read stops working.',
          });
        }

        const hideMatch = url.pathname.match(/^\/api\/admin\/auctions\/([^/]+)\/hide$/);
        if (request.method === 'POST' && hideMatch) {
          const body = await request.json();
          const result = await hideAuction(supabase, {
            auctionId: hideMatch[1],
            adminId: auth.user.id,
            reason: body.reason,
          });

          if (isFailure(result)) {
            return failureResponse(result);
          }

          return jsonResponse({ success: true, ...result.data });
        }

        const banMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/(ban|unban)$/);
        if (request.method === 'POST' && banMatch) {
          const body = await request.json();
          const result = await setUserBan(supabase, {
            userId: banMatch[1],
            adminId: auth.user.id,
            banned: banMatch[2] === 'ban',
            reason: body.reason,
          });

          if (isFailure(result)) {
            return failureResponse(result);
          }

          return jsonResponse({ success: true, user: result.data.user });
        }

        return jsonResponse(makeError('Route not found.', 'NOT_FOUND'), { status: 404 });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Admin request failed.', 'ADMIN_REQUEST_FAILED', error), {
          status: 500,
        });
      }
    }

    const bidMatch = url.pathname.match(/^\/api\/auctions\/([^/]+)\/bids$/);
    if (request.method === 'POST' && bidMatch) {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const auctionId = bidMatch[1];

        // The bidder is whoever holds the token. Any userId/userName in the
        // request body is ignored outright - trusting it let anyone bid as
        // anyone and spoof past the own-listing check below.
        const auth = await requireUser(supabase, request, 'Authentication required to place a bid.');
        if (auth.response) {
          return auth.response;
        }

        const userId = auth.user.id;
        const userName = auth.user.name;

        const body = await request.json();
        const { amount } = body as { amount?: unknown };

        // A missed cron tick must not let a bid land on an auction that has
        // already reached end_time but hasn't been marked 'ended' yet.
        await settleBeforeRead(supabase, auctionId);

        // Optimistic lock: the UPDATE is guarded on the bid_version we read, so
        // a bid that lands between our read and our write makes the write match
        // zero rows instead of silently clobbering its bids array. See
        // readBidLock/applyBidLock in workers/shared.ts for why the guard is an
        // integer version rather than the price it used to be.
        for (let attempt = 0; attempt < MAX_BID_ATTEMPTS; attempt += 1) {
          // Typed `any`: `.select(BID_READ_COLUMNS)` passes a runtime `string`, not a literal, so
          // postgrest-js's compile-time column parser (which only understands a literal) falls
          // back to a `GenericStringError` type it cannot resolve. The rest of this file works
          // around the same thing by typing a mapper's row parameter `any` (see mapAuctionRow);
          // there is no such mapper here, so it is annotated directly instead.
          const { data: rawAuction, error: fetchErr }: { data: any; error: any } = await supabase
            .from('auctions')
            .select(BID_READ_COLUMNS)
            .eq('id', auctionId)
            .maybeSingle();

          if (fetchErr || !rawAuction) {
            return jsonResponse(makeError('Auction listing was not found.', 'AUCTION_NOT_FOUND'), { status: 404 });
          }

          const bids = Array.isArray(rawAuction.bids) ? rawAuction.bids : [];
          const startingPrice = Number(rawAuction.starting_price ?? rawAuction.startingPrice);
          const sellerId = rawAuction.seller_id ?? rawAuction.sellerId;
          const endTime = Number(rawAuction.end_time ?? rawAuction.endTime);

          const lock = readBidLock(rawAuction, startingPrice);
          const currentPrice = lock.currentPrice;

          // Bids are only accepted on a LIVE listing: 'ended' is covered by the
          // end_time check below, and this additionally refuses a 'cancelled' or
          // admin-'hidden' listing, neither of which is ever allowed to take a
          // new bid regardless of end_time.
          if (rawAuction.status !== AUCTION_STATUS.active) {
            return jsonResponse(makeError('This listing is no longer accepting bids.', 'AUCTION_ENDED'), { status: 400 });
          }

          if (Date.now() >= endTime) {
            return jsonResponse(makeError('This auction has already ended.', 'AUCTION_ENDED'), { status: 400 });
          }

          if (sellerId === userId) {
            return jsonResponse(makeError('You cannot place a bid on your own listing.', 'CANNOT_BID_OWN_LISTING'), { status: 400 });
          }

          const numericAmount = Number(amount);
          if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
            return jsonResponse(makeError('Please enter a valid bid amount.', 'INVALID_BID_AMOUNT'), { status: 400 });
          }

          if (bids.length === 0) {
            if (numericAmount < startingPrice) {
              return jsonResponse(makeError(`Starting bid must be at least £${startingPrice.toLocaleString()}.`, 'BID_TOO_LOW'), { status: 400 });
            }
          } else if (numericAmount <= currentPrice) {
            return jsonResponse(makeError(`Bid must be strictly higher than current bid of £${currentPrice.toLocaleString()}.`, 'BID_TOO_LOW'), { status: 400 });
          }

          const newBid = {
            id: `bid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            auctionId,
            userId,
            userName,
            amount: numericAmount,
            timestamp: Date.now(),
          };

          const updatedBids = [newBid, ...bids];

          // Guarded on status + end_time IN ADDITION to the bid_version/price lock:
          // a settle or a cancel/hide landing between our read and this write must
          // also make the UPDATE match zero rows, not just a concurrent bid. Both
          // settle and hideAuction bump bid_version for exactly this reason, so
          // the applyBidLock guard alone would already catch a settle - these two
          // are a second, independent guard against the same race.
          let updateQuery = supabase
            .from('auctions')
            .update({
              bids: updatedBids,
              current_price: numericAmount,
              highest_bidder_id: userId,
              highest_bidder_name: userName,
              ...bidLockUpdate(lock),
            })
            .eq('id', auctionId)
            .eq('status', AUCTION_STATUS.active)
            .gt('end_time', Date.now());

          updateQuery = applyBidLock(updateQuery, lock);

          const { data: updatedRows, error: updateErr } = await updateQuery.select('id');

          if (updateErr) {
            return jsonResponse(getErrorMessageAndCode('Unable to place the bid right now.', 'BID_UPDATE_FAILED', updateErr), { status: 500 });
          }

          if (Array.isArray(updatedRows) && updatedRows.length > 0) {
            return jsonResponse({ success: true, bid: newBid });
          }

          // Zero rows affected: someone else bid first, or the listing ended/was
          // cancelled/hidden between the read above and this write. Re-read and
          // revalidate - the top-of-loop checks above will produce the right
          // error (AUCTION_ENDED etc.) the next time round for anything other
          // than a genuine bid race.
        }

        return jsonResponse(makeError('Another bid landed at the same moment. Please try again.', 'BID_CONFLICT'), { status: 409 });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to place bid.', 'PLACE_BID_FAILED', error), { status: 500 });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/users/me/activity') {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const auth = await requireUser(supabase, request, 'Authentication required.');
        if (auth.response) {
          return auth.response;
        }

        // No lazy settle here - see the comment on GET /api/auctions. This route
        // is authenticated, own-data-only, so AUCTION_DETAIL_COLUMNS (which
        // carries phone_number, unlike the public list) is used instead of
        // AUCTION_LIST_COLUMNS: WinnerContactPanel needs a won listing's
        // phoneNumber to show the seller's contact details.
        const { data, error } = await supabase.from('auctions').select(AUCTION_DETAIL_COLUMNS);
        if (error) throw error;

        const auctions = (data ?? []).map((row: any) => mapAuctionSummaryRow(row));
        return jsonResponse(selectActivity(auctions, auth.user.id));
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to load your activity.', 'FETCH_ACTIVITY_FAILED', error), { status: 500 });
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/notifications') {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const auth = await requireUser(supabase, request, 'Authentication required.');
        if (auth.response) {
          return auth.response;
        }

        // No lazy settle here - see the comment on GET /api/auctions.
        const { data, error } = await supabase.from('auctions').select(NOTIFICATION_COLUMNS);
        if (error) throw error;

        const auctions = (data ?? []).map((row: any) => mapAuctionRow(row));
        return jsonResponse(buildNotifications(auctions, auth.user.id));
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to load notifications.', 'FETCH_NOTIFICATIONS_FAILED', error), { status: 500 });
      }
    }

    return jsonResponse(makeError('Route not found.', 'NOT_FOUND'), { status: 404 });
  },

  /**
   * Cron trigger (see `[triggers]` in wrangler.toml, which now names two
   * schedules). `event.cron` tells the two apart so each does exactly one job:
   *
   *   `* * * * *`  (every minute) -> settlement, as before. Nothing else in
   *                                  production ends an auction, so without
   *                                  this every ended listing keeps its null
   *                                  winner columns forever.
   *   `0 3 * * *`  (03:00 UTC     -> the stale-image sweep, gated on
   *    daily)                        `ENABLE_STALE_IMAGE_CLEANUP` (see
   *                                  `wrangler.toml` and `cleanupStaleImages`
   *                                  in `workers/shared.ts`). Cloudflare cron
   *                                  schedules always run in UTC.
   *
   * Anything else falls back to settlement too, so a manually-triggered test
   * cron (which the dashboard lets an admin fire with no `cron` field at all)
   * still does the safe, idempotent thing rather than nothing.
   */
  async scheduled(event: any, env: Record<string, any>, _ctx: any): Promise<void> {
    const supabase = getSupabaseClient(env);

    if (!supabase) {
      console.error('Scheduled task skipped: Supabase env vars are not configured.');
      return;
    }

    if (event?.cron === STALE_IMAGE_CLEANUP_CRON) {
      if (!isStaleImageCleanupEnabled(env)) {
        return;
      }

      try {
        const cleaned = await cleanupStaleImages(supabase);
        if (cleaned > 0) {
          console.log(`[Cleanup] Blanked images on ${cleaned} stale auction(s).`);
        }
      } catch (error) {
        console.error('Scheduled stale image cleanup failed:', error);
      }
      return;
    }

    try {
      const settled = await settleEndedAuctions(supabase);
      if (settled.length > 0) {
        console.log(`[Settle] Ended ${settled.length} auction(s).`);
      }
    } catch (error) {
      console.error('Scheduled settle failed:', error);
    }
  },
};
