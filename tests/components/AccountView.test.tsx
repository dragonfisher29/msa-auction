import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountView } from '../../src/components/AccountView';
import { AuctionItem, User, UserActivity } from '../../src/types';

vi.mock('../../src/lib/api', () => ({
  apiFetch: vi.fn(),
  resolveApiUrl: (path: string) => path,
  apiFetchAuthed: vi.fn(),
}));

import { apiFetchAuthed } from '../../src/lib/api';

const mockedApiFetchAuthed = apiFetchAuthed as unknown as ReturnType<typeof vi.fn>;

const NOW = Date.now();

const signedInUser: User = {
  id: 'user_1',
  name: 'Alex Bidder',
  username: 'alex_bidder',
  token: 'tok_abc',
  createdAt: NOW - 60 * 60 * 1000,
};

function makeAuction(overrides: Partial<AuctionItem> = {}): AuctionItem {
  return {
    id: 'auc_1',
    title: 'Vintage Film Camera',
    description: 'A well-loved vintage film camera.',
    phoneNumber: '+44 7700 900000',
    startingPrice: 100,
    currentPrice: 150,
    sellerId: 'seller_1',
    sellerName: 'Sam Seller',
    highestBidderId: 'user_1',
    highestBidderName: 'Alex Bidder',
    durationMinutes: 60,
    startTime: NOW - 5 * 60 * 1000,
    endTime: NOW + 60 * 60 * 1000,
    status: 'active',
    category: 'Collectibles',
    imageUrl: 'https://picsum.photos/seed/camera/800/600',
    imageUrls: ['https://picsum.photos/seed/camera/800/600'],
    bids: [],
    winnerId: null,
    winnerName: null,
    winningBid: null,
    createdAt: NOW - 10 * 60 * 1000,
    ...overrides,
  };
}

const MY_LISTING = makeAuction({
  id: 'auc_listing',
  title: 'My Old Textbooks',
  sellerId: signedInUser.id,
  sellerName: signedInUser.name,
});

const MY_BID = makeAuction({ id: 'auc_bid', title: 'Mechanical Keyboard' });

const MY_WIN = makeAuction({
  id: 'auc_win',
  title: 'Desk Lamp',
  status: 'ended',
  endTime: NOW - 60 * 1000,
  currentPrice: 42.5,
  winningBid: 42.5,
  winnerId: signedInUser.id,
  winnerName: signedInUser.name,
  sellerName: 'Sam Seller',
  phoneNumber: '+44 7700 900111',
});

const ACTIVITY: UserActivity = {
  listings: [MY_LISTING],
  bids: [MY_BID],
  wins: [MY_WIN],
};

function mockActivity(result: UserActivity | 'not_found' | 'unauthorized') {
  mockedApiFetchAuthed.mockImplementation(async (path: string) => {
    if (path !== '/api/users/me/activity') {
      throw new Error(`Unexpected apiFetchAuthed call: ${path}`);
    }
    if (result === 'not_found') {
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }
    if (result === 'unauthorized') {
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: 'Authentication required. [Code: UNAUTHORIZED]', code: 'UNAUTHORIZED' }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => result } as Response;
  });
}

function renderAccountView() {
  const onSelectAuction = vi.fn();
  const onClose = vi.fn();
  const onPromptAuth = vi.fn();
  const onToggleWatchlist = vi.fn();

  render(
    <AccountView
      user={signedInUser}
      watchlistIds={[]}
      onToggleWatchlist={onToggleWatchlist}
      onSelectAuction={onSelectAuction}
      onClose={onClose}
      onPromptAuth={onPromptAuth}
    />,
  );

  return { onSelectAuction, onClose, onPromptAuth, onToggleWatchlist };
}

