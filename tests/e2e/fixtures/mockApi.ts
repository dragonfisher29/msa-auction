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
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ auctions }),
      });
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

    const singleMatch = pathname.match(/^\/api\/auctions\/([^/]+)$/);
    if (method === 'GET' && singleMatch) {
      const auction = auctions.find((a) => a.id === singleMatch[1]);
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
          user: { id: 'usr_e2e_tester', name: 'Ellie Tester', username: body.username, token: 'tok_e2e' },
        }),
      });
    }

    if (method === 'POST' && pathname === '/api/auth/register') {
      const body = request.postDataJSON() as { username: string; name: string; password: string };
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_e2e_tester', name: body.name, username: body.username, token: 'tok_e2e' },
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
