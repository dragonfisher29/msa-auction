import type { AuctionItem, ListingStatus } from '../types';

/**
 * Client-side mirror of the listing rules the server enforces. The server is the authority on
 * every one of these (see the create/edit validation in `workers/`); they are repeated here only
 * so the form can refuse a bad value before a round trip and say why in plain English.
 */

/** A listing drops off the browse page this many days after it was created. */
export const LISTING_LIFETIME_DAYS = 30;

export const TITLE_MAX_LENGTH = 100;
export const DESCRIPTION_MAX_LENGTH = 2000;
export const PHONE_MAX_LENGTH = 30;

/** Prices are whole pence, strictly above zero, capped at £100,000. */
export const PRICE_MIN = 0.01;
export const PRICE_MAX = 100000;

/**
 * The status to render. The server already reports `'expired'` itself, but a row the client has
 * been holding for a while (the browse feed only refreshes every minute) can pass `expiresAt`
 * while still saying `'active'`; treating that as expired locally keeps a dead listing from
 * offering a contact button for up to a minute after it lapsed.
 */
export function getListingStatus(auction: AuctionItem, now: number = Date.now()): ListingStatus {
  if (auction.status === 'active' && typeof auction.expiresAt === 'number' && auction.expiresAt <= now) {
    return 'expired';
  }
  return auction.status;
}

/** True when the listing belongs on the browse page and can still be bought. */
export function isListingAvailable(auction: AuctionItem, now: number = Date.now()): boolean {
  return getListingStatus(auction, now) === 'active';
}

/** Short badge text for every non-active status. */
export const LISTING_STATUS_LABEL: Record<Exclude<ListingStatus, 'active'>, string> = {
  sold: 'Sold',
  expired: 'Expired',
  cancelled: 'Cancelled',
  hidden: 'Removed',
};

/** One sentence explaining a non-active listing to someone looking at it. */
export const LISTING_STATUS_EXPLANATION: Record<Exclude<ListingStatus, 'active'>, string> = {
  sold: 'The seller has marked this item as sold.',
  expired: `This listing expired ${LISTING_LIFETIME_DAYS} days after it was posted and is no longer on the browse page.`,
  cancelled: 'The seller took this listing down.',
  hidden: 'This listing was removed by the committee.',
};

/**
 * Validates the price field's raw text. Returns the price in pounds, or a message saying what is
 * wrong with it. "Whole pence" means at most two decimal places: 12.5 and 12.50 are fine,
 * 12.505 is not, because the server stores pence and would have to round it silently.
 */
export function parsePrice(raw: string): { price: number; error: null } | { price: null; error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { price: null, error: 'Please enter a price.' };
  }

  const price = Number(trimmed);
  if (!Number.isFinite(price)) {
    return { price: null, error: 'Price must be a number, for example 25 or 12.50.' };
  }
  if (price < PRICE_MIN) {
    return { price: null, error: 'Price must be greater than £0.' };
  }
  if (price > PRICE_MAX) {
    return { price: null, error: 'Price cannot be more than £100,000.' };
  }
  // Compared in pence with a small tolerance: 0.1 + 0.2 style float noise must not reject 12.30.
  const pence = price * 100;
  if (Math.abs(pence - Math.round(pence)) > 1e-6) {
    return { price: null, error: 'Price can have at most two decimal places (whole pence).' };
  }

  return { price: Math.round(pence) / 100, error: null };
}
