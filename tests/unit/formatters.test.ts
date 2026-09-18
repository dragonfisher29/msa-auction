import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildWhatsAppUrl,
  formatCurrency,
  formatCurrencyPrecise,
  formatTimeRemaining,
  formatTimestamp,
} from '../../src/lib/formatters';

describe('formatCurrency', () => {
  it('formats a whole pound amount with the £ symbol and no decimals', () => {
    expect(formatCurrency(1234)).toBe('£1,234');
  });

  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('£0');
  });

  it('rounds fractional amounts to the nearest whole pound', () => {
    expect(formatCurrency(99.5)).toBe('£100');
  });
});

describe('formatCurrencyPrecise', () => {
  it('renders whole pounds with no decimals', () => {
    expect(formatCurrencyPrecise(1234)).toBe('£1,234');
  });

  it('renders £99.50 with pence', () => {
    expect(formatCurrencyPrecise(99.5)).toBe('£99.50');
  });

  it('renders £100.01 with pence', () => {
    expect(formatCurrencyPrecise(100.01)).toBe('£100.01');
  });

  it('keeps thousands separators for large values', () => {
    expect(formatCurrencyPrecise(1234567.5)).toBe('£1,234,567.50');
  });
});

describe('formatTimeRemaining', () => {
  const NOW = new Date('2026-01-01T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports an already-ended auction', () => {
    const info = formatTimeRemaining(NOW - 1000);
    expect(info).toEqual({
      formatted: 'Auction Ended',
      isEnded: true,
      isUrgent: false,
      hours: 0,
      minutes: 0,
      seconds: 0,
    });
  });

  it('reports an auction ending exactly now as ended', () => {
    const info = formatTimeRemaining(NOW);
    expect(info.isEnded).toBe(true);
  });

  it('formats a countdown under a minute without an hours segment, and flags it urgent', () => {
    const info = formatTimeRemaining(NOW + 30 * 1000);
    expect(info.isEnded).toBe(false);
    expect(info.isUrgent).toBe(true);
    expect(info.hours).toBe(0);
    expect(info.minutes).toBe(0);
    expect(info.seconds).toBe(30);
    expect(info.formatted).toBe('00m 30s');
  });

  it('formats a countdown of several hours with a zero-padded hours segment', () => {
    const diffMs = ((2 * 3600) + (5 * 60) + 10) * 1000;
    const info = formatTimeRemaining(NOW + diffMs);
    expect(info.isEnded).toBe(false);
    expect(info.isUrgent).toBe(false);
    expect(info.hours).toBe(2);
    expect(info.minutes).toBe(5);
    expect(info.seconds).toBe(10);
    expect(info.formatted).toBe('2h 05m 10s');
  });

  it('formats a countdown of multiple days as an hours count beyond 24', () => {
    const diffMs = ((2 * 24 * 3600) + (3 * 60)) * 1000; // 2 days and 3 minutes
    const info = formatTimeRemaining(NOW + diffMs);
    expect(info.isEnded).toBe(false);
    expect(info.isUrgent).toBe(false);
    expect(info.hours).toBe(48);
    expect(info.minutes).toBe(3);
    expect(info.seconds).toBe(0);
    expect(info.formatted).toBe('48h 03m 00s');
  });

  it('flags anything under 5 minutes remaining as urgent, and anything at or above as not urgent', () => {
    expect(formatTimeRemaining(NOW + (5 * 60 * 1000) - 1).isUrgent).toBe(true);
    expect(formatTimeRemaining(NOW + (5 * 60 * 1000)).isUrgent).toBe(false);
  });
});

describe('formatTimestamp', () => {
  it('renders a locale time string with hours, minutes, and seconds', () => {
    const result = formatTimestamp(new Date('2026-01-01T22:13:20.000Z').getTime());
    expect(result).toMatch(/^\d{1,2}:\d{2}:\d{2}\s?([ap]\.?m\.?)?$/i);
  });

  it('matches the same locale formatting the implementation delegates to', () => {
    const ts = 1700000000000;
    const expected = new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    expect(formatTimestamp(ts)).toBe(expected);
  });
});

describe('buildWhatsAppUrl', () => {
  it('strips spaces and dashes from a formatted number', () => {
    expect(buildWhatsAppUrl('60 12-345 6789')).toBe('https://wa.me/60123456789');
  });

  it('strips a leading + from an international number', () => {
    expect(buildWhatsAppUrl('+60 12-345 6789')).toBe('https://wa.me/60123456789');
  });

  it('strips parentheses and any other punctuation', () => {
    expect(buildWhatsAppUrl('+44 (0)7700 900.000')).toBe('https://wa.me/4407700900000');
  });

  it('returns null for a number shorter than 8 digits', () => {
    expect(buildWhatsAppUrl('+60 12-345')).toBeNull();
  });

  // Legacy rows stored a local number with a trunk-prefix zero and no country code. wa.me would
  // accept the URL and then show "invalid number", so the helper rejects it and the caller hides
  // the button instead.
  it('returns null for a legacy local number with a single leading zero', () => {
    expect(buildWhatsAppUrl('0123456789')).toBeNull();
  });

  it('returns null for a formatted legacy local number with a single leading zero', () => {
    expect(buildWhatsAppUrl('012-345 6789')).toBeNull();
  });

  it('strips the ITU 00 international prefix, which wa.me rejects just like +', () => {
    expect(buildWhatsAppUrl('0060 12 345 6789')).toBe('https://wa.me/60123456789');
  });

  it('treats a 00-prefixed number the same as the + form of the same number', () => {
    expect(buildWhatsAppUrl('00 44 7700 900111')).toBe(buildWhatsAppUrl('+44 7700 900111'));
  });

  it('applies the 8-digit floor after stripping 00, not before', () => {
    // Eight characters, but only a six-digit number once the prefix is gone.
    expect(buildWhatsAppUrl('00123456')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(buildWhatsAppUrl('')).toBeNull();
  });

  it('returns null for a string with no digits at all', () => {
    expect(buildWhatsAppUrl('call me maybe')).toBeNull();
  });

  it('appends a percent-encoded text query when a message is given', () => {
    expect(buildWhatsAppUrl('+60123456789', 'Hi Sam, I\'m interested in your "Camera" listing.')).toBe(
      `https://wa.me/60123456789?text=${encodeURIComponent('Hi Sam, I\'m interested in your "Camera" listing.')}`,
    );
  });

  it('omits the text query when the message is an empty string', () => {
    expect(buildWhatsAppUrl('+60123456789', '')).toBe('https://wa.me/60123456789');
  });
});
