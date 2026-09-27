const DAY_MS = 24 * 60 * 60 * 1000;

// A listing's asking price. Shows pence only when the amount actually has a fractional part:
// £25 stays "£25", but £12.50 must never be rounded to "£13" -- it is the exact price a buyer
// will be asked to pay.
export function formatPrice(amount: number): string {
  // Intl's minimumFractionDigits is static, so it can't drop trailing pence on its own
  // (99.50 would render as "£99.5"). Decide the minimum from the actual value instead:
  // whole pounds get no decimals, anything with pence gets exactly two.
  const hasPence = Math.round(amount * 100) % 100 !== 0;
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: hasPence ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatTimeRemaining(endTime: number): {
  formatted: string;
  isEnded: boolean;
  isUrgent: boolean;
  hours: number;
  minutes: number;
  seconds: number;
} {
  const diff = endTime - Date.now();

  if (diff <= 0) {
    return {
      formatted: 'Ended',
      isEnded: true,
      isUrgent: false,
      hours: 0,
      minutes: 0,
      seconds: 0,
    };
  }

  const totalSeconds = Math.floor(diff / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number) => n.toString().padStart(2, '0');
  let formatted = '';

  if (hours > 0) {
    formatted = `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  } else {
    formatted = `${pad(minutes)}m ${pad(seconds)}s`;
  }

  const isUrgent = diff < 5 * 60 * 1000; // less than 5 minutes

  return {
    formatted,
    isEnded: false,
    isUrgent,
    hours,
    minutes,
    seconds,
  };
}

// Whole days between two instants, never negative. Floors, so "23 hours ago" is still today.
function wholeDaysBetween(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / DAY_MS));
}

// "Listed today" / "Listed 1 day ago" / "Listed 12 days ago". Day granularity on purpose: a
// classifieds board has no use for a ticking clock, and a static label needs no timer to
// keep it honest.
export function formatListedAgo(createdAt: number, now: number = Date.now()): string {
  const days = wholeDaysBetween(createdAt, now);
  if (days === 0) {
    return 'Listed today';
  }
  return `Listed ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

// "Expires within a day" / "Expires in 29 days" -- shown on the detail view so the 30-day
// lifetime is never a surprise. Rounds up: 36 hours left reads "in 2 days", not "in 1".
export function formatExpiresIn(expiresAt: number, now: number = Date.now()): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) {
    return 'Expired';
  }
  if (remaining < DAY_MS) {
    return 'Expires within a day';
  }
  return `Expires in ${Math.ceil(remaining / DAY_MS)} days`;
}

// Locale date + time. The moderation queue needs the date as well as the time -- a report can
// sit there for a week.
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// wa.me needs a bare international number: digits only, no '+', no '00' prefix, no spaces or
// punctuation. Sellers are required to enter their own country code at listing time, so nothing
// is prefixed here -- guessing one would silently send buyers to the wrong number.
//
// Every rejection below returns null rather than a best-effort link. A button that opens
// WhatsApp only to land on "invalid number" is worse than no button at all, and the callers
// hide themselves on null, so the graceful path costs nothing.
export function buildWhatsAppUrl(phoneNumber: string, message?: string): string | null {
  const digits = (phoneNumber || '').replace(/\D/g, '');

  // A single leading zero is a national trunk prefix (e.g. the legacy "0123456789" rows stored
  // before the create form required a country code), which means the country code is missing --
  // unrecoverable here. A leading "00" is the ITU international prefix and is fine. The test is
  // on the digits-only string so "00 44 7700 900111" still reads as international.
  if (/^0(?!0)/.test(digits)) {
    return null;
  }

  // wa.me rejects the "00" form as surely as it rejects "+", so normalise it away.
  const international = digits.replace(/^00/, '');

  // Floor applied after normalisation: "00123456" is eight characters but only a six-digit number.
  if (international.length < 8) {
    return null;
  }

  const base = `https://wa.me/${international}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}
