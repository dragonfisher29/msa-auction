import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CancelListingModal } from '../../src/components/CancelListingModal';
import { ListingActions } from '../../src/components/ListingActions';
import { AuctionItem, User } from '../../src/types';

vi.mock('../../src/lib/api', () => {
  const apiFetch = vi.fn();
  return {
    apiFetch,
    resolveApiUrl: (path: string) => path,
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

import { apiFetch } from '../../src/lib/api';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const seller: User = {
  id: 'seller_1',
  name: 'Sam Seller',
  username: 'sam_seller',
  token: 'tok_seller',
  createdAt: NOW - 60 * 60 * 1000,
};

function makeAuction(overrides: Partial<AuctionItem> = {}): AuctionItem {
  return {
    id: 'auc_1',
    title: 'Vintage Film Camera',
    description: 'A well-loved vintage film camera.',
    phoneNumber: '+44 7700 900000',
    price: 100,
    sellerId: seller.id,
    sellerName: seller.name,
    status: 'active',
    expiresAt: NOW + 20 * DAY,
    soldAt: null,
    category: 'Collectibles',
    imageUrls: ['https://example.test/camera.jpg'],
    createdAt: NOW - 10 * 60 * 1000,
    ...overrides,
  };
}

function renderActions(auction: AuctionItem) {
  return render(<ListingActions auction={auction} onEdit={vi.fn()} onMarkSold={vi.fn()} onCancel={vi.fn()} />);
}

describe('ListingActions', () => {
  it('offers Mark as Sold, Edit and Cancel on an active listing', () => {
    const auction = makeAuction();
    renderActions(auction);

    expect(screen.getByRole('button', { name: `Mark ${auction.title} as sold` })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: `Edit ${auction.title}` })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: `Cancel ${auction.title}` })).not.toBeDisabled();
  });

  it.each([
    ['sold', { status: 'sold' as const, soldAt: NOW }],
    ['expired', { status: 'expired' as const }],
    ['cancelled', { status: 'cancelled' as const }],
    ['past expiresAt but still "active"', { expiresAt: NOW - 1000 }],
  ])('renders nothing for a %s listing', (_label, overrides) => {
    const { container } = renderActions(makeAuction(overrides));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('CancelListingModal', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it('does not call the API until the confirm button is clicked (requires confirmation)', () => {
    const auction = makeAuction();
    render(
      <CancelListingModal auction={auction} user={seller} onClose={vi.fn()} onCancelled={vi.fn()} />,
    );

    expect(screen.getByRole('dialog', { name: /cancel listing/i })).toBeInTheDocument();
    expect(screen.getByText(/This cannot be undone\./i)).toBeInTheDocument();
    expect(screen.getByText(auction.title, { exact: false })).toBeInTheDocument();
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('closes without cancelling when "Keep Listing" is clicked', async () => {
    const onClose = vi.fn();
    render(<CancelListingModal auction={makeAuction()} user={seller} onClose={onClose} onCancelled={vi.fn()} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Keep Listing' }));

    expect(onClose).toHaveBeenCalled();
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('DELETEs the listing and reports the cancelled listing once confirmed', async () => {
    const auction = makeAuction();
    const cancelled = { ...auction, status: 'cancelled' as const };
    mockedApiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ auction: cancelled }),
    } as Response);

    const onCancelled = vi.fn();
    render(<CancelListingModal auction={auction} user={seller} onClose={vi.fn()} onCancelled={onCancelled} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Yes, Cancel It' }));

    await waitFor(() => {
      expect(mockedApiFetch).toHaveBeenCalledWith(`/api/auctions/${auction.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${seller.token}` },
      });
    });
    expect(onCancelled).toHaveBeenCalledWith(cancelled);
  });

  it('shows a distinct message for a 409 (no longer active) rather than a generic failure', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Listing is not editable. [Code: LISTING_NOT_EDITABLE]', code: 'LISTING_NOT_EDITABLE' }),
    } as Response);

    render(<CancelListingModal auction={makeAuction()} user={seller} onClose={vi.fn()} onCancelled={vi.fn()} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Yes, Cancel It' }));

    expect(await screen.findByText(/no longer active \(it may have sold or expired\)/i)).toBeInTheDocument();
  });
});
