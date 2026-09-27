import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildWhatsAppUrl,
  formatExpiresIn,
  formatListedAgo,
  formatPrice,
  formatTimeRemaining,
} from '../../src/lib/formatters';

describe('formatPrice', () => {
  it('renders whole pounds with no decimals', () => {
    expect(formatPrice(1234)).toBe('£1,234');
  });

  it('formats zero', () => {
    expect(formatPrice(0)).toBe('£0');
  });

  it('never rounds pence away: £99.50 stays £99.50, not £100', () => {
    expect(formatPrice(99.5)).toBe('£99.50');
  });

  it('renders £100.01 with pence', () => {
    expect(formatPrice(100.01)).toBe('£100.01');
  });

  it('keeps thousands separators for large values', () => {
    expect(formatPrice(1234567.5)).toBe('£1,234,567.50');
  });
});

describe('formatListedAgo / formatExpiresIn', () => {
  const NOW = new Date('2026-01-31T12:00:00.000Z').getTime();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it('says "today" for anything under a day old', () => {
    expect(formatListedAgo(NOW - 23 * HOUR, NOW)).toBe('Listed today');
    expect(formatListedAgo(NOW, NOW)).toBe('Listed today');
  });

  it('uses the singular for exactly one day and the plural beyond it', () => {
    expect(formatListedAgo(NOW - DAY, NOW)).toBe('Listed 1 day ago');
    expect(formatListedAgo(NOW - 12 * DAY - 5 * HOUR, NOW)).toBe('Listed 12 days ago');
  });

  it('never goes negative for a createdAt slightly in the future (clock skew)', () => {
    expect(formatListedAgo(NOW + 5 * 60 * 1000, NOW)).toBe('Listed today');
  });

  it('rounds the time left up to whole days', () => {
    expect(formatExpiresIn(NOW + 29 * DAY + HOUR, NOW)).toBe('Expires in 30 days');
    expect(formatExpiresIn(NOW + 36 * HOUR, NOW)).toBe('Expires in 2 days');
  });

  it('says "within a day" under 24 hours and "Expired" once past', () => {
    expect(formatExpiresIn(NOW + 3 * HOUR, NOW)).toBe('Expires within a day');
    expect(formatExpiresIn(NOW - 1, NOW)).toBe('Expired');
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

  it('reports an already-passed deadline as ended', () => {
    const info = formatTimeRemaining(NOW - 1000);
    expect(info).toEqual({
      formatted: 'Ended',
      isEnded: true,
      isUrgent: false,
      hours: 0,
      minutes: 0,
      seconds: 0,
    });
  });

  it('reports a deadline of exactly now as ended', () => {
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
