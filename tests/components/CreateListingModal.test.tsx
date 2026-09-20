import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateListingModal } from '../../src/components/CreateListingModal';
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

/** A full row, as returned by `GET /api/auctions/:id` -- always carries `imageUrls`. */
function makeFullAuction(overrides: Partial<AuctionItem> = {}): AuctionItem {
  return {
    id: 'auc_1',
    title: 'Vintage Film Camera',
    description: 'A well-loved vintage film camera, fully functional.',
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
    imageUrl: 'https://example.test/camera-1.jpg',
    imageUrls: ['https://example.test/camera-1.jpg', 'https://example.test/camera-2.jpg'],
    bids: [],
    winnerId: null,
    winnerName: null,
    winningBid: null,
    createdAt: NOW - 10 * 60 * 1000,
    ...overrides,
  };
}

/**
 * A row shaped like one from `GET /api/users/me/activity`: the real text fields, but only
 * `imageCount` for images -- no `imageUrls`/`imageUrl` at all. This is what AccountView's "My
 * Listings" hands to the modal, and is the exact shape that produced the empty-`imageUrls` bug.
 */
function makePartialAuction(overrides: Partial<AuctionItem> = {}): AuctionItem {
  const full = makeFullAuction(overrides);
  const { imageUrl, imageUrls, ...rest } = full;
  return { ...rest, imageCount: imageUrls?.length ?? 0 } as AuctionItem;
}

function renderEditModal(initialAuction: AuctionItem, overrides: Partial<Parameters<typeof CreateListingModal>[0]> = {}) {
  const onClose = vi.fn();
  const onPromptAuth = vi.fn();
  const onCreated = vi.fn();
  const onUpdated = vi.fn();

  render(
    <CreateListingModal
      isOpen={true}
      user={seller}
      mode="edit"
      initialAuction={initialAuction}
      onClose={onClose}
      onCreated={onCreated}
      onUpdated={onUpdated}
      onPromptAuth={onPromptAuth}
      {...overrides}
    />,
  );

  return { onClose, onPromptAuth, onCreated, onUpdated };
}

function submitBtn(): HTMLButtonElement {
  return document.getElementById('submit-create-listing-btn') as HTMLButtonElement;
}

