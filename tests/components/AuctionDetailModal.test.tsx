import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuctionDetailModal } from '../../src/components/AuctionDetailModal';
import { AuctionItem, User } from '../../src/types';

vi.mock('../../src/lib/api', () => {
  const apiFetch = vi.fn();
  return {
    apiFetch,
    resolveApiUrl: (path: string) => path,
    // Mirrors the real helper in src/lib/api.ts so the assertions below observe the request
    // exactly as it goes to the network, Authorization header included, through the single
    // apiFetch spy.
    apiFetchAuthed: (input: string, token: string | null | undefined, init?: RequestInit) =>
      apiFetch(input, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }),
  };
});

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
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${bidderUser.token}`,
            },
            body: JSON.stringify({ amount: 150.01 }),
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
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${bidderUser.token}`,
            },
            body: JSON.stringify({ amount: 155 }),
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

  describe('image gallery', () => {
    const THREE_IMAGES = [
      'https://picsum.photos/seed/one/800/600',
      'https://picsum.photos/seed/two/800/600',
      'https://picsum.photos/seed/three/800/600',
    ];

    // The main image is the only one whose alt carries the "image N of M" position, so this
    // reads the gallery's actual visible state rather than a thumbnail.
    function activeImageSrc(): string {
      const img = screen.getByAltText(/image \d+ of \d+$/i) as HTMLImageElement;
      return img.src;
    }

    it('renders the counter and both nav buttons for a 3-image listing', () => {
      renderModal(makeAuction({ imageUrls: THREE_IMAGES }), bidderUser);

      expect(document.getElementById('gallery-counter')).toHaveTextContent('1 / 3');
      expect(screen.getByLabelText('Previous image')).toBeInTheDocument();
      expect(screen.getByLabelText('Next image')).toBeInTheDocument();
      expect(activeImageSrc()).toBe(THREE_IMAGES[0]);
    });

    it('advances the visible image on Next and wraps from the last back to the first', async () => {
      renderModal(makeAuction({ imageUrls: THREE_IMAGES }), bidderUser);

      const user = userEvent.setup();
      const nextBtn = document.getElementById('gallery-next-btn') as HTMLButtonElement;

      await user.click(nextBtn);
      expect(activeImageSrc()).toBe(THREE_IMAGES[1]);
      expect(document.getElementById('gallery-counter')).toHaveTextContent('2 / 3');

      await user.click(nextBtn);
      expect(activeImageSrc()).toBe(THREE_IMAGES[2]);

      // Wrap-around
      await user.click(nextBtn);
      expect(activeImageSrc()).toBe(THREE_IMAGES[0]);
      expect(document.getElementById('gallery-counter')).toHaveTextContent('1 / 3');
    });

    it('wraps backwards from the first image to the last on Previous', async () => {
      renderModal(makeAuction({ imageUrls: THREE_IMAGES }), bidderUser);

      const user = userEvent.setup();
      await user.click(document.getElementById('gallery-prev-btn') as HTMLButtonElement);

      expect(activeImageSrc()).toBe(THREE_IMAGES[2]);
      expect(document.getElementById('gallery-counter')).toHaveTextContent('3 / 3');
    });

    it('selects an image when its thumbnail is clicked', async () => {
      renderModal(makeAuction({ imageUrls: THREE_IMAGES }), bidderUser);

      const user = userEvent.setup();
      await user.click(document.getElementById('gallery-thumb-2') as HTMLButtonElement);

      expect(activeImageSrc()).toBe(THREE_IMAGES[2]);
      expect(document.getElementById('gallery-counter')).toHaveTextContent('3 / 3');
    });

    it('renders no nav buttons, counter or thumbnails for a single-image listing', () => {
      renderModal(
        makeAuction({ imageUrls: [THREE_IMAGES[0]], imageUrl: THREE_IMAGES[0] }),
        bidderUser,
      );

      expect(document.getElementById('gallery-counter')).toBeNull();
      expect(document.getElementById('gallery-prev-btn')).toBeNull();
      expect(document.getElementById('gallery-next-btn')).toBeNull();
      expect(document.getElementById('gallery-thumb-0')).toBeNull();
      expect((screen.getByAltText('Vintage Film Camera') as HTMLImageElement).src).toBe(THREE_IMAGES[0]);
    });

    it('falls back to the single imageUrl when imageUrls is absent', () => {
      renderModal(
        makeAuction({ imageUrls: undefined, imageUrl: 'https://example.test/legacy.jpg' }),
        bidderUser,
      );

      expect((screen.getByAltText('Vintage Film Camera') as HTMLImageElement).src).toBe(
        'https://example.test/legacy.jpg',
      );
      expect(document.getElementById('gallery-counter')).toBeNull();
    });

    it('ignores blank entries in imageUrls so they never render as empty frames', () => {
      renderModal(
        makeAuction({ imageUrls: [THREE_IMAGES[0], '   ', THREE_IMAGES[1]] }),
        bidderUser,
      );

      expect(document.getElementById('gallery-counter')).toHaveTextContent('1 / 2');
      expect(document.getElementById('gallery-thumb-2')).toBeNull();
    });

    // The R2 migration ships new listings with `/images/<key>` paths while existing rows -- and
    // rows mid-backfill -- may still carry a base64 `data:` URL, sometimes both in the same
    // listing. The gallery must render either form with no special-casing: an `<img src>` works
    // for both, so this only guards against code that inspects/slices the string somewhere.
    it('renders a gallery mixing a legacy data: URL and a stored /images/<key> path', () => {
      const dataUrlImage = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMC';
      const r2PathImage = '/images/img_2f9c8a1b';

      renderModal(
        makeAuction({ imageUrls: [dataUrlImage, r2PathImage] }),
        bidderUser,
      );

      expect(document.getElementById('gallery-counter')).toHaveTextContent('1 / 2');

      const mainImage = screen.getByAltText(/Vintage Film Camera - image 1 of 2/i) as HTMLImageElement;
      expect(mainImage.src).toBe(dataUrlImage);

      const thumb1 = document.getElementById('gallery-thumb-1') as HTMLButtonElement;
      expect(thumb1).toBeInTheDocument();
      fireEvent.click(thumb1);

      const secondImage = screen.getByAltText(/Vintage Film Camera - image 2 of 2/i) as HTMLImageElement;
      // jsdom resolves a relative src against the test's base URL, so check the suffix rather
      // than the full absolute URL.
      expect(secondImage.src.endsWith(r2PathImage)).toBe(true);
    });
  });

  describe('WhatsApp contact button', () => {
    it('links to wa.me with the digits of a formatted international number', () => {
      const auction = makeAuction({ phoneNumber: '+60 12-345 6789' });
      renderModal(auction, bidderUser);

      const link = document.getElementById('contact-whatsapp-btn') as HTMLAnchorElement;
      expect(link).toBeInTheDocument();
      // Read the attribute rather than the .href property: the DOM getter normalises the URL
      // and re-encodes the apostrophe in the prefilled message as %27.
      expect(link.getAttribute('href')).toBe(
        `https://wa.me/60123456789?text=${encodeURIComponent(
          `Hi ${auction.sellerName}, I'm interested in your "${auction.title}" listing on MSA Auction.`,
        )}`,
      );
      expect(link.getAttribute('href')).toContain('https://wa.me/60123456789');
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
    });

    it('is not rendered when the seller number is too short to be dialable', () => {
      renderModal(makeAuction({ phoneNumber: '12345' }), bidderUser);

      expect(document.getElementById('contact-whatsapp-btn')).toBeNull();
      // The plain tel: badge is unaffected
      expect(screen.getByText('12345')).toBeInTheDocument();
    });
  });

  describe('report control', () => {
    it('is offered to a signed-in user who is not the seller', async () => {
      renderModal(makeAuction(), bidderUser);

      const reportBtn = screen.getByRole('button', { name: /report the listing/i });
      await userEvent.setup().click(reportBtn);

      expect(await screen.findByRole('dialog', { name: /report this listing/i })).toBeInTheDocument();
    });

    it('is not offered to the seller, who has Cancel instead', () => {
      const auction = makeAuction();
      renderModal(auction, { ...bidderUser, id: auction.sellerId });

      expect(document.getElementById('report-listing-btn')).toBeNull();
    });

    it('is not offered to a signed-out visitor', () => {
      // The server needs a reporter id, and an anonymous report queue is a spam queue -- so
      // this is left out entirely rather than bounced through a sign-in prompt.
      renderModal(makeAuction(), null);

      expect(document.getElementById('report-listing-btn')).toBeNull();
    });

    it('stays available on a concluded listing', () => {
      // A scam is often only recognised after the fact, and the committee still wants to know
      // about the account behind it.
      renderModal(makeAuction({ status: 'ended', endTime: NOW - 60 * 1000 }), bidderUser);

      expect(document.getElementById('report-listing-btn')).toBeInTheDocument();
    });
  });
});
