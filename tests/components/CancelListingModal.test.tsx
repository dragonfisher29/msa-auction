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
    startingPrice: 100,
    currentPrice: 100,
    sellerId: seller.id,
    sellerName: seller.name,
    highestBidderId: null,
    highestBidderName: null,
    durationMinutes: 60,
    startTime: NOW - 5 * 60 * 1000,
    endTime: NOW + 60 * 60 * 1000,
    status: 'active',
    category: 'Collectibles',
    imageUrls: ['https://example.test/camera.jpg'],
    bids: [],
    winnerId: null,
    winnerName: null,
    winningBid: null,
    createdAt: NOW - 10 * 60 * 1000,
    ...overrides,
  };
}

describe('ListingActions', () => {
  it('disables Edit and shows the reason once the listing has bids, but still offers Cancel', () => {
    const auction = makeAuction({
      bids: [{ id: 'bid_1', auctionId: 'auc_1', userId: 'bidder_1', userName: 'Bea Bidder', amount: 120, timestamp: NOW }],
    });

    render(<ListingActions auction={auction} onEdit={vi.fn()} onCancel={vi.fn()} />);

    const editBtn = screen.getByRole('button', { name: `Edit ${auction.title}` }) as HTMLButtonElement;
    expect(editBtn).toBeDisabled();
    expect(screen.getByText(/This listing already has bids and can no longer be edited/i)).toBeInTheDocument();

    const cancelBtn = screen.getByRole('button', { name: `Cancel ${auction.title}` }) as HTMLButtonElement;
    expect(cancelBtn).not.toBeDisabled();
  });

  it('enables Edit when the listing has zero bids', () => {
    const auction = makeAuction({ bids: [] });
    render(<ListingActions auction={auction} onEdit={vi.fn()} onCancel={vi.fn()} />);

    const editBtn = screen.getByRole('button', { name: `Edit ${auction.title}` }) as HTMLButtonElement;
    expect(editBtn).not.toBeDisabled();
    expect(screen.queryByText(/can no longer be edited/i)).not.toBeInTheDocument();
  });

  it('renders nothing for a listing that has already ended', () => {
    const auction = makeAuction({ status: 'ended' });
    const { container } = render(<ListingActions auction={auction} onEdit={vi.fn()} onCancel={vi.fn()} />);
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

    expect(screen.getByText(/This cannot be undone\./i)).toBeInTheDocument();
    expect(screen.getByText(auction.title, { exact: false })).toBeInTheDocument();
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('warns that bidders will still see the listing when it already has bids', () => {
    const auction = makeAuction({
      bids: [{ id: 'bid_1', auctionId: 'auc_1', userId: 'bidder_1', userName: 'Bea Bidder', amount: 120, timestamp: NOW }],
    });
    render(<CancelListingModal auction={auction} user={seller} onClose={vi.fn()} onCancelled={vi.fn()} />);

    expect(screen.getByText(/Bidders will still be able to see the cancelled listing/i)).toBeInTheDocument();
  });

  it('closes without cancelling when "Keep Listing" is clicked', async () => {
    const onClose = vi.fn();
    render(<CancelListingModal auction={makeAuction()} user={seller} onClose={onClose} onCancelled={vi.fn()} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Keep Listing' }));

    expect(onClose).toHaveBeenCalled();
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('DELETEs the listing and reports the cancelled auction once confirmed', async () => {
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

  it('shows a distinct message for LISTING_NOT_EDITABLE rather than a generic failure', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Listing is not editable. [Code: LISTING_NOT_EDITABLE]', code: 'LISTING_NOT_EDITABLE' }),
    } as Response);

    render(<CancelListingModal auction={makeAuction()} user={seller} onClose={vi.fn()} onCancelled={vi.fn()} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Yes, Cancel It' }));

    expect(await screen.findByText(/This listing has already ended and can no longer be cancelled\./i)).toBeInTheDocument();
  });
});
