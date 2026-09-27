/**
 * Shared helpers for reading the API's machine-readable error codes.
 *
 * The server appends a " [Code: SOME_CODE]" suffix to error messages for API consumers and
 * logs (see workers/index.ts). That suffix is not meant for end users, so it is stripped before
 * rendering in the UI. The code itself is also carried in the response body's own `code` field
 * on newer endpoints; prefer that and fall back to parsing the suffix so a response that only
 * carries one of the two is still classified correctly.
 *
 * Shared so the listing create/edit/sold/cancel flows (CreateListingModal, MarkSoldModal,
 * CancelListingModal) and the admin panel classify errors the same way without duplicating the
 * parsing logic.
 */

export function stripErrorCode(message: string): string {
  return message.replace(/\s*\[Code:\s*[^\]]+\]\s*$/, '');
}

export function readErrorCode(data: any): string | null {
  if (data && typeof data.code === 'string' && data.code.trim() !== '') {
    return data.code.trim();
  }
  const match = typeof data?.error === 'string' ? data.error.match(/\[Code:\s*([^\]]+)\]\s*$/) : null;
  return match ? match[1].trim() : null;
}

/** Codes that mean "the session is not usable", as opposed to a request the server merely refused. */
export const AUTH_ERROR_CODES = new Set(['UNAUTHORIZED', 'SESSION_EXPIRED']);

/** Returned by PATCH, DELETE and `POST /sold` when the caller is not the listing's seller. */
export const NOT_LISTING_OWNER = 'NOT_LISTING_OWNER';
/** Returned (with a 409) when the listing is no longer active -- sold, expired or cancelled --
 *  so it cannot be edited, cancelled or marked sold. Callers also treat a bare 409 this way. */
export const LISTING_NOT_EDITABLE = 'LISTING_NOT_EDITABLE';
/** Returned by `GET /api/auctions` when the `cursor` query param is malformed or stale. */
export const INVALID_CURSOR = 'INVALID_CURSOR';

/** `POST /api/images` refuses a file whose Content-Type isn't jpeg/png/webp/gif. */
export const UNSUPPORTED_IMAGE_TYPE = 'UNSUPPORTED_IMAGE_TYPE';
/** `POST /api/images` refuses a body over the 5 MB cap. */
export const IMAGE_TOO_LARGE = 'IMAGE_TOO_LARGE';
/** `POST /api/images` answers this with a 503 when object storage (R2) is not configured in this
 *  environment -- e.g. this university-society deployment, which cannot put a card on file with
 *  Cloudflare. This is a CONTRACT with the server (see workers/index.ts): the client is expected
 *  to fall back to embedding a compressed base64 `data:` URL directly in `imageUrls`, exactly as
 *  the app did before R2 existed. Do not rename this without updating the server too. */
export const IMAGE_STORAGE_UNAVAILABLE = 'IMAGE_STORAGE_UNAVAILABLE';

/* -------------------------------------------------------------------------- */
/* Moderation, bans and account recovery                                       */
/* -------------------------------------------------------------------------- */

/** Every `/api/admin/*` route answers this when the caller's row is not an admin. */
export const NOT_ADMIN = 'NOT_ADMIN';
/** `requireUser` answers this on any authenticated route once the account is banned. */
export const ACCOUNT_BANNED = 'ACCOUNT_BANNED';
/** `POST /api/auctions/:id/report` with a reason outside the fixed five. */
export const INVALID_REPORT_REASON = 'INVALID_REPORT_REASON';
/** Hide and ban both require a reason; this is the empty-reason refusal. */
export const MISSING_REASON = 'MISSING_REASON';
/** `POST /api/admin/users/:id/ban` refuses to let an admin ban themselves. */
export const CANNOT_BAN_SELF = 'CANNOT_BAN_SELF';
/** `POST /api/admin/users/:id/ban` refuses to ban another admin account. */
export const CANNOT_BAN_ADMIN = 'CANNOT_BAN_ADMIN';
/** The target of a ban/unban does not exist. */
export const USER_NOT_FOUND = 'USER_NOT_FOUND';
/** The listing behind a report/hide no longer exists. */
export const AUCTION_NOT_FOUND = 'AUCTION_NOT_FOUND';
/** `POST /api/auth/email` (and register) on a malformed address. */
export const INVALID_EMAIL = 'INVALID_EMAIL';
/** `POST /api/auth/email` when another account already holds that address. */
export const EMAIL_TAKEN = 'EMAIL_TAKEN';

/**
 * The three ways `POST /api/auth/reset-password` refuses a token. All three mean the same
 * thing to the user -- this link is dead, ask for another -- so the reset screen groups them.
 */
export const INVALID_RESET_TOKEN = 'INVALID_RESET_TOKEN';
export const RESET_TOKEN_EXPIRED = 'RESET_TOKEN_EXPIRED';
export const RESET_TOKEN_USED = 'RESET_TOKEN_USED';

export const DEAD_RESET_TOKEN_CODES = new Set([
  INVALID_RESET_TOKEN,
  RESET_TOKEN_EXPIRED,
  RESET_TOKEN_USED,
]);

/**
 * One sentence for a moderation failure, shared by every admin control.
 *
 * Only the codes whose server message would be unclear (or which need the admin to do
 * something different) are rewritten; everything else falls through to the server's own text,
 * which is already written for a human. The two ban refusals in particular must not collapse
 * into "something went wrong": an admin who is told nothing will retry the same click, and
 * "you cannot ban your own account" vs "admin accounts cannot be banned from here" are two
 * genuinely different situations with two different next steps.
 */
export function describeModerationError(data: any, fallback: string): string {
  const code = readErrorCode(data);

  if (code && AUTH_ERROR_CODES.has(code)) {
    return 'Your session has expired. Please sign in again.';
  }

  switch (code) {
    case NOT_ADMIN:
      return 'Your account is not a committee admin, so this action was refused.';
    case CANNOT_BAN_SELF:
      return 'You cannot ban your own account. Ask another committee admin if this is intended.';
    case CANNOT_BAN_ADMIN:
      return 'That account is a committee admin and cannot be banned from here. Change their role in the database first.';
    case USER_NOT_FOUND:
      return 'No account with that ID was found. Check the ID and try again.';
    case AUCTION_NOT_FOUND:
      return 'That listing no longer exists.';
    case MISSING_REASON:
      return 'A reason is required. It is recorded against the action.';
    default:
      return typeof data?.error === 'string' ? stripErrorCode(data.error) : fallback;
  }
}
