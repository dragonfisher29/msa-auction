import { apiFetch, apiFetchAuthed } from './api';
import {
  AUTH_ERROR_CODES,
  IMAGE_STORAGE_UNAVAILABLE,
  IMAGE_TOO_LARGE,
  UNSUPPORTED_IMAGE_TYPE,
  readErrorCode,
  stripErrorCode,
} from './apiErrors';

/**
 * In-memory cache of `GET /api/auctions/:id/images` results, keyed by auction id.
 *
 * The paginated list endpoint no longer ships any image data on a list row (see the API
 * contract in the project brief), so `AuctionCard` fetches images lazily, only once a card is
 * near the viewport. This cache is what makes "scroll back up" free: once an id has resolved,
 * every subsequent mount of that card (or the feed refresh replacing its listing object) reuses
 * the same array instead of hitting the network again.
 *
 * Deliberately module-level rather than component state: AuctionCard instances come and go as
 * the grid re-sorts/re-filters, but the underlying image data for a given auction id doesn't
 * change on that cadence, so the cache should outlive any single card instance.
 */
const imageCache = new Map<string, string[]>();
const inFlight = new Map<string, Promise<string[]>>();

function sanitize(urls: unknown): string[] {
  return Array.isArray(urls)
    ? urls.filter((url): url is string => typeof url === 'string' && url.trim() !== '')
    : [];
}

/**
 * The listing's `imagesVersion` (epoch ms of its last photo change, 0 = unchanged since v1), or
 * `undefined` when the row does not carry one. Read defensively because `AuctionItem` in
 * `src/types.ts` does not declare the field yet.
 */
export function imagesVersionOf(auction: unknown): number | undefined {
  const value = (auction as { imagesVersion?: unknown } | null)?.imagesVersion;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export interface FetchAuctionImagesOptions {
  /**
   * Only the cover photo (`?first=1`): what a browse card shows. The server extracts it in the
   * database, so the listing's other photos are never downloaded for a card.
   */
  first?: boolean;
  /**
   * The listing's `imagesVersion`, sent as `?v=`. When it matches the server's current version
   * the response may be cached by the browser for a day; a new version (the seller changed the
   * photos) is a new URL, so it can never be served stale. Omitted = the short 5-minute cache.
   */
  version?: number;
}

/**
 * Resolves the image URLs for one auction, fetching `GET /api/auctions/:id/images` at most once
 * per (id, version, first-only) - concurrent callers share the same in-flight request. A cached
 * FULL set also answers a first-only request, so opening a listing and scrolling back past its
 * card costs nothing extra. A failed or non-OK response resolves to `[]` and is NOT cached, so a
 * transient network error can be retried the next time the card comes into view rather than
 * being stuck empty for the rest of the session.
 */
export function fetchAuctionImages(auctionId: string, options: FetchAuctionImagesOptions = {}): Promise<string[]> {
  const first = Boolean(options.first);
  const version = options.version;
  const fullKey = `${auctionId}|${version ?? ''}|all`;
  const key = first ? `${auctionId}|${version ?? ''}|first` : fullKey;

  const cached = imageCache.get(key) ?? (first ? imageCache.get(fullKey)?.slice(0, 1) : undefined);
  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }

  const params = new URLSearchParams();
  if (first) params.set('first', '1');
  if (version !== undefined) params.set('v', String(version));
  const query = params.toString();

  const request = (async () => {
    try {
      const res = await apiFetch(`/api/auctions/${auctionId}/images${query ? `?${query}` : ''}`);
      if (!res.ok) {
        return [];
      }
      const data = await res.json().catch(() => null);
      const urls = sanitize(data?.imageUrls);
      imageCache.set(key, urls);
      return urls;
    } catch (err) {
      console.warn(`Could not load images for auction ${auctionId}:`, err);
      return [];
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);
  return request;
}

/** Exposed for tests only: resets the module-level cache between test cases. */
export function __resetImageCacheForTests(): void {
  imageCache.clear();
  inFlight.clear();
}

/* -------------------------------------------------------------------------- */
/* Client-side compression + upload to POST /api/images                       */
/* -------------------------------------------------------------------------- */

/**
 * The R2 migration: `CreateListingModal` no longer submits base64 data URLs inline in the
 * listing payload (every byte of that was Supabase egress). Instead, each picked file is
 * compressed client-side as before, then uploaded here to `POST /api/images`, and only the
 * short `/images/<key>` path the server hands back is ever sent in `imageUrls`.
 */

export const MAX_IMAGE_DIMENSION = 1024;
/** Mirrors the server's 5 MB cap on `POST /api/images` -- checked client-side too, so a caller
 *  gets an immediate answer instead of waiting on a round trip that was always going to fail. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Mirrors the server's accepted `Content-Type` allowlist on `POST /api/images`. */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
/** Human-readable form of `ACCEPTED_IMAGE_TYPES`, for UI copy and error messages. */
export const ACCEPTED_IMAGE_TYPES_LABEL = 'JPEG, PNG, WEBP, or GIF';

const readFileAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
  reader.readAsDataURL(file);
});

