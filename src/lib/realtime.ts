import { apiFetch } from './api';

/**
 * Lightweight polling layer used in place of Socket.io.
 *
 * The production server is the Cloudflare Worker in `workers/index.ts`, which only
 * exposes a plain REST API (no WebSocket / Socket.io endpoint). Everything that used
 * to arrive over a socket is fetched here on a timer instead.
 */

/** True when the tab is currently hidden (always false outside a DOM environment). */
function isDocumentHidden(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  return document.visibilityState === 'hidden';
}

/**
 * Repeatedly runs `fn` every `intervalMs` and hands the result to `onData`.
 *
 * - Never overlaps requests: a tick is skipped while the previous one is still in flight.
 * - Pauses while the tab is hidden, and fires immediately again when it becomes visible.
 * - The first run happens after `intervalMs` (callers do their own initial fetch).
 *
 * Returns a stop function that clears the timer and detaches listeners.
 */
export function startPolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  onData: (d: T) => void,
): () => void {
  let isStopped = false;
  let isInFlight = false;

  const tick = async () => {
    // Skip while stopped, backgrounded, or still waiting on the previous request
    if (isStopped || isInFlight || isDocumentHidden()) {
      return;
    }

    isInFlight = true;
    try {
      const data = await fn();
      if (!isStopped) {
        onData(data);
      }
    } catch (err) {
      console.warn('[Realtime] Poll failed:', err);
    } finally {
      isInFlight = false;
    }
  };

  const handleVisibilityChange = () => {
    if (!isDocumentHidden()) {
      void tick();
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  return () => {
    isStopped = true;
    clearInterval(timer);
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  };
}

/** Pings `/api/health`; resolves true only when the server answers with `status: 'ok'`. */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await apiFetch('/api/health');
    if (!res.ok) {
      return false;
    }
    const data = await res.json();
    return data?.status === 'ok';
  } catch {
    return false;
  }
}
