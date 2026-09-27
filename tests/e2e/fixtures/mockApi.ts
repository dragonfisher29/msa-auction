import type { Page, Route } from '@playwright/test';
import { demoAuctions } from './auctions';
import type { AuctionItem } from '../../../src/types';

export interface MockApiOptions {
  /** Simulates object storage (R2) not being configured: every `POST /api/images` answers 503
   *  `IMAGE_STORAGE_UNAVAILABLE` instead of accepting the upload, matching what this deployment
   *  actually does until R2 is turned on. Lets e2e tests exercise `CreateListingModal`'s base64
   *  `data:` URL fallback the same way `tests/components/CreateListingModal.test.tsx` does. */
  imageStorageUnavailable?: boolean;
}

/** One request the app made, as seen by the mock -- lets specs assert on request volume. */
export interface RecordedRequest {
  method: string;
  pathname: string;
  authed: boolean;
}

const DEFAULT_PAGE_LIMIT = 24;
const LISTING_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** The only identity the mocked login/register hand out, and the owner of `auc_ellie_lamp`. */
export const E2E_USER_ID = 'usr_e2e_tester';

/** Mirrors the real `POST /api/images` contract's accepted `Content-Type`s and 5 MB cap. */
const ACCEPTED_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
let imageUploadSeq = 0;

function imageCountOf(auction: AuctionItem): number {
  return Array.isArray(auction.imageUrls)
    ? auction.imageUrls.filter((url) => typeof url === 'string' && url.trim() !== '').length
    : auction.imageUrl
    ? 1
    : 0;
}

/**
 * Strips the image fields (and the phone number) off a full `AuctionItem` and replaces them with
 * `imageCount`, matching what `GET /api/auctions` (the paginated list endpoint) actually returns
 * in production: no image data and no contact details on a list row, by design.
 */
function toListRow(auction: AuctionItem) {
  const { imageUrl, imageUrls, phoneNumber, ...rest } = auction;
  return { ...rest, imageCount: imageCountOf(auction) };
}

/**
 * `GET /api/auctions/:id` in production: no image data (only `imageCount`), and `phoneNumber`
 * only for an authenticated caller.
 */
function toDetailRow(auction: AuctionItem, authed: boolean) {
  const { imageUrl, imageUrls, phoneNumber, ...rest } = auction;
  return authed ? { ...rest, phoneNumber, imageCount: imageCountOf(auction) } : { ...rest, imageCount: imageCountOf(auction) };
}

/** The status the server would report right now (it derives 'expired' itself). */
function currentStatus(auction: AuctionItem): AuctionItem['status'] {
  return auction.status === 'active' && auction.expiresAt <= Date.now() ? 'expired' : auction.status;
}

/** Mirrors the real feed: active listings only, newest first (`created_at DESC, id DESC`). */
function browseFeed(items: AuctionItem[]): AuctionItem[] {
  return items
    .filter((a) => currentStatus(a) === 'active')
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return b.createdAt - a.createdAt;
      }
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * Intercepts every `**\/api/**` request the app makes and serves fixture data instead,
 * so tests never touch Supabase or the deployed Cloudflare Worker.
 */
