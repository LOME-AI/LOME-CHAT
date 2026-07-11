import { purgeTerminalIdempotencyKeys } from '../lib/idempotency/index.js';
import { pruneSucceededJobs } from '../lib/jobs/index.js';
import { purgeExpiredAccountDeletionEvents } from './deletion-events-purge.js';
import type { DbWriter } from '../lib/idempotency/transaction.js';
import type { CronEntry } from './cron.js';

/**
 * Daily retention deletes. Each pass drains bounded batches with a hard
 * per-pass cap, so a backlog never holds long locks and never runs
 * unbounded; whatever a capped pass leaves, the next day's pass takes.
 * Read paths never depend on any of these having run.
 */

export const RETENTION_BATCH_SIZE = 500;

export const RETENTION_MAX_BATCHES = 10;

export type RetentionStep = (batchSize: number) => Promise<number>;

export async function drainRetentionBatches(
  step: RetentionStep,
  batchSize: number
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
    const deleted = await step(batchSize);
    total += deleted;
    if (deleted < batchSize) break;
  }
  return total;
}

export function createRetentionEntry(name: string, step: RetentionStep): CronEntry {
  return {
    name,
    run: async (): Promise<void> => {
      await drainRetentionBatches(step, RETENTION_BATCH_SIZE);
    },
  };
}

export interface RetentionSteps {
  readonly purgeIdempotencyKeys: RetentionStep;
  readonly pruneSucceededJobs: RetentionStep;
  readonly purgeDeletionEvents: RetentionStep;
}

/** Binds the owning modules' retention deletes to a live database handle. */
export function createRetentionSteps(db: DbWriter): RetentionSteps {
  return {
    purgeIdempotencyKeys: (batchSize) => purgeTerminalIdempotencyKeys(db, { batchSize }),
    pruneSucceededJobs: (batchSize) => pruneSucceededJobs(db, { batchSize }),
    purgeDeletionEvents: (batchSize) => purgeExpiredAccountDeletionEvents(db, { batchSize }),
  };
}