/**
 * JPEG quality passed to `canvas.toBlob` on the first attempt. Tuned so a typical 12MP phone
 * photo, once scaled down to `MAX_IMAGE_DIMENSION`, lands around 100-150KB rather than the
 * ~1.9MB a barely-compressed upload used to cost in `image_urls`. A photo that is still too
 * detailed at this quality is retried at a lower one -- see `IMAGE_COMPRESSION_LADDER` below.
 */
export const IMAGE_OUTPUT_QUALITY = 0.7;

/**
 * The client-side target for a compressed image's decoded byte size, checked against
 * `Blob.size` -- which, for a blob later base64-encoded into a `data:` URL (see `blobToDataUrl`),
 * IS the decoded byte size the server's `estimateDataUrlBytes` would compute: base64 encoding is
 * a lossless, size-preserving round trip, so comparing `blob.size` here is exactly the comparison
 * `estimateDataUrlBytes(dataUrl) > MAX_INLINE_IMAGE_BYTES` makes server-side, just without paying
 * for the base64 encode first.
 *
 * Deliberately below the server's `MAX_INLINE_IMAGE_BYTES` (see `workers/shared.ts`), not equal
 * to it: the two are allowed to drift apart in exactly one direction (client stricter than
 * server) and a unit test pins that inequality so they can never cross.
 */
export const CLIENT_IMAGE_TARGET_BYTES = 280 * 1024;

/**
 * The long-edge scale factor and resulting dimensions for a source image, capped at
 * `MAX_IMAGE_DIMENSION`. Pulled out of `compressImageToBlob` so the arithmetic can be unit
 * tested without a real `<canvas>` (jsdom does not implement one).
 */
