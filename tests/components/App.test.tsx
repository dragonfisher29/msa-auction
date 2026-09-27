import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
}));

import { apiFetch, apiFetchAuthed } from '../../src/lib/api';
import { startPolling } from '../../src/lib/realtime';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedApiFetchAuthed = apiFetchAuthed as unknown as ReturnType<typeof vi.fn>;
const mockedStartPolling = startPolling as unknown as ReturnType<typeof vi.fn>;

const STORAGE_KEY = 'msa_auction_user';

const storedUser: User = {
  id: 'user_1',
  name: 'Alex Member',
  username: 'alex_member',
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

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function makeAuction(overrides: Partial<AuctionItem> = {}): AuctionItem {
  return {
    id: 'auc_1',
    title: 'Vintage Film Camera',
    description: 'A well-loved vintage film camera.',
    price: 100,
    sellerId: 'seller_1',
    sellerName: 'Sam Seller',
    status: 'active',
    expiresAt: NOW + 20 * DAY,
    soldAt: null,
    category: 'Collectibles',
    imageCount: 0,
    createdAt: NOW - 10 * DAY,
    ...overrides,
  };
}

function feedOf(auctions: AuctionItem[], nextCursor: string | null = null) {
  mockedApiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/auctions?limit=24') {
      return { ok: true, status: 200, json: async () => ({ auctions, nextCursor }) } as Response;
    }
    throw new Error(`Unexpected apiFetch call: ${url}`);
  });
}

function gridTitles(): string[] {
  return Array.from(document.querySelectorAll('[id^="auction-card-"] h3')).map((el) => el.textContent ?? '');
}

