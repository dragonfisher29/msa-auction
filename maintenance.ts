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
 * The sweep itself (`cleanupStaleImages`) now lives in `workers/shared.ts`, so
 * the Worker's daily cron and this dev-server path run the exact same code
 * instead of two copies that could quietly drift - see `scheduled()` in
 * `workers/index.ts` for the Worker side. This file re-exports it, plus the
 * repeating-timer wrapper (`startStaleImageCleanup`) that only ever made sense
 * for a long-lived Node process, not a Worker invocation.
 */
import {
  cleanupStaleImages,
  isStaleImageCleanupEnabled,
  STALE_IMAGE_CLEANUP_BATCH_LIMIT,
  STALE_IMAGE_CLEANUP_ENV,
  STALE_IMAGE_GRACE_MS,
} from './workers/shared';

export {
  cleanupStaleImages,
  isStaleImageCleanupEnabled,
  STALE_IMAGE_CLEANUP_BATCH_LIMIT,
  STALE_IMAGE_CLEANUP_ENV,
  STALE_IMAGE_GRACE_MS,
};

/* -------------------------------------------------------------------------- */
/* Stale image cleanup - the repeating local sweep                            */
/* -------------------------------------------------------------------------- */

/**
 * WHY THIS IS BEHIND A FLAG, AND WHY THE FLAG DEFAULTS TO OFF (LOCALLY).
 *
 * `cleanupStaleImages` finds every ended/cancelled/hidden listing whose
 * `end_time` is more than 30 days ago and still has images, and blanks
 * `image_url`/`image_urls` on it. It is a real DELETE of the only copy of
 * those photos:
 *
 *   - Images are base64 `data:` URLs inside Postgres. The row IS the image.
 *     There is no object store holding a second copy, and no backup.
 *   - `.env` and `.dev.vars` point at the SAME Supabase project `wrangler.toml`
 *     does. There is no separate development database. "Local" here means the
 *     process is local; the data it writes to is production.
 *
 * `wrangler.toml` now runs this sweep daily in production on purpose (see
 * `[vars] ENABLE_STALE_IMAGE_CLEANUP` there, and `scheduled()` in
 * `workers/index.ts`) - that is a deliberate, owner-approved retention policy,
 * not the accident this comment is about. The accident was `npm run dev` or
 * `npm start` on a laptop running the SAME sweep against the SAME database
 * unprompted, on every startup, with no way to undo it.
 *
 * So locally it still runs only when someone asks for it by name: set
 * ENABLE_STALE_IMAGE_CLEANUP=true in `.env`. That variable is read from
 * `process.env` here, never from `wrangler.toml`, so enabling the Worker's
 * daily cron does not also turn this on for whoever's laptop happens to run
 * `npm run dev` next.
 */
export const STALE_IMAGE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
      `[Maintenance] Stale image cleanup is DISABLED on this local server. Ended/cancelled/hidden listings ` +
        `keep their photos. Set ${STALE_IMAGE_CLEANUP_ENV}=true in .env to enable it here too -- it permanently ` +
        `deletes photos, more than 30 days after a listing ends, from the Supabase project this server is ` +
        `pointed at, and there is no backup to restore them from. (This is separate from the Worker's own daily ` +
        `cron, which already runs this sweep in production.)`,
    );
    return { enabled: false, timer: null };
  }

  log(
    `[Maintenance] Stale image cleanup is ENABLED via ${STALE_IMAGE_CLEANUP_ENV}. Photos on ended/cancelled/hidden ` +
      `listings more than 30 days past their end_time will be deleted now and every 6 hours. This cannot be undone.`,
  );

  void cleanupStaleImages(options.supabase);
  const timer = setTimer(() => {
    void cleanupStaleImages(options.supabase);
  }, STALE_IMAGE_CLEANUP_INTERVAL_MS);

  return { enabled: true, timer };
}
