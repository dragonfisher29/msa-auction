import type { Page, Route } from '@playwright/test';
import { demoAuctions } from './auctions';
import type { AuctionItem, Bid } from '../../../src/types';

export interface BidOverride {
  status: number;
  body: unknown;
}

export interface MockApiOptions {
  /** Force a specific status/body for the next bid POST against this auction id. */
  bidOverrideByAuctionId?: Record<string, BidOverride>;
}

const DEFAULT_PAGE_LIMIT = 24;

/**
 * Strips the two image fields off a full `AuctionItem` and replaces them with `imageCount`,
 * matching what `GET /api/auctions` (the paginated list endpoint) actually returns in
 * production: no image data of any kind on a list row, by design, to keep the page payload
 * light. `GET /api/auctions/:id` (single item) and `GET /api/auctions/:id/images` are the only
 * two endpoints that still carry real image URLs.
 */
function toListRow(auction: AuctionItem): Omit<AuctionItem, 'imageUrl' | 'imageUrls'> & { imageCount: number } {
  const { imageUrl, imageUrls, ...rest } = auction;
  const count = Array.isArray(imageUrls)
    ? imageUrls.filter((url) => typeof url === 'string' && url.trim() !== '').length
    : imageUrl
    ? 1
    : 0;
  return { ...rest, imageCount: count };
}