export function computeScaledDimensions(
  width: number,
  height: number,
  maxDimension: number = MAX_IMAGE_DIMENSION,
): { width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** One point on the compression ladder: what to draw at, and what quality to encode with. */
export interface CompressionAttempt {
  quality: number;
  maxDimension: number;
}

/**
 * Quality steps tried, in order, before falling back to a smaller `maxDimension`. Chosen so the
 * first attempt is `IMAGE_OUTPUT_QUALITY` (the size that is already right for almost every
 * photo) and each retry after that is a meaningfully bigger size cut, not a marginal one.
 */
const COMPRESSION_QUALITY_STEPS = [IMAGE_OUTPUT_QUALITY, 0.6, 0.5, 0.4] as const;

/**
 * Dimension steps tried once every quality step has been exhausted at the current size. Only
 * reached by an unusually detailed photo (e.g. a busy, high-contrast scene) that is still over
 * `CLIENT_IMAGE_TARGET_BYTES` at the lowest quality step.
 */
const COMPRESSION_DIMENSION_STEPS = [MAX_IMAGE_DIMENSION, 800] as const;

/**
 * Every attempt `compressImageToBlob` will try, in order: all quality steps at
 * `MAX_IMAGE_DIMENSION` first, then all quality steps again at 800px. Flattened into one ladder
 * so the retry loop is just "index + 1", and so `planNextCompressionStep` (below) can be a pure
 * function of an index rather than needing to re-derive "what comes after quality 0.4 at 1024px".
 */
export const IMAGE_COMPRESSION_LADDER: CompressionAttempt[] = COMPRESSION_DIMENSION_STEPS.flatMap((maxDimension) =>
  COMPRESSION_QUALITY_STEPS.map((quality) => ({ quality, maxDimension })),
);

export type CompressionPlan =
  | { action: 'accept' }
  | { action: 'retry'; attemptIndex: number; step: CompressionAttempt }
  | { action: 'giveUp' };

/**
 * Pure retry planner: given the size a just-encoded blob came out to and which rung of
 * `IMAGE_COMPRESSION_LADDER` produced it, decides what `compressImageToBlob` does next.
 *
 * `accept`  -- the blob is small enough to use as-is.
 * `retry`   -- try the next, more aggressive rung.
 * `giveUp`  -- every rung has been tried and the photo is still over target; the caller should
 *              surface a friendly error rather than submit something the server will 400.
 *
 * No canvas, no `Blob`, no I/O -- this is why it is unit-testable without jsdom's missing canvas
 * support, and it is the only place the retry DECISION lives; `compressImageToBlob` just acts on
 * whatever this returns.
 */
export function planNextCompressionStep(
  attemptIndex: number,
  sizeBytes: number,
  targetBytes: number = CLIENT_IMAGE_TARGET_BYTES,
): CompressionPlan {
  if (sizeBytes <= targetBytes) {
    return { action: 'accept' };
  }

  const nextIndex = attemptIndex + 1;
  if (nextIndex >= IMAGE_COMPRESSION_LADDER.length) {
    return { action: 'giveUp' };
  }

  return { action: 'retry', attemptIndex: nextIndex, step: IMAGE_COMPRESSION_LADDER[nextIndex] };
}

/**
 * Draws `image` onto a fresh canvas at `step.maxDimension` and encodes it as a JPEG at
 * `step.quality`. Split out of `compressImageToBlob` so the retry loop there can call it once per
 * rung of the ladder without repeating the canvas setup.
 *
 * White background first: a transparent PNG/WEBP/GIF re-encoded straight to JPEG would otherwise
 * turn every transparent pixel black.
 */
function encodeAttempt(image: HTMLImageElement, step: CompressionAttempt, fileName: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const { width: targetWidth, height: targetHeight } = computeScaledDimensions(
    image.width,
    image.height,
    step.maxDimension,
  );

  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    return Promise.reject(new Error(`Could not create a preview for ${fileName}.`));
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error(`Could not compress ${fileName}.`));
          return;
        }
        resolve(blob);
      },
      'image/jpeg',
      step.quality,
    );
  });
}

/**
 * Compresses one picked file to at most `MAX_IMAGE_DIMENSION`px on its long edge, returning the
 * result as a `Blob` ready to POST as raw bytes (as opposed to the base64 data URL the old
 * flow embedded directly in the listing payload).
 *
 * The output is ALWAYS a JPEG, regardless of the source type. If the first attempt still comes
 * out over `CLIENT_IMAGE_TARGET_BYTES` -- an unusually detailed photo at 1024px and quality 0.7
 * can -- `planNextCompressionStep` walks `IMAGE_COMPRESSION_LADDER` down through lower qualities
 * and then smaller dimensions until the blob fits, so the server's `MAX_INLINE_IMAGE_BYTES` guard
 * (see `workers/shared.ts`) never has a reason to 400 a file this function accepted. If nothing
 * on the ladder gets under target, this throws a friendly error instead of returning a blob the
 * server would reject.
 */
