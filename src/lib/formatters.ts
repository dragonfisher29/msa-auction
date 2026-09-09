export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
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
