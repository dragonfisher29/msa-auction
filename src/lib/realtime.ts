/**
 * Lightweight refresh loop for the browse feed.
 *
 * The production server is the Cloudflare Worker in `workers/index.ts`, which only exposes a
 * plain REST API, so fresh data is fetched on a timer. Every request counts against the free
 * tier's daily budget (100k requests/day, shared by every visitor), so this loop is built to ask
 * as rarely as it can while still feeling current:
 *
 * - One slow periodic refresh while the tab is visible (callers pass the interval; the feed
 *   uses 60s).
 * - Nothing at all while the tab is hidden.
 * - An immediate refresh when the visitor comes back (tab becomes visible, or the window
 *   regains focus) -- that is the moment stale data would actually be seen -- throttled by
 *   `minGapMs` so a quick alt-tab, or the focus + visibilitychange pair most browsers fire
 *   together, costs at most one request.
 */

/** True when the tab is currently hidden (always false outside a DOM environment). */
function isDocumentHidden(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  return document.visibilityState === 'hidden';
}

export interface PollingOptions {
  /**
   * Minimum time since the last run before a focus / visibility event triggers another one.
   * Defaults to the smaller of `intervalMs` and 30s.
   */
  minGapMs?: number;
}

/**
 * Repeatedly runs `fn` and hands the result to `onData`.
 *
 * - The next run is scheduled `intervalMs` after the previous one FINISHES, so requests can
 *   never overlap and a slow response never causes a burst of catch-up calls.
 * - Pauses while the tab is hidden; on becoming visible (or on window focus) it runs straight
 *   away if at least `minGapMs` has passed since the last run.
 * - The first run happens after `intervalMs` (callers do their own initial fetch, which counts
 *   as the "last run" for the `minGapMs` throttle).
 *
 * Returns a stop function that clears the timer and detaches listeners.
 */
export function startPolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  onData: (d: T) => void,
  options: PollingOptions = {},
): () => void {
  const minGapMs = options.minGapMs ?? Math.min(intervalMs, 30_000);
  let isStopped = false;
  let isInFlight = false;
  let lastRunAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, intervalMs);
  };

  const tick = async () => {
    if (isStopped || isInFlight) {
      return;
    }
    // Hidden: stop the clock entirely. `handleWake` restarts it when the visitor comes back.
    if (isDocumentHidden()) {
      return;
    }

    isInFlight = true;
    lastRunAt = Date.now();
    try {
      const data = await fn();
      if (!isStopped) {
        onData(data);
      }
    } catch (err) {
      console.warn('[Realtime] Poll failed:', err);
    } finally {
      isInFlight = false;
      if (!isStopped) {
        schedule();
      }
    }
  };

  const handleWake = () => {
    if (isStopped || isInFlight || isDocumentHidden()) {
      return;
    }
    if (Date.now() - lastRunAt >= minGapMs) {
      void tick();
    } else if (timer === null) {
      // Came back too soon to justify a request, but the clock was stopped while hidden.
      schedule();
    }
  };

  schedule();

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', handleWake);
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', handleWake);
  }

  return () => {
    isStopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', handleWake);
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('focus', handleWake);
    }
  };
}
