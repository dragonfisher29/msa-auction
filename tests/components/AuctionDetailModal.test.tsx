import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuctionDetailModal } from '../../src/components/AuctionDetailModal';
import { AuctionItem, User } from '../../src/types';

vi.mock('../../src/lib/api', () => ({
  apiFetch: vi.fn(),
  resolveApiUrl: (path: string) => path,
}));

vi.mock('../../src/lib/realtime', () => ({
  startPolling: vi.fn(() => () => {}),
  checkHealth: vi.fn(async () => true),
}));

import { apiFetch } from '../../src/lib/api';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const NOW = Date.now();

function makeAuction(overrides: Partial<AuctionItem> = {}): AuctionItem {
  return {
    id: 'auc_1',
    title: 'Vintage Film Camera',
    description: 'A well-loved vintage film camera, fully functional.',
    phoneNumber: '+44 7700 900000',
    startingPrice: 100,
    currentPrice: 150,
    sellerId: 'seller_1',
    sellerName: 'Sam Seller',
    highestBidderId: 'bidder_1',
    highestBidderName: 'Bea Bidder',
    durationMinutes: 60,
    startTime: NOW - 5 * 60 * 1000,
    endTime: NOW + 60 * 60 * 1000,
    status: 'active',
    category: 'Collectibles',
    imageUrl: 'https://picsum.photos/seed/camera/800/600',
    imageUrls: ['https://picsum.photos/seed/camera/800/600'],
    bids: [
      {
        id: 'bid_1',
        auctionId: 'auc_1',
        userId: 'bidder_1',
        userName: 'Bea Bidder',
        amount: 150,
        timestamp: NOW - 60 * 1000,
      },
    ],
    winnerId: null,
    winnerName: null,
    winningBid: null,
    createdAt: NOW - 10 * 60 * 1000,
    ...overrides,
  };
}

const bidderUser: User = {
  id: 'bidder_2',
  name: 'Alex Bidder',
  username: 'alex_bidder',
  token: 'tok_abc',
  createdAt: NOW - 20 * 60 * 1000,
};

function renderModal(auction: AuctionItem, user: User | null) {
  const onClose = vi.fn();
  const onPromptAuth = vi.fn();
  const onAuctionUpdated = vi.fn();

  render(
    <AuctionDetailModal
      auction={auction}
      user={user}
      onClose={onClose}
      onPromptAuth={onPromptAuth}
      onAuctionUpdated={onAuctionUpdated}
    />,
  );

  return { onClose, onPromptAuth, onAuctionUpdated };
}