/** Mirrors the real ordering: `end_time DESC, id DESC`, so ended listings sort to the tail. */
function sortForListing(items: AuctionItem[]): AuctionItem[] {
  return [...items].sort((a, b) => {
    if (a.endTime !== b.endTime) {
      return b.endTime - a.endTime;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * Intercepts every `**\/api/**` request the app makes and serves fixture data instead,
 * so tests never touch Supabase or the deployed Cloudflare Worker.
 */
export async function mockApi(page: Page, options: MockApiOptions = {}) {
  const auctions: AuctionItem[] = demoAuctions.map((auction) => ({
    ...auction,
    bids: [...auction.bids],
  }));

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;

    if (method === 'GET' && pathname === '/api/health') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          serverTime: Date.now(),
          activeAuctions: auctions.filter((a) => a.status === 'active').length,
        }),
      });
    }

    if (method === 'GET' && pathname === '/api/auctions') {
      const url = new URL(request.url());
      const limitParam = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 60) : DEFAULT_PAGE_LIMIT;
      const cursor = url.searchParams.get('cursor');

      const ordered = sortForListing(auctions);
      let startIndex = 0;
      if (cursor) {
        startIndex = ordered.findIndex((a) => a.id === cursor) + 1;
        if (startIndex === 0) {
          // findIndex returned -1: the cursor doesn't match any known row.
          return route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Invalid cursor. [Code: INVALID_CURSOR]', code: 'INVALID_CURSOR' }),
          });
        }
      }

      const pageItems = ordered.slice(startIndex, startIndex + limit);
      const nextCursor = startIndex + limit < ordered.length ? pageItems[pageItems.length - 1]?.id ?? null : null;

      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ auctions: pageItems.map(toListRow), nextCursor }),
      });
    }

    const imagesMatch = pathname.match(/^\/api\/auctions\/([^/]+)\/images$/);
    if (method === 'GET' && imagesMatch) {
      const auction = auctions.find((a) => a.id === imagesMatch[1]);
      if (!auction) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Auction not found' }),
        });
      }
      const imageUrls = Array.isArray(auction.imageUrls)
        ? auction.imageUrls
        : auction.imageUrl
        ? [auction.imageUrl]
        : [];
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ imageUrls }),
      });
    }

    const editMatch = pathname.match(/^\/api\/auctions\/([^/]+)$/);
    if (method === 'PATCH' && editMatch) {
      const auction = auctions.find((a) => a.id === editMatch[1]);
      if (!auction) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Auction not found' }) });
      }
      if (auction.status !== 'active') {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Listing is not editable. [Code: LISTING_NOT_EDITABLE]', code: 'LISTING_NOT_EDITABLE' }),
        });
      }
      if (auction.bids.length > 0) {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'This listing already has bids and can no longer be edited. You can cancel it instead. [Code: LISTING_HAS_BIDS]',
            code: 'LISTING_HAS_BIDS',
          }),
        });
      }
      const body = request.postDataJSON() as Partial<AuctionItem>;
      Object.assign(auction, {
        title: body.title ?? auction.title,
        description: body.description ?? auction.description,
        phoneNumber: body.phoneNumber ?? auction.phoneNumber,
        category: body.category ?? auction.category,
        imageUrls: body.imageUrls ?? auction.imageUrls,
        startingPrice: body.startingPrice ?? auction.startingPrice,
      });
      if (body.startingPrice !== undefined) {
        auction.currentPrice = body.startingPrice;
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ auction }) });
    }

    if (method === 'DELETE' && editMatch) {
      const auction = auctions.find((a) => a.id === editMatch[1]);
      if (!auction) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Auction not found' }) });
      }
      if (auction.status !== 'active') {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Listing is not editable. [Code: LISTING_NOT_EDITABLE]', code: 'LISTING_NOT_EDITABLE' }),
        });
      }
      auction.status = 'cancelled';
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ auction }) });
    }

    const bidMatch = pathname.match(/^\/api\/auctions\/([^/]+)\/bids$/);
    if (method === 'POST' && bidMatch) {
      const auctionId = bidMatch[1];
      const override = options.bidOverrideByAuctionId?.[auctionId];
      if (override) {
        return route.fulfill({
          status: override.status,
          contentType: 'application/json',
          body: JSON.stringify(override.body),
        });
      }

      const auction = auctions.find((a) => a.id === auctionId);
      if (!auction) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Auction not found' }),
        });
      }

      const payload = request.postDataJSON() as { userId: string; userName: string; amount: number };
      const newBid: Bid = {
        id: `bid_e2e_${Date.now()}`,
        auctionId,
        userId: payload.userId,
        userName: payload.userName,
        amount: payload.amount,
        timestamp: Date.now(),
      };
      auction.bids = [newBid, ...auction.bids];
      auction.currentPrice = payload.amount;
      auction.highestBidderId = payload.userId;
      auction.highestBidderName = payload.userName;

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ bid: newBid }),
      });
    }

    if (method === 'GET' && editMatch) {
      const auction = auctions.find((a) => a.id === editMatch[1]);
      if (!auction) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Auction not found' }),
        });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ auction }),
      });
    }

    if (method === 'POST' && pathname === '/api/auctions') {
      const body = request.postDataJSON() as Record<string, any>;
      const now = Date.now();
      const created: AuctionItem = {
        id: `auc_e2e_${now}`,
        title: body.title,
        description: body.description,
        phoneNumber: body.phoneNumber,
        startingPrice: body.startingPrice,
        currentPrice: body.startingPrice,
        sellerId: body.sellerId,
        sellerName: body.sellerName,
        highestBidderId: null,
        highestBidderName: null,
        durationMinutes: body.durationMinutes,
        startTime: now,
        endTime: now + body.durationMinutes * 60 * 1000,
        status: 'active',
        category: body.category,
        imageUrl: body.imageUrl,
        imageUrls: body.imageUrls,
        bids: [],
        winnerId: null,
        winnerName: null,
        winningBid: null,
        createdAt: now,
      };
      auctions.unshift(created);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ auction: created }),
      });
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      const body = request.postDataJSON() as { username: string; password: string };
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          // `role` and `email` mirror the real login response. A plain member, so the header's
          // admin link stays hidden in these flows.
          user: {
            id: 'usr_e2e_tester',
            name: 'Ellie Tester',
            username: body.username,
            email: null,
            role: 'member',
            token: 'tok_e2e',
          },
        }),
      });
    }

    if (method === 'POST' && pathname === '/api/auth/register') {
      const body = request.postDataJSON() as {
        username: string;
        name: string;
        password: string;
        email?: string;
      };
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'usr_e2e_tester',
            name: body.name,
            username: body.username,
            email: body.email ?? null,
            role: 'member',
            token: 'tok_e2e',
          },
        }),
      });
    }

    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `No mock handler for ${method} ${pathname}` }),
    });
  });

  return { auctions };
}
