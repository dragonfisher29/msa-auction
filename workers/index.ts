import { createClient } from '@supabase/supabase-js';
import {
  AUCTION_DETAIL_COLUMNS,
  AUCTION_META_COLUMNS,
  AUCTION_OWNER_COLUMNS,
  AUCTION_STATE_COLUMNS,
  AUCTION_STATUS,
  bannedMessage,
  buildAuctionMetaTags,
  cleanupStaleImages,
  countLiveListings,
  createAuctionReport,
  createPasswordResetRequest,
  deriveListingStatus,
  fetchAuctionListPage,
  fetchSellerListings,
  hashPassword,
  hideAuction,
  IMAGE_BACKFILL_UNAVAILABLE_MESSAGE,
  IMAGE_CACHE_CONTROL,
  IMAGE_PATH_PREFIX,
  IMAGE_STORAGE_UNAVAILABLE_MESSAGE,
  injectAuctionMeta,
  isAdminUser,
  isAuctionVisible,
  isBannedUser,
  isBearerTokenAdmin,
  isFailure,
  isStaleImageCleanupEnabled,
  isStoredImagePath,
  listingBaselineFromRow,
  listingTtlMs,
  listPendingResetRequests,
  listReportsForAdmin,
  mapListingRow,
  matchAuctionSharePath,
  matchImageServePath,
  MAX_IMAGE_BYTES,
  mergeAuctionEdit,
  migrateAuctionImages,
  putImage,
  resetPasswordWithToken,
  setUserBan,
  setUserEmail,
  toStringArray,
  USER_ROLE,
  validateAccountFieldLengths,
  validateImageUpload,
  validateListingInput,
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

/**
 * The request body as JSON, or null when it is missing or malformed. The listing validator turns
 * null into a 400 INVALID_PAYLOAD, so a junk body is the caller's error rather than a 500.
 */
async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
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
 * is the opposite case: every reader (`mapListingRow` and `buildAuctionMetaTags`'s own
 * fallback) already falls back to `image_urls[0]`, and a `data:` URL is never usable as an
 * `og:image` regardless, so writing the full image a second time bought nothing but egress.
 */
function imageUrlMirror(firstImage: string | undefined): string | null {
  return typeof firstImage === 'string' && isStoredImagePath(firstImage) ? firstImage : null;
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

/** The `[triggers]` cron in wrangler.toml - see `scheduled()` below. */
const STALE_IMAGE_CLEANUP_CRON = '0 3 * * *';

/** Why a listing that is not live can no longer be changed by its seller, per derived status. */
const NOT_LIVE_MESSAGES: Record<string, string> = {
  sold: 'This listing has already been marked as sold.',
  expired: 'This listing has expired and is no longer on the site.',
  cancelled: 'This listing has already been withdrawn.',
  hidden: 'This listing has been taken down by the committee.',
};

function notLiveResponse(status: string): Response {
  return jsonResponse(
    makeError(NOT_LIVE_MESSAGES[status] ?? 'This listing is no longer active.', 'LISTING_NOT_EDITABLE'),
    { status: 409 },
  );
}

interface OwnedLiveListing {
  /** The row, when the caller owns it and it is live. */
  row: any;
  /** The 404 / 403 / 409 to send instead, or null. */
  response: Response | null;
}

/**
 * The shared precondition of every seller write (edit, mark sold, cancel): the listing exists,
 * the CALLER (from their token, never the body) is its seller, and it is live - stored active
 * and not expired. Each route's UPDATE re-asserts `status = 'active' AND expires_at > now` in
 * SQL anyway, so this read only exists to answer with the right status code; the guarded write
 * is what actually closes the race.
 */
async function loadOwnedLiveListing(
  supabase: any,
  auctionId: string,
  userId: string,
  columns: string,
  verb: string,
  now: number,
): Promise<OwnedLiveListing> {
  const { data: row, error } = await supabase.from('auctions').select(columns).eq('id', auctionId).maybeSingle();

  if (error) throw error;
  if (!row) {
    return { row: null, response: jsonResponse(makeError('Auction not found', 'AUCTION_NOT_FOUND'), { status: 404 }) };
  }

  if ((row.seller_id ?? row.sellerId) !== userId) {
    return {
      row: null,
      response: jsonResponse(makeError(`Only the seller can ${verb} this listing.`, 'NOT_LISTING_OWNER'), { status: 403 }),
    };
  }

  const status = deriveListingStatus(row, now);
  if (status !== AUCTION_STATUS.active) {
    return { row: null, response: notLiveResponse(status) };
  }

  return { row, response: null };
}

/**
 * Applies the "still live" guard to a seller's UPDATE: `status = 'active' AND expires_at > now`.
 * A listing that sold, was cancelled or hidden, or expired between the read and the write makes
 * the UPDATE match zero rows, which each route turns into a 409 rather than a silent overwrite.
 */
function guardLive(query: any, now: number): any {
  return query.eq('status', AUCTION_STATUS.active).gt('expires_at', now);
}

/**
 * The status a zero-row guarded UPDATE is reported with: re-read the row's state so the 409
 * names what actually happened (sold / withdrawn / expired / taken down).
 */
async function zeroRowResponse(supabase: any, auctionId: string, now: number): Promise<Response> {
  const { data } = await supabase.from('auctions').select(AUCTION_STATE_COLUMNS).eq('id', auctionId).maybeSingle();
  return notLiveResponse(data ? deriveListingStatus(data, now) : 'expired');
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
    // The fixed asking price and the derived status (For sale / Sold / No longer listed / ...).
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

        const lengthFailure = validateAccountFieldLengths({ username, name, password });
        if (lengthFailure) {
          return failureResponse(lengthFailure);
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
        // Live listings only (active AND not expired, filtered in SQL), slim
        // rows (no image payload, no phone), keyset page. See fetchAuctionListPage.
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

        // This is the heaviest response the API serves - let clients and the
        // edge keep it briefly. A seller's image edit shows up within 5 minutes.
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

        // Slim row (no image payload) - see AUCTION_DETAIL_COLUMNS. Any
        // non-hidden listing is returned whatever its status; `status` (with
        // `expired` derived in mapListingRow) tells the UI Sold / Expired.
        // There is no settlement any more, so this read writes nothing.
        const { data: row, error } = await supabase
          .from('auctions')
          .select(AUCTION_DETAIL_COLUMNS)
          .eq('id', auctionId)
          .maybeSingle();

        if (error) throw error;
        if (!row) return jsonResponse(makeError('Auction not found', 'AUCTION_NOT_FOUND'), { status: 404 });

        // Resolved once, from the same lookup: whether the caller is an admin
        // (for the hidden-listing check below) and whether they are signed in
        // at all (for whether phoneNumber goes on the wire). A missing or dead
        // token resolves both to false
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

        // The seller's WhatsApp number goes on the wire only for a signed-in
        // caller - an anonymous visitor viewing a listing cannot harvest it.
        return jsonResponse({ auction: mapListingRow(row, { includePhone: Boolean(requester) }) });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to load auction.', 'FETCH_AUCTION_FAILED', error), { status: 500 });
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Seller writes: edit, mark sold, cancel.                                 */
    /*                                                                        */
    /* All three share one precondition (loadOwnedLiveListing: exists, caller  */
    /* is the seller, listing is live) and one write guard (guardLive: the     */
    /* UPDATE re-asserts status = 'active' AND expires_at > now, plus the      */
    /* seller id). A guarded UPDATE that matches zero rows is a 409, never a   */
    /* silent success.                                                        */
    /* ---------------------------------------------------------------------- */

    if (request.method === 'PATCH' && singleAuctionMatch) {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const auctionId = singleAuctionMatch[1];
        const now = Date.now();

        const auth = await requireUser(supabase, request, 'Authentication required to edit a listing.');
        if (auth.response) {
          return auth.response;
        }

        const owned = await loadOwnedLiveListing(supabase, auctionId, auth.user.id, AUCTION_OWNER_COLUMNS, 'edit', now);
        if (owned.response) {
          return owned.response;
        }
        const row = owned.row;

        const rawBody = await readJsonBody(request);
        // Same validator as listing creation, run over row + patch merged. The stored values are
        // passed as the baseline, so an unchanged field that predates today's rules (an old,
        // larger photo; a legacy category) never blocks an unrelated edit.
        const validated = validateListingInput(mergeAuctionEdit(row, rawBody), listingBaselineFromRow(row));
        if (isFailure(validated)) {
          return failureResponse(validated);
        }

        // `expires_at` is deliberately absent: editing a listing never extends its life.
        const patch = {
          title: validated.data.title,
          description: validated.data.description,
          phone_number: validated.data.phoneNumber,
          category: validated.data.category,
          image_url: imageUrlMirror(validated.data.imageUrls[0]),
          image_urls: validated.data.imageUrls,
          price: validated.data.price,
        };

        const { data: updated, error: updateError } = await guardLive(
          supabase.from('auctions').update(patch).eq('id', auctionId).eq('seller_id', auth.user.id),
          now,
        ).select(AUCTION_OWNER_COLUMNS);

        if (updateError) throw updateError;

        if (!Array.isArray(updated) || updated.length === 0) {
          return zeroRowResponse(supabase, auctionId, now);
        }

        return jsonResponse({ auction: mapListingRow(updated[0], { now, includePhone: true, includeImages: true }) });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to update the listing.', 'UPDATE_LISTING_FAILED', error), {
          status: 500,
        });
      }
    }

    const soldMatch = url.pathname.match(/^\/api\/auctions\/([^/]+)\/sold$/);
    if (request.method === 'POST' && soldMatch) {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const auctionId = soldMatch[1];
        const now = Date.now();

        const auth = await requireUser(supabase, request, 'Authentication required to mark a listing as sold.');
        if (auth.response) {
          return auth.response;
        }

        const owned = await loadOwnedLiveListing(
          supabase,
          auctionId,
          auth.user.id,
          AUCTION_STATE_COLUMNS,
          'mark as sold',
          now,
        );
        if (owned.response) {
          return owned.response;
        }

        const { data: updated, error: updateError } = await guardLive(
          supabase
            .from('auctions')
            .update({ status: AUCTION_STATUS.sold, sold_at: now })
            .eq('id', auctionId)
            .eq('seller_id', auth.user.id),
          now,
        ).select(AUCTION_DETAIL_COLUMNS);

        if (updateError) throw updateError;

        if (!Array.isArray(updated) || updated.length === 0) {
          return zeroRowResponse(supabase, auctionId, now);
        }

        return jsonResponse({
          success: true,
          auction: mapListingRow(updated[0], { now, includePhone: true }),
        });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to mark the listing as sold.', 'MARK_SOLD_FAILED', error), {
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
        const now = Date.now();

        const auth = await requireUser(supabase, request, 'Authentication required to cancel a listing.');
        if (auth.response) {
          return auth.response;
        }

        const owned = await loadOwnedLiveListing(supabase, auctionId, auth.user.id, AUCTION_STATE_COLUMNS, 'cancel', now);
        if (owned.response) {
          return owned.response;
        }

        // SOFT delete, always: the row stays readable by id (a buyer holding the link sees
        // "withdrawn" rather than a dead page), it just leaves the browse list.
        const { data: updated, error: updateError } = await guardLive(
          supabase
            .from('auctions')
            .update({ status: AUCTION_STATUS.cancelled })
            .eq('id', auctionId)
            .eq('seller_id', auth.user.id),
          now,
        ).select(AUCTION_DETAIL_COLUMNS);

        if (updateError) throw updateError;

        // Zero rows: it sold, expired, or was hidden between the read and the write.
        if (!Array.isArray(updated) || updated.length === 0) {
          return zeroRowResponse(supabase, auctionId, now);
        }

        return jsonResponse({
          success: true,
          auction: mapListingRow(updated[0], { now, includePhone: true }),
          message: 'Listing withdrawn. It no longer appears on the site, but anyone holding a direct link can still open it.',
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
        const now = Date.now();

        const validated = validateListingInput(await readJsonBody(request));
        if (isFailure(validated)) {
          return failureResponse(validated);
        }

        const maxListingsPerUser = Number(env.MAX_LISTINGS_PER_USER ?? '20');
        // Counts LIVE listings only (active AND not expired). Sold, withdrawn and expired
        // listings do not count, so a seller is never locked out by their own history.
        const liveCount = await countLiveListings(supabase, user.id, now);
        if (liveCount >= maxListingsPerUser) {
          return jsonResponse(
            makeError(
              `You have reached the limit of ${maxListingsPerUser} active listings. Mark one as sold or withdraw it before creating another.`,
              'LISTING_LIMIT_REACHED',
            ),
            { status: 429 },
          );
        }

        const row = {
          id: `auc_${now}_${Math.random().toString(36).slice(2, 6)}`,
          title: validated.data.title,
          description: validated.data.description,
          phone_number: validated.data.phoneNumber,
          price: validated.data.price,
          seller_id: user.id,
          seller_name: user.name,
          status: AUCTION_STATUS.active,
          category: validated.data.category,
          // See `imageUrlMirror`: only an `/images/<key>` path is mirrored; the response below
          // still carries the full first image via `image_urls`.
          image_url: imageUrlMirror(validated.data.imageUrls[0]),
          image_urls: validated.data.imageUrls,
          created_at: now,
          expires_at: now + listingTtlMs(env),
          sold_at: null,
        };

        const { error: insertError } = await supabase.from('auctions').insert([row]);
        if (insertError) throw insertError;

        return jsonResponse(
          { auction: mapListingRow(row, { now, includePhone: true, includeImages: true }) },
          { status: 201 },
        );
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to create the listing.', 'CREATE_AUCTION_FAILED', error), {
          status: 500,
        });
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
          reporterIsAdmin: isAdminUser(auth.user),
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

    if (request.method === 'GET' && url.pathname === '/api/users/me/activity') {
      if (!supabase) {
        return jsonResponse(makeError('Supabase env vars are not configured.', 'CONFIG_ERROR'), { status: 500 });
      }

      try {
        const auth = await requireUser(supabase, request, 'Authentication required.');
        if (auth.response) {
          return auth.response;
        }

        // The caller's OWN listings, every status including hidden, filtered in
        // SQL on seller_id (the pre-v1 route read the whole table and filtered
        // in JS). Own data only, so the phone number is included.
        const listings = await fetchSellerListings(supabase, auth.user.id);
        return jsonResponse({ listings });
      } catch (error) {
        return jsonResponse(getErrorMessageAndCode('Failed to load your activity.', 'FETCH_ACTIVITY_FAILED', error), { status: 500 });
      }
    }

    return jsonResponse(makeError('Route not found.', 'NOT_FOUND'), { status: 404 });
  },

  /**
   * Cron trigger (see `[triggers]` in wrangler.toml, which names ONE schedule):
   *
   *   `0 3 * * *`  (03:00 UTC daily) -> the stale-image sweep, gated on
   *                                     `ENABLE_STALE_IMAGE_CLEANUP` (see
   *                                     `wrangler.toml` and `cleanupStaleImages`
   *                                     in `workers/shared.ts`). Cloudflare cron
   *                                     schedules always run in UTC.
   *
   * There is no settlement cron any more: a fixed-price listing needs no
   * settling, and expiry is derived at read time from `expires_at`.
   *
   * Any other `event.cron` (a leftover `* * * * *` trigger from the pre-v1
   * deploy, or a manual test fire with no `cron` field) does NOTHING. The only
   * scheduled job is an irreversible delete, and it must not start running
   * every minute because a stale trigger survived a deploy.
   */
  async scheduled(event: any, env: Record<string, any>, _ctx: any): Promise<void> {
    if (event?.cron !== STALE_IMAGE_CLEANUP_CRON) {
      console.warn(`Scheduled event ignored: no job is registered for cron "${String(event?.cron ?? '')}".`);
      return;
    }

    if (!isStaleImageCleanupEnabled(env)) {
      return;
    }

    const supabase = getSupabaseClient(env);
    if (!supabase) {
      console.error('Scheduled task skipped: Supabase env vars are not configured.');
      return;
    }

    try {
      const cleaned = await cleanupStaleImages(supabase);
      if (cleaned > 0) {
        console.log(`[Cleanup] Blanked images on ${cleaned} stale listing(s).`);
      }
    } catch (error) {
      console.error('Scheduled stale image cleanup failed:', error);
    }
  },
};
