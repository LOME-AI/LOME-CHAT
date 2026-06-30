import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  purgeExpiredDeletionEvents,
  type Database,
} from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { runR2Gc } from './services/gc/r2-gc.js';
import { createMediaStorage } from './services/storage/media-storage.js';
import type { Bindings } from './types.js';

interface ScheduledEventLike {
  cron?: string;
  scheduledTime?: number;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

/**
 * Cloudflare cron handler. Wired into the Worker's default export alongside
 * `fetch` so the platform calls this at the scheduled interval (daily 3am UTC
 * per wrangler.toml).
 *
 * The handler builds its own DB client and storage client (no Hono context
 * available here), runs the GC algorithm, and logs the resulting stats.
 *
 * Errors are logged then re-thrown so Cloudflare records the cron run as
 * failed — the dashboard surfaces failed runs in the cron metrics.
 */
export async function scheduledHandler(
  _event: ScheduledEventLike,
  env: Bindings,
  _ctx: ExecutionContextLike
): Promise<void> {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for the scheduled handler');
  }

  const { isDev, isCI } = createEnvUtilities(env);
  const db: Database = createDb(
    isDev
      ? { connectionString: env.DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG }
      : { connectionString: env.DATABASE_URL }
  );
  const storage = createMediaStorage(env);

  let firstError: Error | undefined;

  try {
    const stats = await runR2Gc({ storage, db, now: Date.now(), evidence: { db, isCI } });
    console.warn('r2-gc', stats);
  } catch (error) {
    console.error('r2-gc failed', error);
    firstError ??= error instanceof Error ? error : new Error(String(error));
  }

  try {
    const purgeStats = await purgeExpiredDeletionEvents(db, new Date());
    console.warn('account-deletion-events-purge', purgeStats);
  } catch (error) {
    console.error('account-deletion-events-purge failed', error);
    firstError ??= error instanceof Error ? error : new Error(String(error));
  }

  if (firstError !== undefined) {
    throw firstError;
  }
}