export async function mockApi(page: Page, options: MockApiOptions = {}) {
  const auctions: AuctionItem[] = demoAuctions.map((auction) => ({ ...auction }));
  const requests: RecordedRequest[] = [];

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;
    const authed = Boolean(request.headers()['authorization']);
    requests.push({ method, pathname, authed });

    const unauthorized = () => json(route, 401, { error: 'Unauthorized. [Code: UNAUTHORIZED]', code: 'UNAUTHORIZED' });

    if (method === 'GET' && pathname === '/api/auctions') {
      const url = new URL(request.url());
      const limitParam = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 60) : DEFAULT_PAGE_LIMIT;
      const cursor = url.searchParams.get('cursor');

      const ordered = browseFeed(auctions);
      let startIndex = 0;
      if (cursor) {
        startIndex = ordered.findIndex((a) => a.id === cursor) + 1;
        if (startIndex === 0) {
          // findIndex returned -1: the cursor doesn't match any known row.
          return json(route, 400, { error: 'Invalid cursor. [Code: INVALID_CURSOR]', code: 'INVALID_CURSOR' });
        }
      }

      const pageItems = ordered.slice(startIndex, startIndex + limit);
      const nextCursor = startIndex + limit < ordered.length ? pageItems[pageItems.length - 1]?.id ?? null : null;

      return json(route, 200, { auctions: pageItems.map(toListRow), nextCursor });
    }

    const imagesMatch = pathname.match(/^\/api\/auctions\/([^/]+)\/images$/);
    if (method === 'GET' && imagesMatch) {
      const auction = auctions.find((a) => a.id === imagesMatch[1]);
      if (!auction) {
        return json(route, 404, { error: 'Listing not found' });
      }
      const imageUrls = Array.isArray(auction.imageUrls) ? auction.imageUrls : auction.imageUrl ? [auction.imageUrl] : [];
      return json(route, 200, { imageUrls });
    }

    // The R2 upload endpoint: raw image bytes in, `{ url, key }` out. Requires auth like every
    // other write endpoint here -- a request with no Authorization header at all is refused,
    // matching the real worker's `requireUser` gate.
    if (method === 'POST' && pathname === '/api/images') {
      if (!authed) {
        return unauthorized();
      }

      // Mirrors the real worker with R2 unbound (the actual state at this deploy, since the
      // society cannot put a card on file with Cloudflare).
      if (options.imageStorageUnavailable) {
        return json(route, 503, {
          error: 'Image storage is not currently available. [Code: IMAGE_STORAGE_UNAVAILABLE]',
          code: 'IMAGE_STORAGE_UNAVAILABLE',
        });
      }

      const contentType = (request.headers()['content-type'] || '').split(';')[0].trim();
      if (!ACCEPTED_IMAGE_CONTENT_TYPES.includes(contentType)) {
        return json(route, 400, { error: 'Unsupported image type. [Code: UNSUPPORTED_IMAGE_TYPE]', code: 'UNSUPPORTED_IMAGE_TYPE' });
      }

      const bodyBuffer = request.postDataBuffer();
      if (!bodyBuffer || bodyBuffer.length > MAX_IMAGE_UPLOAD_BYTES) {
        return json(route, 413, { error: 'Image too large. [Code: IMAGE_TOO_LARGE]', code: 'IMAGE_TOO_LARGE' });
      }

      const key = `e2e_img_${Date.now()}_${++imageUploadSeq}`;
      return json(route, 201, { url: `/images/${key}`, key });
    }

    // Owner-only writes share the same gate: signed in, the seller, and still active. The mock
    // has exactly one identity (see the auth handlers below), so "the seller" means E2E_USER_ID.
    const soldMatch = pathname.match(/^\/api\/auctions\/([^/]+)\/sold$/);
    const itemMatch = pathname.match(/^\/api\/auctions\/([^/]+)$/);
    const ownerWriteId =
      method === 'POST' && soldMatch ? soldMatch[1] : (method === 'PATCH' || method === 'DELETE') && itemMatch ? itemMatch[1] : null;

    if (ownerWriteId) {
      if (!authed) {
        return unauthorized();
      }
      const auction = auctions.find((a) => a.id === ownerWriteId);
      if (!auction || auction.status === 'hidden') {
        return json(route, 404, { error: 'Listing not found. [Code: AUCTION_NOT_FOUND]', code: 'AUCTION_NOT_FOUND' });
      }
      if (auction.sellerId !== E2E_USER_ID) {
        return json(route, 403, { error: 'Only the seller can change this listing. [Code: NOT_LISTING_OWNER]', code: 'NOT_LISTING_OWNER' });
      }
      if (currentStatus(auction) !== 'active') {
        return json(route, 409, { error: 'This listing is no longer active. [Code: LISTING_NOT_EDITABLE]', code: 'LISTING_NOT_EDITABLE' });
      }

      if (soldMatch) {
        auction.status = 'sold';
        auction.soldAt = Date.now();
      } else if (method === 'DELETE') {
        auction.status = 'cancelled';
      } else {
        const body = request.postDataJSON() as Partial<AuctionItem>;
        Object.assign(auction, {
          title: body.title ?? auction.title,
          description: body.description ?? auction.description,
          phoneNumber: body.phoneNumber ?? auction.phoneNumber,
          category: body.category ?? auction.category,
          imageUrls: body.imageUrls ?? auction.imageUrls,
          price: body.price ?? auction.price,
        });
      }
      return json(route, 200, { auction });
    }

    if (method === 'GET' && itemMatch) {
      const auction = auctions.find((a) => a.id === itemMatch[1]);
      // Hidden listings are indistinguishable from missing ones to a non-admin.
      if (!auction || auction.status === 'hidden') {
        return json(route, 404, { error: 'Listing not found. [Code: AUCTION_NOT_FOUND]', code: 'AUCTION_NOT_FOUND' });
      }
      return json(route, 200, { auction: toDetailRow({ ...auction, status: currentStatus(auction) }, authed) });
    }

    if (method === 'POST' && pathname === '/api/auctions') {
      if (!authed) {
        return unauthorized();
      }
      const body = request.postDataJSON() as Record<string, any>;
      const now = Date.now();
      const created: AuctionItem = {
        id: `auc_e2e_${now}`,
        title: body.title,
        description: body.description,
        phoneNumber: body.phoneNumber,
        price: body.price,
        sellerId: E2E_USER_ID,
        sellerName: body.sellerName ?? 'Ellie Tester',
        status: 'active',
        expiresAt: now + LISTING_LIFETIME_MS,
        soldAt: null,
        category: body.category,
        imageUrl: body.imageUrl,
        imageUrls: body.imageUrls,
        createdAt: now,
      };
      auctions.unshift(created);
      return json(route, 201, { auction: created });
    }

    if (method === 'GET' && pathname === '/api/users/me/activity') {
      if (!authed) {
        return unauthorized();
      }
      return json(route, 200, {
        listings: auctions
          .filter((a) => a.sellerId === E2E_USER_ID)
          .map((a) => ({ ...toListRow(a), phoneNumber: a.phoneNumber, status: currentStatus(a) })),
      });
    }

    if (method === 'GET' && pathname === '/api/auth/me') {
      return authed ? json(route, 200, { user: { id: E2E_USER_ID, name: 'Ellie Tester', username: 'ellie', role: 'member' } }) : unauthorized();
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      const body = request.postDataJSON() as { username: string; password: string };
      // `role` and `email` mirror the real login response. A plain member, so the header's
      // admin link stays hidden in these flows.
      return json(route, 200, {
        user: {
          id: E2E_USER_ID,
          name: 'Ellie Tester',
          username: body.username,
          email: null,
          role: 'member',
          token: 'tok_e2e',
        },
      });
    }

    if (method === 'POST' && pathname === '/api/auth/register') {
      const body = request.postDataJSON() as { username: string; name: string; password: string; email?: string };
      return json(route, 201, {
        user: {
          id: E2E_USER_ID,
          name: body.name,
          username: body.username,
          email: body.email ?? null,
          role: 'member',
          token: 'tok_e2e',
        },
      });
    }

    return json(route, 404, { error: `No mock handler for ${method} ${pathname}` });
  });

  return { auctions, requests };
}
