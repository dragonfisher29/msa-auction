/**
 * DEV-SERVER MAINTENANCE TASKS.
 *
 * This file exists so that `cleanupStaleImages` can be reasoned about and
 * tested on its own. It used to sit inline in `server.ts`, which starts an
 * Express app, a Socket.io server and a Vite dev server the moment it is
 * imported - there was no way to assert anything about it without booting all
 * of that. Now the destructive part and the decision to run it are two separate,
 * importable functions.
 *
 * Nothing here runs in production. The Cloudflare Worker never imports this
 * file; only `server.ts` does.
 */
import { toStringArray } from './workers/shared';

/* -------------------------------------------------------------------------- */
/* Stale image cleanup                                                         */
/* -------------------------------------------------------------------------- */

/**
 * WHY THIS IS BEHIND A FLAG, AND WHY THE FLAG DEFAULTS TO OFF.
 *
 * `cleanupStaleImages` finds every auction created more than 90 days ago and
 * sets `image_url = null`, `image_urls = '[]'`. It is a real DELETE of the only
 * copy of those photos:
 *
 *   - Images are base64 `data:` URLs inside Postgres. The row IS the image.
 *     There is no object store holding a second copy, and no backup.
 *   - `.env`, `.dev.vars` and `wrangler.toml` all point at the SAME Supabase
 *     project. There is no separate development database. "Local" here means
 *     the process is local; the data it writes to is production.
 *
 * Put together: running `npm run dev` or `npm start` on a laptop permanently
 * destroyed the photos on every production listing older than 90 days, on
 * startup, with no prompt and nothing to undo it with.
 *
 * So it now runs only when someone asks for it by name, and asking is a
 * deliberate act: set ENABLE_STALE_IMAGE_CLEANUP=true in the environment. The
 * function itself is unchanged and is kept on purpose - the problem was never
 * what it does, it was that it did it unbidden against live data.
 */
export const STALE_IMAGE_CLEANUP_ENV = 'ENABLE_STALE_IMAGE_CLEANUP';

/** Listings older than this are in scope for the sweep. */
export const STALE_IMAGE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** How often the sweep repeats once enabled. */
export const STALE_IMAGE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * The gate. Only the exact string `true` turns it on.
 *
 * Deliberately strict rather than truthy: `ENABLE_STALE_IMAGE_CLEANUP=false`,
 * `=0` and `=no` must all mean off, and anyone who typed one of those was
 * plainly trying to say off. An unset variable is off, which is the default
 * every developer gets.
 */
export function isStaleImageCleanupEnabled(env: Record<string, string | undefined>): boolean {
  return String(env?.[STALE_IMAGE_CLEANUP_ENV] ?? '').trim().toLowerCase() === 'true';
}

/**
 * Blanks the images on every auction older than `STALE_IMAGE_MAX_AGE_MS`.
 *
 * IRREVERSIBLE. See the note on `STALE_IMAGE_CLEANUP_ENV` above. Call this
 * through `startStaleImageCleanup` rather than directly, so the gate applies.
 */
export async function cleanupStaleImages(supabase: any, now: number = Date.now()): Promise<number> {
  try {
    const ninetyDaysAgo = now - STALE_IMAGE_MAX_AGE_MS;
    const { data, error } = await supabase
      .from('auctions')
      .select('id, created_at, image_url, image_urls')
      .lt('created_at', ninetyDaysAgo);

    if (error || !data) return 0;

    let cleanedCount = 0;
    for (const row of data) {
      const hasMainImage = typeof row.image_url === 'string' && row.image_url.trim().length > 0;
      const imageUrls = toStringArray(row.image_urls);
      if (hasMainImage || imageUrls.length > 0) {
        await supabase
          .from('auctions')
          .update({
            image_url: null,
            image_urls: '[]',
          })
          .eq('id', row.id);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      console.log(`[Maintenance] Cleaned stale images for ${cleanedCount} auction(s) older than 90 days.`);
    }
    return cleanedCount;
  } catch (err) {
    console.error('Failed to clean up stale images:', err);
    return 0;
  }
}

export interface StaleImageCleanupOptions {
  supabase: any;
  /** Defaults to `process.env`. Injected in tests. */
  env?: Record<string, string | undefined>;
  /** Defaults to `console.log`. Injected in tests. */
  log?: (message: string) => void;
  /** Defaults to `setInterval`. Injected in tests. */
  setTimer?: (handler: () => void, intervalMs: number) => unknown;
}

export interface StaleImageCleanupHandle {
  enabled: boolean;
  /** The repeating timer, or null when the sweep is disabled. */
  timer: unknown | null;
}

/**
 * Decides whether the sweep runs, and says so out loud either way.
 *
 * The disabled branch logs on purpose. Silence would leave the next person
 * reading `server.ts` to assume the 6-hourly sweep is still happening, wonder
 * why old listings still have photos, and "fix" it. One line at startup naming
 * the variable is what stops that.
 */
export function startStaleImageCleanup(options: StaleImageCleanupOptions): StaleImageCleanupHandle {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(message));
  const setTimer = options.setTimer ?? ((handler: () => void, intervalMs: number) => setInterval(handler, intervalMs));

  if (!isStaleImageCleanupEnabled(env)) {
    log(
      `[Maintenance] Stale image cleanup is DISABLED. Listings older than 90 days keep their photos. ` +
        `Set ${STALE_IMAGE_CLEANUP_ENV}=true to enable it -- it permanently deletes those photos from the ` +
        `Supabase project this server is pointed at, and there is no backup to restore them from.`,
    );
    return { enabled: false, timer: null };
  }

  log(
    `[Maintenance] Stale image cleanup is ENABLED via ${STALE_IMAGE_CLEANUP_ENV}. Photos on listings older ` +
      `than 90 days will be deleted now and every 6 hours. This cannot be undone.`,
  );

  void cleanupStaleImages(options.supabase);
  const timer = setTimer(() => {
    void cleanupStaleImages(options.supabase);
  }, STALE_IMAGE_CLEANUP_INTERVAL_MS);

  return { enabled: true, timer };
}
