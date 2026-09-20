/**
 * Client-side read/dismissed state for in-app notifications.
 *
 * The API has no notion of "read" (see the contract: read state is client-side only), so it
 * lives in localStorage next to the watchlist. Two differences from the watchlist at
 * `App.tsx`, both deliberate:
 *
 *  1. The key is scoped per user id. The watchlist uses one global key, so two accounts on the
 *     same browser share it; notifications must not inherit that bug.
 *  2. It is cleared on logout (see `clearReadNotificationIds`), for the same reason.
 *
 * Every accessor is defensive: localStorage can throw (private mode, blocked site data) and
 * the stored value can be anything a previous version wrote, so a bad read degrades to "no
 * notifications have been read" rather than taking the header down.
 */

const KEY_PREFIX = 'msa_notification_read_ids';

/** The storage key for one user. Exported so tests and logout can address it directly. */
export function notificationReadIdsKey(userId: string): string {
  return `${KEY_PREFIX}_${userId}`;
}

export function loadReadNotificationIds(userId: string): string[] {
  try {
    const raw = localStorage.getItem(notificationReadIdsKey(userId));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function saveReadNotificationIds(userId: string, ids: string[]): void {
  try {
    localStorage.setItem(notificationReadIdsKey(userId), JSON.stringify(ids));
  } catch {
    // Storage being unavailable only costs the user a badge that reappears; never fatal.
  }
}

/** Called on logout so the next account on this browser starts with its own unread state. */
export function clearReadNotificationIds(userId: string): void {
  try {
    localStorage.removeItem(notificationReadIdsKey(userId));
  } catch {
    // ignore
  }
}