describe('CreateListingModal (edit mode)', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it('fetches the full listing when initialAuction lacks imageUrls, and PATCHes the real images -- not an empty array', async () => {
    const partial = makePartialAuction();
    const full = makeFullAuction();

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/auctions/${partial.id}` && (!init || !init.method)) {
        return { ok: true, status: 200, json: async () => ({ auction: full }) } as Response;
      }
      if (url === `/api/auctions/${partial.id}` && init?.method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ auction: { ...full, title: 'Updated title' } }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    const { onUpdated } = renderEditModal(partial);

    // The fetch resolves and the loading state clears.
    await waitFor(() => expect(document.getElementById('edit-listing-loading')).toBeNull());
    expect(submitBtn()).not.toBeDisabled();

    const user = userEvent.setup();
    await user.click(submitBtn());

    await waitFor(() => {
      const patchCall = mockedApiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body.imageUrls).toEqual(full.imageUrls);
      expect(body.imageUrls.length).toBeGreaterThan(0);
    });

    expect(onUpdated).toHaveBeenCalled();
  });

  it('disables submit while the full-record fetch is in flight', async () => {
    const partial = makePartialAuction();
    let resolveGet: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveGet = resolve;
    });

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/auctions/${partial.id}` && (!init || !init.method)) {
        return pending;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    renderEditModal(partial);

    expect(document.getElementById('edit-listing-loading')).toBeInTheDocument();
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent('Loading...');

    await act(async () => {
      resolveGet({ ok: true, status: 200, json: async () => ({ auction: makeFullAuction() }) } as Response);
      await pending;
    });

    await waitFor(() => expect(submitBtn()).not.toBeDisabled());
    expect(document.getElementById('edit-listing-loading')).toBeNull();
  });

  it('shows an error and keeps submit disabled when the full-record fetch fails', async () => {
    const partial = makePartialAuction();

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/auctions/${partial.id}` && (!init || !init.method)) {
        return { ok: false, status: 500, json: async () => ({ error: 'Failed to load auction.' }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    renderEditModal(partial);

    expect(await screen.findByText(/Could not load the current listing details/i)).toBeInTheDocument();
    expect(submitBtn()).toBeDisabled();

    // Confirms the guard actually blocks the network call too, not just the disabled attribute.
    expect(mockedApiFetch).not.toHaveBeenCalledWith(
      `/api/auctions/${partial.id}`,
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('round-trips a title-only edit without touching the images', async () => {
    const partial = makePartialAuction();
    const full = makeFullAuction();

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/auctions/${partial.id}` && (!init || !init.method)) {
        return { ok: true, status: 200, json: async () => ({ auction: full }) } as Response;
      }
      if (url === `/api/auctions/${partial.id}` && init?.method === 'PATCH') {
        const body = JSON.parse(init!.body as string);
        return { ok: true, status: 200, json: async () => ({ auction: { ...full, ...body } }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    renderEditModal(partial);

    await waitFor(() => expect(submitBtn()).not.toBeDisabled());

    const titleInput = document.getElementById('listing-title-input') as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(titleInput);
    await user.type(titleInput, 'A brand new title');
    await user.click(submitBtn());

    await waitFor(() => {
      const patchCall = mockedApiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body.title).toBe('A brand new title');
      expect(body.imageUrls).toEqual(full.imageUrls);
      expect(body.imageUrls.length).toBeGreaterThan(0);
    });
  });

  it('does not re-fetch when initialAuction already carries imageUrls (e.g. from AuctionDetailModal)', async () => {
    const full = makeFullAuction();

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/auctions/${full.id}` && init?.method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ auction: full }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    renderEditModal(full);

    // No GET was ever issued -- the passed-in object was already complete.
    expect(mockedApiFetch).not.toHaveBeenCalled();
    expect(document.getElementById('edit-listing-loading')).toBeNull();
    expect(submitBtn()).not.toBeDisabled();
  });

  it('does not reset a typed title when the parent re-renders with a new initialAuction object of the same id (a poll tick)', async () => {
    const full = makeFullAuction();

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    const { rerender } = render(
      <CreateListingModal
        isOpen={true}
        user={seller}
        mode="edit"
        initialAuction={full}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onUpdated={vi.fn()}
        onPromptAuth={vi.fn()}
      />,
    );

    await waitFor(() => expect(submitBtn()).not.toBeDisabled());

    const titleInput = document.getElementById('listing-title-input') as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(titleInput);
    await user.type(titleInput, 'My unsaved edit');

    // A new object, same id, with an updated currentPrice -- exactly what a 3s detail poll tick
    // produces: a freshly-parsed response body, not the same reference, for the same listing.
    const polled = { ...full, currentPrice: full.currentPrice + 10 };
    rerender(
      <CreateListingModal
        isOpen={true}
        user={seller}
        mode="edit"
        initialAuction={polled}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onUpdated={vi.fn()}
        onPromptAuth={vi.fn()}
      />,
    );

    expect(titleInput.value).toBe('My unsaved edit');
  });

  it('repopulates the form when initialAuction changes to a genuinely different listing id', async () => {
    const full = makeFullAuction();
    const other = makeFullAuction({ id: 'auc_2', title: 'A Different Listing' });

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    const { rerender } = render(
      <CreateListingModal
        isOpen={true}
        user={seller}
        mode="edit"
        initialAuction={full}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onUpdated={vi.fn()}
        onPromptAuth={vi.fn()}
      />,
    );

    await waitFor(() => expect(submitBtn()).not.toBeDisabled());

    const titleInput = document.getElementById('listing-title-input') as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(titleInput);
    await user.type(titleInput, 'My unsaved edit');

    rerender(
      <CreateListingModal
        isOpen={true}
        user={seller}
        mode="edit"
        initialAuction={other}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onUpdated={vi.fn()}
        onPromptAuth={vi.fn()}
      />,
    );

    await waitFor(() => expect(titleInput.value).toBe('A Different Listing'));
  });
});
