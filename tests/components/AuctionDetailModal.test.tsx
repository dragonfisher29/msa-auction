import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuctionDetailModal } from '../../src/components/AuctionDetailModal';
import { __resetImageCacheForTests } from '../../src/lib/images';
import { SITE_NAME } from '../../src/lib/site';
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
const DAY = 24 * 60 * 60 * 1000;

function makeAuction(overrides: Partial<AuctionItem> = {}): AuctionItem {
  return {
    id: 'auc_1',
    title: 'Vintage Film Camera',
    description: 'A well-loved vintage film camera, fully functional.',
    phoneNumber: '+44 7700 900000',
    price: 150,
    sellerId: 'seller_1',
    sellerName: 'Sam Seller',
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

/** A row as the public list (or a signed-out detail fetch) sends it: no phone number at all. */
function withoutPhone(auction: AuctionItem): AuctionItem {
  const { phoneNumber, ...rest } = auction;
  return rest as AuctionItem;
}

const buyer: User = {
  id: 'buyer_2',
  name: 'Alex Buyer',
  username: 'alex_buyer',
  token: 'tok_abc',
  createdAt: NOW - 20 * DAY,
};

const seller: User = {
  id: 'seller_1',
  name: 'Sam Seller',
  username: 'sam_seller',
  token: 'tok_seller',
  createdAt: NOW - 30 * DAY,
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
    __resetImageCacheForTests();
    mockedApiFetch.mockReset();
  });

  describe('price and status', () => {
    it('shows the fixed asking price and no bidding UI at all', () => {
      renderModal(makeAuction({ price: 12.5 }), buyer);

      expect(document.getElementById('listing-detail-price')).toHaveTextContent('£12.50');
      expect(document.getElementById('listing-status-pill')).toHaveTextContent('For Sale');
      expect(document.getElementById('place-bid-amount-input')).toBeNull();
      expect(document.body.textContent).not.toMatch(/\bbids?\b|bidder|highest|countdown|time remaining/i);
    });

    it('tells the viewer when the listing expires', () => {
      renderModal(makeAuction({ expiresAt: NOW + 5 * DAY - 60 * 1000 }), buyer);
      expect(document.getElementById('listing-detail-expiry')).toHaveTextContent('Expires in 5 days');
    });

    it('renders a sold listing as a clear, non-actionable state', () => {
      renderModal(makeAuction({ status: 'sold', soldAt: NOW - DAY }), buyer);

      expect(document.getElementById('listing-status-pill')).toHaveTextContent('Sold');
      expect(document.getElementById('listing-status-banner')).toHaveTextContent(/This item has been sold/i);
      expect(document.getElementById('contact-whatsapp-btn')).toBeNull();
      expect(document.getElementById('listing-contact-closed')).toBeInTheDocument();
    });

    it('renders an expired listing (including one past expiresAt the server still calls active) as non-actionable', () => {
      renderModal(makeAuction({ expiresAt: NOW - 1000 }), buyer);

      expect(document.getElementById('listing-status-pill')).toHaveTextContent('Expired');
      expect(document.getElementById('listing-status-banner')).toHaveTextContent(/This listing is expired/i);
      expect(document.getElementById('contact-whatsapp-btn')).toBeNull();
      expect(mockedApiFetch).not.toHaveBeenCalled();
    });
  });

  describe('contacting the seller', () => {
    it('signed out: shows "Sign in to contact the seller", which opens the auth modal, and fetches nothing', async () => {
      const { onPromptAuth } = renderModal(withoutPhone(makeAuction()), null);

      expect(document.getElementById('contact-whatsapp-btn')).toBeNull();
      const signIn = screen.getByRole('button', { name: /sign in to contact the seller/i });
      await userEvent.setup().click(signIn);

      expect(onPromptAuth).toHaveBeenCalledTimes(1);
      expect(mockedApiFetch).not.toHaveBeenCalled();
    });

    it('signed in: a prominent WhatsApp link with the prefilled message naming the item and site', () => {
      const auction = makeAuction({ phoneNumber: '+60 12-345 6789' });
      renderModal(auction, buyer);

      const link = document.getElementById('contact-whatsapp-btn') as HTMLAnchorElement;
      expect(link).toBeInTheDocument();
      // Read the attribute rather than the .href property: the DOM getter normalises the URL
      // and re-encodes the apostrophe in the prefilled message as %27.
      expect(link.getAttribute('href')).toBe(
        `https://wa.me/60123456789?text=${encodeURIComponent(`Hi, I'm interested in "${auction.title}" on ${SITE_NAME}.`)}`,
      );
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
      expect(screen.queryByRole('button', { name: /sign in to contact the seller/i })).toBeNull();
    });

    it('signed in: hides the WhatsApp button when the number does not parse, but still shows the number', () => {
      renderModal(makeAuction({ phoneNumber: '12345' }), buyer);

      expect(document.getElementById('contact-whatsapp-btn')).toBeNull();
      expect(screen.getByText('12345')).toBeInTheDocument();
    });

    it('signed in, opened from a list row with no phone: makes ONE authed detail fetch, then shows WhatsApp', async () => {
      const full = makeAuction();
      mockedApiFetch.mockImplementation(async (url: string) => {
        if (url === `/api/auctions/${full.id}`) {
          // The real detail row carries no image data, only imageCount.
          const { imageUrl, imageUrls, ...slim } = full;
          return { ok: true, status: 200, json: async () => ({ auction: { ...slim, imageCount: 1 } }) } as Response;
        }
        throw new Error(`Unexpected apiFetch call: ${url}`);
      });

      const { onAuctionUpdated } = renderModal(withoutPhone(full), buyer);

      expect(await screen.findByRole('link', { name: /message the seller on whatsapp/i })).toBeInTheDocument();
      expect(mockedApiFetch).toHaveBeenCalledTimes(1);
      expect(mockedApiFetch).toHaveBeenCalledWith(`/api/auctions/${full.id}`, {
        headers: { Authorization: `Bearer ${buyer.token}` },
      });
      expect(onAuctionUpdated).toHaveBeenCalledWith(expect.objectContaining({ phoneNumber: full.phoneNumber }));
      // The inline images it was opened with survive the slim detail row.
      expect((screen.getByAltText(full.title) as HTMLImageElement).src).toBe(full.imageUrls![0]);
    });

    it('offers a retry when that detail fetch fails', async () => {
      const full = makeAuction();
      mockedApiFetch
        .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ auction: full }) } as Response);

      renderModal(withoutPhone(full), buyer);

      const retry = await screen.findByRole('button', { name: /try again/i });
      await userEvent.setup().click(retry);

      expect(await screen.findByRole('link', { name: /message the seller on whatsapp/i })).toBeInTheDocument();
      expect(mockedApiFetch).toHaveBeenCalledTimes(2);
    });

    it('shows "no longer available" when the listing has been taken down since the grid loaded (404)', async () => {
      mockedApiFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as Response);

      renderModal(withoutPhone(makeAuction()), buyer);

      expect(await screen.findByRole('dialog', { name: /this listing is no longer available/i })).toBeInTheDocument();
    });

    it('owner: sees their own-listing note instead of a contact button, and no fetch is made', () => {
      renderModal(withoutPhone(makeAuction()), seller);

      expect(document.getElementById('contact-whatsapp-btn')).toBeNull();
      expect(screen.queryByRole('button', { name: /sign in to contact the seller/i })).toBeNull();
      expect(screen.getByText(/This is your listing/i)).toBeInTheDocument();
      expect(mockedApiFetch).not.toHaveBeenCalled();
    });
  });

  describe('owner controls', () => {
    it('offers Edit, Mark as Sold and Cancel to the owner only', () => {
      renderModal(makeAuction(), seller);
      expect(screen.getByRole('button', { name: /^Mark Vintage Film Camera as sold$/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Edit Vintage Film Camera$/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Cancel Vintage Film Camera$/ })).toBeInTheDocument();
    });

    it('does not offer owner controls to anyone else', () => {
      renderModal(makeAuction(), buyer);
      expect(document.getElementById('mark-sold-btn-auc_1')).toBeNull();
      expect(document.getElementById('edit-listing-btn-auc_1')).toBeNull();
    });

    it('mark as sold: confirms first, POSTs /sold, then shows the sold state and tells the parent', async () => {
      const auction = makeAuction();
      const sold = { ...auction, status: 'sold' as const, soldAt: NOW };
      mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === `/api/auctions/${auction.id}/sold` && init?.method === 'POST') {
          return { ok: true, status: 200, json: async () => ({ auction: sold }) } as Response;
        }
        throw new Error(`Unexpected apiFetch call: ${url}`);
      });

      const { onAuctionUpdated } = renderModal(auction, seller);
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: /^Mark Vintage Film Camera as sold$/ }));
      // Nothing sent until the confirm step.
      expect(mockedApiFetch).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: /mark as sold/i })).toBeInTheDocument();

      await user.click(document.getElementById('mark-sold-confirm-btn') as HTMLButtonElement);

      await waitFor(() =>
        expect(mockedApiFetch).toHaveBeenCalledWith(`/api/auctions/${auction.id}/sold`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${seller.token}` },
        }),
      );
      expect(await screen.findByText(/This item has been sold/i)).toBeInTheDocument();
      expect(onAuctionUpdated).toHaveBeenCalledWith(sold);
      // The owner controls are gone once it is sold.
      expect(document.getElementById('mark-sold-btn-auc_1')).toBeNull();
    });

    it('mark as sold: "Not Yet" closes the confirm step without sending anything', async () => {
      renderModal(makeAuction(), seller);
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: /^Mark Vintage Film Camera as sold$/ }));
      await user.click(document.getElementById('mark-sold-keep-btn') as HTMLButtonElement);

      expect(screen.queryByRole('dialog', { name: /mark as sold/i })).toBeNull();
      expect(mockedApiFetch).not.toHaveBeenCalled();
    });

    it('mark as sold: a 409 explains the listing is no longer active', async () => {
      mockedApiFetch.mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: 'Listing is not active. [Code: LISTING_NOT_EDITABLE]', code: 'LISTING_NOT_EDITABLE' }),
      } as Response);

      renderModal(makeAuction(), seller);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /^Mark Vintage Film Camera as sold$/ }));
      await user.click(document.getElementById('mark-sold-confirm-btn') as HTMLButtonElement);

      expect(await screen.findByText(/no longer active/i)).toBeInTheDocument();
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
      renderModal(makeAuction({ imageUrls: THREE_IMAGES }), buyer);

      expect(document.getElementById('gallery-counter')).toHaveTextContent('1 / 3');
      expect(screen.getByLabelText('Previous image')).toBeInTheDocument();
      expect(screen.getByLabelText('Next image')).toBeInTheDocument();
      expect(activeImageSrc()).toBe(THREE_IMAGES[0]);
    });

    it('advances the visible image on Next and wraps from the last back to the first', async () => {
      renderModal(makeAuction({ imageUrls: THREE_IMAGES }), buyer);

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
      renderModal(makeAuction({ imageUrls: THREE_IMAGES }), buyer);

      const user = userEvent.setup();
      await user.click(document.getElementById('gallery-prev-btn') as HTMLButtonElement);

      expect(activeImageSrc()).toBe(THREE_IMAGES[2]);
      expect(document.getElementById('gallery-counter')).toHaveTextContent('3 / 3');
    });

    it('selects an image when its thumbnail is clicked', async () => {
      renderModal(makeAuction({ imageUrls: THREE_IMAGES }), buyer);

      const user = userEvent.setup();
      await user.click(document.getElementById('gallery-thumb-2') as HTMLButtonElement);

      expect(activeImageSrc()).toBe(THREE_IMAGES[2]);
      expect(document.getElementById('gallery-counter')).toHaveTextContent('3 / 3');
    });

    it('renders no nav buttons, counter or thumbnails for a single-image listing', () => {
      renderModal(
        makeAuction({ imageUrls: [THREE_IMAGES[0]], imageUrl: THREE_IMAGES[0] }),
        buyer,
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
        buyer,
      );

      expect((screen.getByAltText('Vintage Film Camera') as HTMLImageElement).src).toBe(
        'https://example.test/legacy.jpg',
      );
      expect(document.getElementById('gallery-counter')).toBeNull();
    });

    it('ignores blank entries in imageUrls so they never render as empty frames', () => {
      renderModal(
        makeAuction({ imageUrls: [THREE_IMAGES[0], '   ', THREE_IMAGES[1]] }),
        buyer,
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
        buyer,
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

    it('never falls back to a third-party image host when a listing has no photos', async () => {
      mockedApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ imageUrls: [] }) } as Response);
      renderModal(makeAuction({ imageUrls: undefined, imageUrl: undefined, imageCount: 0 }), buyer);

      await waitFor(() => {
        const img = screen.getByAltText('Vintage Film Camera') as HTMLImageElement;
        expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
      });
    });
  });

  describe('report control', () => {
    it('is offered to a signed-in user who is not the seller', async () => {
      renderModal(makeAuction(), buyer);

      const reportBtn = screen.getByRole('button', { name: /report the listing/i });
      await userEvent.setup().click(reportBtn);

      expect(await screen.findByRole('dialog', { name: /report this listing/i })).toBeInTheDocument();
    });

    it('is not offered to the seller, who has Cancel instead', () => {
      renderModal(makeAuction(), seller);

      expect(document.getElementById('report-listing-btn')).toBeNull();
    });

    it('is not offered to a signed-out visitor', () => {
      // The server needs a reporter id, and an anonymous report queue is a spam queue -- so
      // this is left out entirely rather than bounced through a sign-in prompt.
      renderModal(withoutPhone(makeAuction()), null);

      expect(document.getElementById('report-listing-btn')).toBeNull();
    });

    it('stays available on a sold listing', () => {
      // A scam is often only recognised after the fact, and the committee still wants to know
      // about the account behind it.
      renderModal(makeAuction({ status: 'sold', soldAt: NOW }), buyer);

      expect(document.getElementById('report-listing-btn')).toBeInTheDocument();
    });
  });
});
