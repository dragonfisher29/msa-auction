import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
const DAY = 24 * 60 * 60 * 1000;

const signedInUser: User = {
  id: 'user_1',
  name: 'Alex Seller',
  username: 'alex_seller',
  token: 'tok_abc',
  createdAt: NOW - 60 * 60 * 1000,
};

function makeAuction(overrides: Partial<AuctionItem> = {}): AuctionItem {
  return {
    id: 'auc_1',
    title: 'Vintage Film Camera',
    description: 'A well-loved vintage film camera.',
    phoneNumber: '+44 7700 900000',
    price: 150,
    sellerId: signedInUser.id,
    sellerName: signedInUser.name,
    status: 'active',
    expiresAt: NOW + 20 * DAY,
    soldAt: null,
    category: 'Collectibles',
    imageUrl: 'https://picsum.photos/seed/camera/800/600',
    imageUrls: ['https://picsum.photos/seed/camera/800/600'],
    createdAt: NOW - 10 * DAY,
    ...overrides,
  };
}

const FOR_SALE = makeAuction({ id: 'auc_live', title: 'My Old Textbooks' });
const SOLD = makeAuction({ id: 'auc_sold', title: 'Desk Lamp', status: 'sold', soldAt: NOW - DAY });
const EXPIRED = makeAuction({ id: 'auc_expired', title: 'Kettle', status: 'expired', expiresAt: NOW - DAY });

const ACTIVITY: UserActivity = {
  listings: [FOR_SALE, SOLD, EXPIRED],
};

function mockActivity(result: UserActivity | 'not_found' | 'unauthorized') {
  mockedApiFetchAuthed.mockImplementation(async (path: string, _token?: string, init?: RequestInit) => {
    if (path === `/api/auctions/${FOR_SALE.id}/sold` && init?.method === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ auction: { ...FOR_SALE, status: 'sold', soldAt: NOW } }),
      } as Response;
    }
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
  const onAuctionUpdated = vi.fn();

  render(
    <AccountView
      user={signedInUser}
      watchlistIds={[]}
      onToggleWatchlist={onToggleWatchlist}
      onSelectAuction={onSelectAuction}
      onClose={onClose}
      onPromptAuth={onPromptAuth}
      onAuctionUpdated={onAuctionUpdated}
    />,
  );

  return { onSelectAuction, onClose, onPromptAuth, onToggleWatchlist, onAuctionUpdated };
}

describe('AccountView', () => {
  beforeEach(() => {
    mockedApiFetchAuthed.mockReset();
  });

  describe('my listings', () => {
    it('splits the seller\'s listings into For Sale and Sold & Past, with no bids or wins sections', async () => {
      mockActivity(ACTIVITY);
      renderAccountView();

      expect(await screen.findByRole('heading', { name: /For Sale/ })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /Sold & Past Listings/ })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /My Bids|My Wins/ })).toBeNull();

      expect(screen.getByTestId('account-count-active')).toHaveTextContent('1');
      expect(screen.getByTestId('account-count-past')).toHaveTextContent('2');

      const active = document.getElementById('account-section-active') as HTMLElement;
      const past = document.getElementById('account-section-past') as HTMLElement;
      expect(within(active).getByText('My Old Textbooks')).toBeInTheDocument();
      expect(within(past).getByText('Desk Lamp')).toBeInTheDocument();
      expect(within(past).getByText('Kettle')).toBeInTheDocument();
      expect(screen.getByTestId('listing-status-badge-auc_sold')).toHaveTextContent('Sold');
      expect(screen.getByTestId('listing-status-badge-auc_expired')).toHaveTextContent('Expired');
    });

    it('offers owner actions only on the listing still for sale', async () => {
      mockActivity(ACTIVITY);
      renderAccountView();

      expect(await screen.findByRole('button', { name: 'Mark My Old Textbooks as sold' })).toBeInTheDocument();
      expect(document.getElementById('mark-sold-btn-auc_sold')).toBeNull();
      expect(document.getElementById('cancel-listing-btn-auc_expired')).toBeNull();
    });

    it('marks a listing sold after confirming, and moves it to Sold & Past', async () => {
      mockActivity(ACTIVITY);
      const { onAuctionUpdated } = renderAccountView();
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'Mark My Old Textbooks as sold' }));
      await user.click(document.getElementById('mark-sold-confirm-btn') as HTMLButtonElement);

      await waitFor(() => expect(screen.getByTestId('account-count-past')).toHaveTextContent('3'));
      expect(screen.getByTestId('account-count-active')).toHaveTextContent('0');
      expect(onAuctionUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: FOR_SALE.id, status: 'sold' }));
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

    it('keeps both sections visible with their own empty copy when there are no listings', async () => {
      mockActivity({ listings: [] });
      renderAccountView();

      expect(await screen.findByText(/You have nothing for sale right now/)).toBeInTheDocument();
      expect(screen.getByText(/Listings you mark as sold, cancel, or that expire will show up here/)).toBeInTheDocument();
    });

    it('opens the listing detail modal through the same callback the grid uses', async () => {
      mockActivity(ACTIVITY);
      const { onSelectAuction } = renderAccountView();

      await waitFor(() =>
        expect(document.getElementById('view-auction-btn-auc_live')).toBeInTheDocument(),
      );

      const user = userEvent.setup();
      await user.click(document.getElementById('view-auction-btn-auc_live') as HTMLButtonElement);

      expect(onSelectAuction).toHaveBeenCalledWith(FOR_SALE);
    });
  });

  describe('degrading when the endpoint is not there yet', () => {
    it('shows a calm message on 404 and still renders both sections', async () => {
      mockActivity('not_found');
      renderAccountView();

      expect(await screen.findByText(/Your listings are not available yet/)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /For Sale/ })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /Sold & Past Listings/ })).toBeInTheDocument();
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
