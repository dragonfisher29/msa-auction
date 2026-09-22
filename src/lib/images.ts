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
 * every subsequent mount of that card (or the 5s list poll replacing its auction object) reuses
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
 * Resolves the image URLs for one auction, fetching `GET /api/auctions/:id/images` at most once
 * per id (concurrent callers share the same in-flight request). A failed or non-OK response
 * resolves to `[]` and is NOT cached, so a transient network error can be retried the next time
 * the card comes into view rather than being stuck empty for the rest of the session.
 */
export function fetchAuctionImages(auctionId: string): Promise<string[]> {
  const cached = imageCache.get(auctionId);
  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = inFlight.get(auctionId);
  if (pending) {
    return pending;
  }

  const request = (async () => {
    try {
      const res = await apiFetch(`/api/auctions/${auctionId}/images`);
      if (!res.ok) {
        return [];
      }
      const data = await res.json().catch(() => null);
      const urls = sanitize(data?.imageUrls);
      imageCache.set(auctionId, urls);
      return urls;
    } catch (err) {
      console.warn(`Could not load images for auction ${auctionId}:`, err);
      return [];
    } finally {
      inFlight.delete(auctionId);
    }
  })();

  inFlight.set(auctionId, request);
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

export const MAX_IMAGE_DIMENSION = 1600;
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
 * Compresses one picked file to at most `MAX_IMAGE_DIMENSION`px on its long edge, returning the
 * result as a `Blob` ready to POST as raw bytes (as opposed to the base64 data URL the old
 * flow embedded directly in the listing payload).
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

  const canvas = document.createElement('canvas');
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(image.width, image.height));
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const targetHeight = Math.max(1, Math.round(image.height * scale));

  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error(`Could not create a preview for ${file.name}.`);
  }

  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const quality = file.size > 1_000_000 ? 0.72 : 0.85;

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error(`Could not compress ${file.name}.`));
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
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
