import { createR2StorageFromEnv, runMediaGc } from '../slices/media/index.js';
import { createRequestTelemetry } from '../lib/telemetry/index.js';
import { createContentItemReferenceReader } from './media-reference-reader.js';
import { runOrThrow } from './cron.js';
import type { Database } from '@hushbox/db';
import type { EnvContext } from '@hushbox/shared';
import type { MediaGcDeps } from '../slices/media/index.js';
import type { Telemetry, TelemetryEnv } from '../lib/telemetry/index.js';
import type { CronEntry } from './cron.js';

/**
 * The hourly R2 garbage-collection trigger. Deps resolve inside the run so
 * a missing R2 binding fails this entry alone (captured by the runner) and
 * never its cadence siblings.
 */
export function createMediaGcEntry(resolve: () => MediaGcDeps): CronEntry {
  return {
    name: 'media-gc',
    run: async (): Promise<void> => {
      await runOrThrow(runMediaGc(resolve()));
    },
  };
}

export interface ProductionMediaGcArgs {
  readonly env: Parameters<typeof createR2StorageFromEnv>[0] & EnvContext & TelemetryEnv;
  readonly db: Database;
  readonly now: () => Date;
  readonly isCI: boolean;
  /**
   * Sink for per-delete failures. Optional so the cron composition root can
   * pass its already-flushed request telemetry; when omitted it is built from
   * env (the TELEMETRY_SINKS registry value), so the GC pass always has a live
   * capture channel and a failed delete is never silently dropped.
   */
  readonly telemetry?: Pick<Telemetry, 'captureError'>;
}

export function productionMediaGcDeps(args: ProductionMediaGcArgs): MediaGcDeps {
  return {
    storage: createR2StorageFromEnv(args.env, args.db),
    references: createContentItemReferenceReader(args.db),
    now: args.now,
    db: args.db,
    isCI: args.isCI,
    telemetry: args.telemetry ?? createRequestTelemetry(args.env),
  };
}