describe('App routing', () => {
  beforeEach(() => {
    localStorage.clear();
    mockedApiFetch.mockReset();
    mockedApiFetchAuthed.mockReset();
    mockedApiFetchAuthed.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('opens the right listing for a deep link to /auction/:id when it is not on the loaded page', async () => {
    const onPage = makeAuction({ id: 'auc_on_page', title: 'On The Grid' });
    const deepLinked = makeAuction({ id: 'auc_deep_link', title: 'Only Reachable By Link' });
    feedOf([onPage]);

    // The deep-link lookup goes through apiFetchAuthed (so a signed-in visitor gets
    // phoneNumber back immediately - see the comment in App.tsx), not the plain apiFetch above.
    mockedApiFetchAuthed.mockImplementation(async (url: string) => {
      if (url === `/api/auctions/${deepLinked.id}`) {
        return { ok: true, status: 200, json: async () => ({ auction: deepLinked }) } as Response;
      }
      throw new Error(`Unexpected apiFetchAuthed call: ${url}`);
    });

    window.history.pushState({}, '', `/auction/${deepLinked.id}`);
    render(<App />);

    expect(await screen.findByRole('dialog', { name: 'Only Reachable By Link' })).toBeInTheDocument();
    expect(document.getElementById('close-auction-detail-btn')).toBeInTheDocument();
  });

  it('shows "This listing is no longer available" for a deep link to a missing or hidden listing', async () => {
    feedOf([makeAuction({ id: 'auc_on_page', title: 'On The Grid' })]);
    mockedApiFetchAuthed.mockImplementation(async (url: string) => {
      if (url === '/api/auctions/auc_gone') {
        return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as Response;
      }
      throw new Error(`Unexpected apiFetchAuthed call: ${url}`);
    });

    window.history.pushState({}, '', '/auction/auc_gone');
    render(<App />);

    const notice = await screen.findByRole('dialog', { name: /this listing is no longer available/i });
    expect(notice).toBeInTheDocument();

    // One obvious way on: back to the browse page, with the notice gone.
    const user = userEvent.setup();
    await user.click(within(notice).getByRole('button', { name: /browse listings/i }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(screen.queryByRole('dialog', { name: /no longer available/i })).toBeNull();
    expect(screen.getByText('On The Grid')).toBeInTheDocument();
  });

  it('says it could not load (not "gone") when the deep-link lookup itself fails', async () => {
    feedOf([]);
    mockedApiFetchAuthed.mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    window.history.pushState({}, '', '/auction/auc_whatever');
    render(<App />);

    expect(await screen.findByRole('dialog', { name: /couldn't load this listing/i })).toBeInTheDocument();
  });

  it('closes the listing detail modal on the browser back button', async () => {
    feedOf([makeAuction()]);

    render(<App />);

    const viewBtn = await screen.findByRole('button', { name: /view details for vintage film camera/i });
    const user = userEvent.setup();
    await user.click(viewBtn);

    await waitFor(() => expect(document.getElementById('close-auction-detail-btn')).toBeInTheDocument());

    window.history.back();

    await waitFor(() => expect(document.getElementById('close-auction-detail-btn')).not.toBeInTheDocument());
  });

  it('appends a "load more" page onto the grid instead of replacing it', async () => {
    const page1 = [makeAuction({ id: 'auc_1', title: 'First Page Item' })];
    const page2 = [makeAuction({ id: 'auc_2', title: 'Second Page Item', createdAt: NOW - 12 * DAY })];

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
    const loadMoreBtn = screen.getByRole('button', { name: /load more listings/i });

    const user = userEvent.setup();
    await user.click(loadMoreBtn);

    expect(await screen.findByText('Second Page Item')).toBeInTheDocument();
    // First page's item is still there -- appended, not replaced.
    expect(screen.getByText('First Page Item')).toBeInTheDocument();
    // No further page: the button goes away.
    await waitFor(() => expect(screen.queryByRole('button', { name: /load more listings/i })).not.toBeInTheDocument());
  });
});

describe('App browse page', () => {
  beforeEach(() => {
    localStorage.clear();
    mockedApiFetch.mockReset();
    mockedApiFetchAuthed.mockReset();
    mockedStartPolling.mockClear();
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  const cheapOld = makeAuction({ id: 'auc_cheap', title: 'Cheap Old', price: 5, createdAt: NOW - 9 * DAY });
  const pricyMid = makeAuction({ id: 'auc_pricy', title: 'Pricy Mid', price: 500, createdAt: NOW - 5 * DAY });
  const midNew = makeAuction({ id: 'auc_mid', title: 'Mid New', price: 50, createdAt: NOW - 1 * DAY });

  it('offers exactly Newest, Price low to high and Price high to low, defaulting to Newest', async () => {
    feedOf([cheapOld, pricyMid, midNew]);
    render(<App />);
    await screen.findByText('Mid New');

    const select = document.getElementById('sort-auctions-select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Newest',
      'Price: low to high',
      'Price: high to low',
    ]);
    expect(gridTitles()).toEqual(['Mid New', 'Pricy Mid', 'Cheap Old']);
  });

  it('sorts by price in both directions', async () => {
    feedOf([cheapOld, pricyMid, midNew]);
    render(<App />);
    await screen.findByText('Mid New');

    const user = userEvent.setup();
    const select = document.getElementById('sort-auctions-select') as HTMLSelectElement;

    await user.selectOptions(select, 'price_low');
    expect(gridTitles()).toEqual(['Cheap Old', 'Mid New', 'Pricy Mid']);

    await user.selectOptions(select, 'price_high');
    expect(gridTitles()).toEqual(['Pricy Mid', 'Mid New', 'Cheap Old']);
  });

  it('falls back to Newest for an old bookmarked auction-era sort such as ?sort=ending_soonest', async () => {
    feedOf([cheapOld, midNew]);
    window.history.pushState({}, '', '/?sort=ending_soonest&status=ended');
    render(<App />);

    await screen.findByText('Mid New');
    expect(gridTitles()).toEqual(['Mid New', 'Cheap Old']);
  });

  it('keeps sold or expired rows off the browse page even if they are held locally', async () => {
    feedOf([
      midNew,
      makeAuction({ id: 'auc_sold', title: 'Already Sold', status: 'sold', soldAt: NOW }),
      makeAuction({ id: 'auc_lapsed', title: 'Just Lapsed', expiresAt: NOW - 1000 }),
    ]);
    render(<App />);

    await screen.findByText('Mid New');
    expect(screen.queryByText('Already Sold')).toBeNull();
    expect(screen.queryByText('Just Lapsed')).toBeNull();
    expect(screen.getByTestId('for-sale-count')).toHaveTextContent('1');
  });

  it('describes the site as a marketplace, with no real-time / bidding claims', async () => {
    feedOf([midNew]);
    render(<App />);
    await screen.findByText('Mid New');

    expect(document.body.textContent).not.toMatch(/real-time|bi-directional|bidding|instant price/i);
    expect(document.body.textContent).toMatch(/marketplace for MSA/i);
  });

  it('opens the footer links in a new tab with descriptive text', async () => {
    feedOf([]);
    render(<App />);

    const feedback = await screen.findByRole('link', { name: 'Send us your feedback' });
    expect(feedback).toHaveAttribute('target', '_blank');
    expect(feedback).toHaveAttribute('rel', 'noopener noreferrer');
    const github = screen.getByRole('link', { name: /dragonfisher29 on GitHub/ });
    expect(github).toHaveAttribute('target', '_blank');
    expect(github).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByText(/click here/i)).toBeNull();
  });

  it('runs exactly one background poll -- the feed, every 60s -- and no /api/health poll', async () => {
    feedOf([midNew]);
    render(<App />);
    await screen.findByText('Mid New');

    expect(mockedStartPolling).toHaveBeenCalledTimes(1);
    const [, intervalMs, , options] = mockedStartPolling.mock.calls[0];
    expect(intervalMs).toBe(60_000);
    expect(options).toEqual({ minGapMs: 30_000 });
    expect(mockedApiFetch.mock.calls.map(([url]) => url)).not.toContain('/api/health');
  });

  it('drops a listing from the grid when a refresh shows it has left the feed', async () => {
    const leaving = makeAuction({ id: 'auc_leaving', title: 'About To Sell', createdAt: NOW - 2 * DAY });
    feedOf([midNew, leaving]);
    render(<App />);
    await screen.findByText('About To Sell');

    // Simulate the next refresh: the server no longer lists it (sold elsewhere).
    const [, , onData] = mockedStartPolling.mock.calls[0];
    onData({ auctions: [midNew], nextCursor: null });

    await waitFor(() => expect(screen.queryByText('About To Sell')).toBeNull());
    expect(screen.getByText('Mid New')).toBeInTheDocument();
  });
});
