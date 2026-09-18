export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(amount);
}

// Unlike formatCurrency (which always rounds to whole pounds for dashboard/headline display),
// this shows pence when the amount actually has a fractional part. Used for bid-related
// messages, where a rounded figure can misstate the real threshold or the real amount bid.
export function formatCurrencyPrecise(amount: number): string {
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
      formatted: 'Auction Ended',
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

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