export async function compressImageToBlob(file: File): Promise<Blob> {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    throw new Error(`${file.name} is not a supported image type. Please upload a ${ACCEPTED_IMAGE_TYPES_LABEL} image.`);
  }

  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`${file.name} is over the 5 MB limit. Please choose a smaller file.`);
  }

  const source = await readFileAsDataUrl(file);

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not process ${file.name}.`));
    img.src = source;
  });

  let attemptIndex = 0;

  while (true) {
    const step = IMAGE_COMPRESSION_LADDER[attemptIndex];
    const blob = await encodeAttempt(image, step, file.name);
    const plan = planNextCompressionStep(attemptIndex, blob.size);

    if (plan.action === 'accept') {
      return blob;
    }

    if (plan.action === 'giveUp') {
      throw new Error(
        `${file.name} is too detailed to compress under this site's size limit, even at reduced quality. ` +
          `Please choose a smaller or simpler photo.`,
      );
    }

    attemptIndex = plan.attemptIndex;
  }
}

/** Thin wrapper around `URL.createObjectURL`, kept here so component tests can mock it instead
 *  of depending on jsdom's (nonexistent) Blob URL support. */
export function createPreviewUrl(file: File): string {
  return URL.createObjectURL(file);
}

/** Companion to `createPreviewUrl`: releases a blob preview URL once it's no longer shown. Safe
 *  to call on a non-blob URL (e.g. an already-stored `/images/<key>` path) -- it's a no-op then. */
export function revokePreviewUrl(url: string): void {
  if (url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

/**
 * Converts an already-compressed image `Blob` to a base64 `data:` URL, for the
 * `IMAGE_STORAGE_UNAVAILABLE` fallback in `CreateListingModal`: when object storage isn't
 * configured, the same compressed bytes that would have gone to `POST /api/images` are instead
 * embedded directly in `imageUrls`, exactly as the app did before R2 existed.
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the compressed image.'));
    reader.readAsDataURL(blob);
  });
}

/** Thrown by `uploadImage` with the server's machine-readable `code` attached, so callers can
 *  render one of the specific messages below instead of a generic failure. */
export class ImageUploadError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ImageUploadError';
    this.code = code;
  }
}

/**
 * Uploads one already-compressed image's bytes to `POST /api/images` and resolves to the
 * server's `/images/<key>` path. The raw bytes go up with the blob's own `Content-Type` --
 * the endpoint does not accept JSON/base64.
 */
export async function uploadImage(blob: Blob, token: string | null | undefined): Promise<{ url: string; key: string }> {
  const res = await apiFetchAuthed('/api/images', token, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const code = readErrorCode(data);

    if (code === UNSUPPORTED_IMAGE_TYPE) {
      throw new ImageUploadError(`This file type is not supported. Please upload a ${ACCEPTED_IMAGE_TYPES_LABEL} image.`, code);
    }
    if (code === IMAGE_TOO_LARGE) {
      throw new ImageUploadError('This image is over the 5 MB limit. Please choose a smaller file.', code);
    }
    if (code === IMAGE_STORAGE_UNAVAILABLE) {
      // Caught specifically by `CreateListingModal`, which falls back to a base64 `data:` URL --
      // this message is never actually shown to a user (the fallback is invisible on success).
      throw new ImageUploadError('Image storage is not currently available.', code);
    }
    if (code && AUTH_ERROR_CODES.has(code)) {
      throw new ImageUploadError('Your session has expired. Please sign in again to upload images.', code);
    }

    throw new ImageUploadError(
      data?.error ? stripErrorCode(data.error) : `Image upload failed with status ${res.status}.`,
      code ?? 'UNKNOWN',
    );
  }

  if (!data || typeof data.url !== 'string' || data.url.trim() === '') {
    throw new ImageUploadError('Upload succeeded but the server did not return an image URL.', 'INVALID_RESPONSE');
  }

  return { url: data.url, key: typeof data.key === 'string' ? data.key : '' };
}