describe('AuctionDetailModal', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  describe('client-side bid validation', () => {
    it('rejects a bid below the current price and makes no network request', async () => {
      const auction = makeAuction();
      renderModal(auction, bidderUser);

      const amountInput = document.getElementById('place-bid-amount-input') as HTMLInputElement;
      const form = amountInput.closest('form') as HTMLFormElement;

      const user = userEvent.setup();
      await user.clear(amountInput);
      await user.type(amountInput, '120');
      // The input carries a native `min` attribute equal to the true enforced minimum
      // (currentPrice + 0.01), so a real button click would be blocked by the browser's own
      // constraint validation before React ever sees the submit. Dispatching `submit` directly
      // exercises the app's own (lower) client-side check instead.
      fireEvent.submit(form);

      expect(await screen.findByText(/Bid must be strictly higher than current bid of £150/i)).toBeInTheDocument();
      expect(mockedApiFetch).not.toHaveBeenCalled();
    });

    it('accepts a bid of exactly currentPrice + 0.01 and reaches the network', async () => {
      const auction = makeAuction();

      mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === `/api/auctions/${auction.id}/bids` && init?.method === 'POST') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              bid: {
                id: 'bid_new',
                auctionId: auction.id,
                userId: bidderUser.id,
                userName: bidderUser.name,
                amount: 150.01,
                timestamp: NOW,
              },
            }),
          } as Response;
        }
        if (url === `/api/auctions/${auction.id}`) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ auction }),
          } as Response;
        }
        throw new Error(`Unexpected apiFetch call: ${url}`);
      });

      renderModal(auction, bidderUser);

      const amountInput = document.getElementById('place-bid-amount-input') as HTMLInputElement;
      const form = amountInput.closest('form') as HTMLFormElement;

      const user = userEvent.setup();
      await user.clear(amountInput);
      await user.type(amountInput, '150.01');
      fireEvent.submit(form);

      await waitFor(() => {
        expect(mockedApiFetch).toHaveBeenNthCalledWith(
          1,
          `/api/auctions/${auction.id}/bids`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: bidderUser.id,
              userName: bidderUser.name,
              amount: 150.01,
            }),
          },
        );
      });

      expect(screen.queryByText(/Bid must be strictly higher than current bid/i)).not.toBeInTheDocument();
    });

    it('blocks the seller from bidding on their own listing', async () => {
      const auction = makeAuction();
      const sellerUser: User = {
        id: auction.sellerId,
        name: auction.sellerName,
        username: 'sam_seller',
        token: 'tok_seller',
        createdAt: NOW - 30 * 60 * 1000,
      };

      renderModal(auction, sellerUser);

      expect(
        screen.getByText(/You are the seller of this listing and cannot bid on it\./i),
      ).toBeInTheDocument();
      expect(document.getElementById('place-bid-amount-input')).toBeNull();
      expect(mockedApiFetch).not.toHaveBeenCalled();
    });

    it('blocks bidding on an ended auction', async () => {
      const auction = makeAuction({
        status: 'ended',
        endTime: NOW - 60 * 1000,
        winnerId: 'bidder_1',
        winnerName: 'Bea Bidder',
        winningBid: 150,
      });

      renderModal(auction, bidderUser);

      expect(screen.getByText(/Bidding is closed for this auction item\./i)).toBeInTheDocument();
      expect(document.getElementById('place-bid-amount-input')).toBeNull();
      expect(mockedApiFetch).not.toHaveBeenCalled();
    });
  });

  describe('placing a bid via the REST API', () => {
    it('POSTs to /api/auctions/:id/bids with the right body, re-fetches, and shows a success message', async () => {
      const auction = makeAuction();
      const freshAuction = makeAuction({
        currentPrice: 155,
        highestBidderId: bidderUser.id,
        highestBidderName: bidderUser.name,
        bids: [
          {
            id: 'bid_2',
            auctionId: auction.id,
            userId: bidderUser.id,
            userName: bidderUser.name,
            amount: 155,
            timestamp: NOW,
          },
          ...auction.bids,
        ],
      });

      mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === `/api/auctions/${auction.id}/bids` && init?.method === 'POST') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ bid: freshAuction.bids[0] }),
          } as Response;
        }
        if (url === `/api/auctions/${auction.id}`) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ auction: freshAuction }),
          } as Response;
        }
        throw new Error(`Unexpected apiFetch call: ${url}`);
      });

      const { onAuctionUpdated } = renderModal(auction, bidderUser);

      const submitBtn = document.getElementById('place-bid-submit-btn') as HTMLButtonElement;
      const user = userEvent.setup();
      await user.click(submitBtn);

      await waitFor(() => {
        expect(mockedApiFetch).toHaveBeenNthCalledWith(
          1,
          `/api/auctions/${auction.id}/bids`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: bidderUser.id,
              userName: bidderUser.name,
              amount: 155,
            }),
          },
        );
      });

      expect(mockedApiFetch).toHaveBeenNthCalledWith(2, `/api/auctions/${auction.id}`);

      expect(await screen.findByText(/Placed bid of £155!/i)).toBeInTheDocument();
      expect(onAuctionUpdated).toHaveBeenCalledWith(freshAuction);
    });

    it('renders the server error string from a 400 response and shows no success message', async () => {
      const auction = makeAuction();

      mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === `/api/auctions/${auction.id}/bids` && init?.method === 'POST') {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: 'Bid must be strictly higher than current bid of £150.' }),
          } as Response;
        }
        throw new Error(`Unexpected apiFetch call: ${url}`);
      });

      renderModal(auction, bidderUser);

      const submitBtn = document.getElementById('place-bid-submit-btn') as HTMLButtonElement;
      const user = userEvent.setup();
      await user.click(submitBtn);

      expect(await screen.findByText('Bid must be strictly higher than current bid of £150.')).toBeInTheDocument();
      expect(screen.queryByText(/Placed bid of/i)).not.toBeInTheDocument();
      expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    });

    it('strips a trailing " [Code: ...]" suffix from the server error before rendering it', async () => {
      const auction = makeAuction();

      mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === `/api/auctions/${auction.id}/bids` && init?.method === 'POST') {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: 'This auction has already ended. [Code: AUCTION_ENDED]' }),
          } as Response;
        }
        throw new Error(`Unexpected apiFetch call: ${url}`);
      });

      renderModal(auction, bidderUser);

      const submitBtn = document.getElementById('place-bid-submit-btn') as HTMLButtonElement;
      const user = userEvent.setup();
      await user.click(submitBtn);

      expect(await screen.findByText('This auction has already ended.')).toBeInTheDocument();
      expect(screen.queryByText(/Code: AUCTION_ENDED/)).not.toBeInTheDocument();
    });
  });
});
