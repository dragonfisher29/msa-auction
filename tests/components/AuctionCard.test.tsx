import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuctionCard } from '../../src/components/AuctionCard';
import { __resetImageCacheForTests } from '../../src/lib/images';
import { AuctionItem } from '../../src/types';

vi.mock('../../src/lib/api', () => ({
  apiFetch: vi.fn(),
  resolveApiUrl: (path: string) => path,
  apiFetchAuthed: vi.fn(),
}));

import { apiFetch } from '../../src/lib/api';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function makeListRowAuction(overrides: Partial<AuctionItem> = {}): AuctionItem {
  // Shaped like a row from the paginated `GET /api/auctions` list endpoint: no `imageUrl` /
  // `imageUrls` at all, only `imageCount`.
  return {
    id: 'auc_1',
    title: 'Vintage Film Camera',
    description: 'A well-loved vintage film camera, fully functional.',
    price: 150,
    sellerId: 'seller_1',
    sellerName: 'Sam Seller',
    status: 'active',
    expiresAt: NOW + 20 * DAY,
    soldAt: null,
    category: 'Collectibles',
    imageCount: 2,
    createdAt: NOW - 10 * 60 * 1000,
    ...overrides,
  };
}

describe('AuctionCard image loading', () => {
  beforeEach(() => {
    __resetImageCacheForTests();
    mockedApiFetch.mockReset();
  });

  afterEach(() => {
    __resetImageCacheForTests();
  });

  it('fetches GET /api/auctions/:id/images exactly once even when re-rendered with a new auction object', async () => {
    mockedApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/auctions/auc_1/images') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ imageUrls: ['https://example.test/one.jpg', 'https://example.test/two.jpg'] }),
        } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    const auction = makeListRowAuction();
    const { rerender } = render(<AuctionCard auction={auction} onSelect={() => {}} />);

    await waitFor(() => {
      const img = screen.getByAltText(auction.title) as HTMLImageElement;
      expect(img.src).toBe('https://example.test/one.jpg');
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);

    // Simulate the feed refresh: App.tsx hands every card a brand-new listing object each time.
    // A card that re-fetched on every prop change would double (or keep growing) the request
    // count here; the point of the change is that it doesn't.
    const polledAuction = { ...auction, price: 999 };
    rerender(<AuctionCard auction={polledAuction} onSelect={() => {}} />);
    rerender(<AuctionCard auction={{ ...polledAuction }} onSelect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('£999')).toBeInTheDocument();
    });
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
  });

  it('reserves the image slot from imageCount without fetching, and shows a "no photos" placeholder when it is 0', () => {
    const auction = makeListRowAuction({ imageCount: 0 });
    render(<AuctionCard auction={auction} onSelect={() => {}} />);

    expect(screen.getByText('No photos')).toBeInTheDocument();
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('shows the multi-image count badge from imageCount immediately, before the fetch resolves', () => {
    mockedApiFetch.mockImplementation(() => new Promise(() => {})); // never resolves
    const auction = makeListRowAuction({ imageCount: 3 });
    render(<AuctionCard auction={auction} onSelect={() => {}} />);

    expect(document.getElementById(`auction-card-image-count-${auction.id}`)).toHaveTextContent('3');
  });

  it('uses inline imageUrls directly (no fetch) when the full object already has them', () => {
    const auction = makeListRowAuction({
      imageCount: undefined,
      imageUrls: ['https://example.test/full-object.jpg'],
    });
    render(<AuctionCard auction={auction} onSelect={() => {}} />);

    const img = screen.getByAltText(auction.title) as HTMLImageElement;
    expect(img.src).toBe('https://example.test/full-object.jpg');
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('renders the first image when inline imageUrls mixes a legacy data: URL and a stored /images/<key> path', () => {
    // The R2 migration means a listing mid-backfill can hold both forms at once; the card must
    // not special-case either -- just take the first entry and hand it to <img src>.
    const dataUrlImage = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMC';
    const r2PathImage = '/images/img_2f9c8a1b';

    const auction = makeListRowAuction({
      imageCount: undefined,
      imageUrls: [dataUrlImage, r2PathImage],
    });
    render(<AuctionCard auction={auction} onSelect={() => {}} />);

    const img = screen.getByAltText(auction.title) as HTMLImageElement;
    expect(img.src).toBe(dataUrlImage);
    expect(document.getElementById(`auction-card-image-count-${auction.id}`)).toHaveTextContent('2');
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('adds loading="lazy" and decoding="async" to the rendered image', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ imageUrls: ['https://example.test/one.jpg'] }),
    } as Response);

    const auction = makeListRowAuction();
    render(<AuctionCard auction={auction} onSelect={() => {}} />);

    const img = await screen.findByAltText(auction.title) as HTMLImageElement;
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
  });
});

describe('AuctionCard listing details', () => {
  beforeEach(() => {
    __resetImageCacheForTests();
    mockedApiFetch.mockReset();
  });

  it('shows the price (with pence when it has them), category, seller and listing age', () => {
    render(
      <AuctionCard
        auction={makeListRowAuction({ imageCount: 0, price: 12.5, createdAt: NOW - 3 * DAY - 60 * 1000 })}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByTestId('listing-price-auc_1')).toHaveTextContent('£12.50');
    expect(screen.getByText('Collectibles')).toBeInTheDocument();
    expect(screen.getByText('Sam Seller')).toBeInTheDocument();
    expect(screen.getByText('Listed 3 days ago')).toBeInTheDocument();
  });

  it('shows no status badge on an active listing, and no bidding language anywhere', () => {
    render(<AuctionCard auction={makeListRowAuction({ imageCount: 0 })} onSelect={() => {}} />);

    expect(screen.queryByTestId('listing-status-badge-auc_1')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bbids?\b|bidder|auction ended|ending soon/i);
  });

  it('badges a sold listing as Sold', () => {
    render(<AuctionCard auction={makeListRowAuction({ imageCount: 0, status: 'sold', soldAt: NOW })} onSelect={() => {}} />);
    expect(screen.getByTestId('listing-status-badge-auc_1')).toHaveTextContent('Sold');
  });

  it('badges an expired listing as Expired -- including one the server still calls active but whose expiresAt has passed', () => {
    const { rerender } = render(
      <AuctionCard auction={makeListRowAuction({ imageCount: 0, status: 'expired' })} onSelect={() => {}} />,
    );
    expect(screen.getByTestId('listing-status-badge-auc_1')).toHaveTextContent('Expired');

    rerender(<AuctionCard auction={makeListRowAuction({ imageCount: 0, expiresAt: NOW - 1000 })} onSelect={() => {}} />);
    expect(screen.getByTestId('listing-status-badge-auc_1')).toHaveTextContent('Expired');
  });

  it('never points the placeholder at a third-party image host', async () => {
    // A listing that says it has photos but whose image fetch comes back empty.
    mockedApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ imageUrls: [] }) } as Response);
    render(<AuctionCard auction={makeListRowAuction({ imageCount: 1 })} onSelect={() => {}} />);

    const img = (await screen.findByAltText('Vintage Film Camera')) as HTMLImageElement;
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(img.getAttribute('src')).not.toMatch(/unsplash/i);
  });
});
