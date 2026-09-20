import { apiFetch } from './api';

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