describe('AccountView', () => {
  beforeEach(() => {
    mockedApiFetchAuthed.mockReset();
  });

  describe('the three sections', () => {
    it('renders My Listings, My Bids and My Wins with the items from the activity endpoint', async () => {
      mockActivity(ACTIVITY);
      renderAccountView();

      expect(await screen.findByRole('heading', { name: /My Listings/ })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /My Bids/ })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /My Wins/ })).toBeInTheDocument();

      expect(screen.getByTestId('account-count-listings')).toHaveTextContent('1');
      expect(screen.getByTestId('account-count-bids')).toHaveTextContent('1');
      expect(screen.getByTestId('account-count-wins')).toHaveTextContent('1');

      // Each section renders the shared AuctionCard, identified by the card's own id scheme.
      expect(document.getElementById('auction-card-auc_listing')).toBeInTheDocument();
      expect(document.getElementById('auction-card-auc_bid')).toBeInTheDocument();
      expect(document.getElementById('auction-card-auc_win')).toBeInTheDocument();
    });

    it('sends the session bearer token with the activity request', async () => {
      mockActivity(ACTIVITY);
      renderAccountView();

      await waitFor(() =>
        expect(mockedApiFetchAuthed).toHaveBeenCalledWith(
          '/api/users/me/activity',
          signedInUser.token,
        ),
      );
    });

    it('keeps each section visible with its own empty copy when there is no activity', async () => {
      mockActivity({ listings: [], bids: [], wins: [] });
      renderAccountView();

      expect(await screen.findByText(/You haven't listed anything yet/)).toBeInTheDocument();
      expect(screen.getByText(/You haven't bid on anything yet/)).toBeInTheDocument();
      expect(screen.getByText(/You haven't won an auction yet/)).toBeInTheDocument();

      expect(screen.getByTestId('account-count-wins')).toHaveTextContent('0');
    });

    it('opens the auction detail modal through the same callback the grid uses', async () => {
      mockActivity(ACTIVITY);
      const { onSelectAuction } = renderAccountView();

      // The first render is the loading state, so wait for the card itself to arrive.
      await waitFor(() =>
        expect(document.getElementById('view-auction-btn-auc_bid')).toBeInTheDocument(),
      );
      const viewBtn = document.getElementById('view-auction-btn-auc_bid') as HTMLButtonElement;

      const user = userEvent.setup();
      await user.click(viewBtn);

      expect(onSelectAuction).toHaveBeenCalledWith(MY_BID);
    });
  });

  describe('My Wins handover details', () => {
    it('shows the winning amount and the seller contact routes', async () => {
      mockActivity(ACTIVITY);
      renderAccountView();

      expect(await screen.findByTestId('win-amount-auc_win')).toHaveTextContent('£42.50');

      const callLink = screen.getByRole('link', {
        name: 'Call Sam Seller on +44 7700 900111',
      }) as HTMLAnchorElement;
      expect(callLink.getAttribute('href')).toBe('tel:+44 7700 900111');

      const whatsAppLink = screen.getByRole('link', {
        name: /Message Sam Seller on WhatsApp about Desk Lamp/,
      }) as HTMLAnchorElement;
      expect(whatsAppLink.getAttribute('href')).toContain('https://wa.me/447700900111');
      expect(whatsAppLink.rel).toBe('noopener noreferrer');
    });

    it('adds no contact panel to listings or bids', async () => {
      mockActivity(ACTIVITY);
      renderAccountView();

      await screen.findByTestId('win-amount-auc_win');
      expect(screen.queryByTestId('win-amount-auc_listing')).not.toBeInTheDocument();
      expect(screen.queryByTestId('win-amount-auc_bid')).not.toBeInTheDocument();
    });
  });

  describe('degrading when the endpoint is not there yet', () => {
    it('shows a calm message on 404 and still renders the three sections', async () => {
      mockActivity('not_found');
      renderAccountView();

      expect(await screen.findByText(/Account activity is not available yet/)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /My Listings/ })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /My Bids/ })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /My Wins/ })).toBeInTheDocument();
    });

    it('surfaces a sign-in path on 401 rather than a generic failure', async () => {
      mockActivity('unauthorized');
      const { onPromptAuth } = renderAccountView();

      expect(await screen.findByText(/Your session has expired/)).toBeInTheDocument();

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Sign In Again' }));
      expect(onPromptAuth).toHaveBeenCalled();
    });
  });
});
