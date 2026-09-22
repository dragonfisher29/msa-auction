import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../src/App';
import { AuctionItem, User } from '../../src/types';

vi.mock('../../src/lib/api', () => ({
  apiFetch: vi.fn(),
  resolveApiUrl: (path: string) => path,
  apiFetchAuthed: vi.fn(),
}));

vi.mock('../../src/lib/realtime', () => ({
  startPolling: vi.fn(() => () => {}),
  checkHealth: vi.fn(async () => true),
}));

import { apiFetch, apiFetchAuthed } from '../../src/lib/api';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedApiFetchAuthed = apiFetchAuthed as unknown as ReturnType<typeof vi.fn>;

const STORAGE_KEY = 'msa_auction_user';

const storedUser: User = {
  id: 'user_1',
  name: 'Alex Bidder',
  username: 'alex_bidder',
  token: 'tok_abc',
  createdAt: Date.now() - 60 * 60 * 1000,
};

function mockAuctionsFeed() {
  mockedApiFetch.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ auctions: [] }),
  } as Response));
}

describe('App session bootstrap', () => {
  beforeEach(() => {
    localStorage.clear();
    mockedApiFetch.mockReset();
    mockedApiFetchAuthed.mockReset();
    mockAuctionsFeed();
  });

  it('signs the user out when GET /api/auth/me returns 401', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(storedUser));
    mockedApiFetchAuthed.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);

    render(<App />);

    // Optimistically shown first, then dropped once the 401 comes back.
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument());
    expect(screen.queryByText(storedUser.name)).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('keeps the session when the request fails for network reasons', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(storedUser));
    mockedApiFetchAuthed.mockRejectedValue(new Error('network blip'));

    render(<App />);

    expect(await screen.findByText(storedUser.name)).toBeInTheDocument();
    await waitFor(() => expect(mockedApiFetchAuthed).toHaveBeenCalledWith('/api/auth/me', storedUser.token));
    expect(screen.getByText(storedUser.name)).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('drops a stored session that has no token at all, without calling the server', async () => {
    const { token, ...untokened } = storedUser;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(untokened));

    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument());
    expect(mockedApiFetchAuthed).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('App routing', () => {
  const NOW = Date.now();

  function makeAuction(overrides: Partial<AuctionItem> = {}): AuctionItem {
    return {
      id: 'auc_1',
      title: 'Vintage Film Camera',
      description: 'A well-loved vintage film camera.',
      phoneNumber: '+44 7700 900000',
      startingPrice: 100,
      currentPrice: 100,
      sellerId: 'seller_1',
      sellerName: 'Sam Seller',
      highestBidderId: null,
      highestBidderName: null,
      durationMinutes: 60,
      startTime: NOW - 5 * 60 * 1000,
      endTime: NOW + 60 * 60 * 1000,
      status: 'active',
      category: 'Collectibles',
      imageCount: 0,
      bids: [],
      winnerId: null,
      winnerName: null,
      winningBid: null,
      createdAt: NOW - 10 * 60 * 1000,
      ...overrides,
    };
  }

  beforeEach(() => {
    localStorage.clear();
    mockedApiFetch.mockReset();
    mockedApiFetchAuthed.mockReset();
    mockedApiFetchAuthed.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('opens the right auction for a deep link to /auction/:id when it is not on the loaded page', async () => {
    const onPage = makeAuction({ id: 'auc_on_page', title: 'On The Grid' });
    const deepLinked = makeAuction({ id: 'auc_deep_link', title: 'Only Reachable By Link' });

    mockedApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/auctions?limit=24') {
        return { ok: true, status: 200, json: async () => ({ auctions: [onPage], nextCursor: null }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    // The deep-link lookup goes through apiFetchAuthed now (so a signed-in visitor gets
    // phoneNumber back immediately - see the comment in App.tsx), not the plain apiFetch above.
    mockedApiFetchAuthed.mockImplementation(async (url: string) => {
      if (url === `/api/auctions/${deepLinked.id}`) {
        return { ok: true, status: 200, json: async () => ({ auction: deepLinked }) } as Response;
      }
      throw new Error(`Unexpected apiFetchAuthed call: ${url}`);
    });

    window.history.pushState({}, '', `/auction/${deepLinked.id}`);
    render(<App />);

    expect(await screen.findByText('Only Reachable By Link')).toBeInTheDocument();
    expect(document.getElementById('close-auction-detail-btn')).toBeInTheDocument();
  });

  it('closes the auction detail modal on the browser back button', async () => {
    const auction = makeAuction();
    mockedApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/auctions?limit=24') {
        return { ok: true, status: 200, json: async () => ({ auctions: [auction], nextCursor: null }) } as Response;
      }
      if (url === `/api/auctions/${auction.id}`) {
        return { ok: true, status: 200, json: async () => ({ auction }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(<App />);

    const viewBtn = await screen.findByRole('button', { name: /view & place bid/i });
    const user = userEvent.setup();
    await user.click(viewBtn);

    await waitFor(() => expect(document.getElementById('close-auction-detail-btn')).toBeInTheDocument());

    window.history.back();

    await waitFor(() => expect(document.getElementById('close-auction-detail-btn')).not.toBeInTheDocument());
  });

  it('appends a "load more" page onto the grid instead of replacing it', async () => {
    const page1 = [makeAuction({ id: 'auc_1', title: 'First Page Item' })];
    const page2 = [makeAuction({ id: 'auc_2', title: 'Second Page Item' })];

    mockedApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/auctions?limit=24') {
        return { ok: true, status: 200, json: async () => ({ auctions: page1, nextCursor: 'cursor_1' }) } as Response;
      }
      if (url === '/api/auctions?limit=24&cursor=cursor_1') {
        return { ok: true, status: 200, json: async () => ({ auctions: page2, nextCursor: null }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(<App />);

    expect(await screen.findByText('First Page Item')).toBeInTheDocument();
    const loadMoreBtn = screen.getByRole('button', { name: /load more auctions/i });

    const user = userEvent.setup();
    await user.click(loadMoreBtn);

    expect(await screen.findByText('Second Page Item')).toBeInTheDocument();
    // First page's item is still there -- appended, not replaced.
    expect(screen.getByText('First Page Item')).toBeInTheDocument();
    // No further page: the button goes away.
    await waitFor(() => expect(screen.queryByRole('button', { name: /load more auctions/i })).not.toBeInTheDocument());
  });
});
