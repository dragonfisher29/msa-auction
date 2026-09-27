import { describe, it, expect } from 'vitest';
import { getListingStatus, isListingAvailable, parsePrice } from '../../src/lib/listing';
import { PLACEHOLDER_IMAGE_URL } from '../../src/lib/placeholder';
import type { AuctionItem } from '../../src/types';

const NOW = new Date('2026-03-01T12:00:00.000Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

function makeListing(overrides: Partial<AuctionItem> = {}): AuctionItem {
  return {
    id: 'auc_1',
    title: 'Desk Lamp',
    description: 'Works fine.',
    price: 10,
    sellerId: 'seller_1',
    sellerName: 'Sam Seller',
    status: 'active',
    expiresAt: NOW + 10 * DAY,
    soldAt: null,
    createdAt: NOW - 20 * DAY,
    ...overrides,
  };
}

describe('getListingStatus / isListingAvailable', () => {
  it('passes the server status straight through', () => {
    expect(getListingStatus(makeListing(), NOW)).toBe('active');
    expect(getListingStatus(makeListing({ status: 'sold', soldAt: NOW - DAY }), NOW)).toBe('sold');
    expect(getListingStatus(makeListing({ status: 'expired' }), NOW)).toBe('expired');
    expect(getListingStatus(makeListing({ status: 'cancelled' }), NOW)).toBe('cancelled');
  });

  it('treats a still-"active" row whose expiresAt has passed as expired', () => {
    const lapsed = makeListing({ expiresAt: NOW - 1 });
    expect(getListingStatus(lapsed, NOW)).toBe('expired');
    expect(isListingAvailable(lapsed, NOW)).toBe(false);
  });

  it('only an active, unexpired listing is available', () => {
    expect(isListingAvailable(makeListing(), NOW)).toBe(true);
    expect(isListingAvailable(makeListing({ status: 'sold' }), NOW)).toBe(false);
    expect(isListingAvailable(makeListing({ status: 'hidden' }), NOW)).toBe(false);
  });
});

describe('parsePrice', () => {
  it('accepts whole pounds and whole pence', () => {
    expect(parsePrice('25')).toEqual({ price: 25, error: null });
    expect(parsePrice('12.5')).toEqual({ price: 12.5, error: null });
    expect(parsePrice(' 12.50 ')).toEqual({ price: 12.5, error: null });
    expect(parsePrice('0.01')).toEqual({ price: 0.01, error: null });
    expect(parsePrice('100000')).toEqual({ price: 100000, error: null });
  });

  it('is not fooled by float noise on two-decimal values', () => {
    expect(parsePrice('0.29').error).toBeNull();
    expect(parsePrice('19.99').error).toBeNull();
    expect(parsePrice('1234.56').error).toBeNull();
  });

  it('rejects empty, non-numeric, zero, negative and over-cap values with a reason', () => {
    expect(parsePrice('').error).toMatch(/enter a price/i);
    expect(parsePrice('abc').error).toMatch(/must be a number/i);
    expect(parsePrice('0').error).toMatch(/greater than £0/i);
    expect(parsePrice('-5').error).toMatch(/greater than £0/i);
    expect(parsePrice('100000.01').error).toMatch(/more than £100,000/i);
  });

  it('rejects fractions of a penny', () => {
    expect(parsePrice('12.505').error).toMatch(/two decimal places/i);
  });
});

describe('PLACEHOLDER_IMAGE_URL', () => {
  it('is an inline image, never a third-party host', () => {
    expect(PLACEHOLDER_IMAGE_URL.startsWith('data:image/svg+xml')).toBe(true);
    // The SVG namespace URI is an identifier, not a fetch; anything else would be a request.
    const svg = decodeURIComponent(PLACEHOLDER_IMAGE_URL).replace('http://www.w3.org/2000/svg', '');
    expect(svg).not.toMatch(/https?:/i);
  });
});
