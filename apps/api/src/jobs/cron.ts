import type { ResultAsync } from '../lib/result/index.js';
import type { DomainError } from '../lib/errors/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

/**
 * One unit of scheduled work. Entries are isolated by the runner: one
 * entry's failure never stops its cadence siblings, and a failure is a
 * telemetry event, never a thrown scheduled-handler error (Workers would
 * retry nothing useful — every entry is idempotent and re-runs next tick).
 */
export interface CronEntry {
  /** Rides the `jobType` structured-log field on failure; content-free. */
  readonly name: string;
  readonly run: () => Promise<void>;
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export async function runCronEntries(
  entries: readonly CronEntry[],
  telemetry: Telemetry
): Promise<void> {
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await entry.run();
      } catch (error) {
        telemetry.error('cron entry failed', {
          jobType: entry.name,
          errorCode: 'cron_entry_failed',
        });
        telemetry.captureError(toError(error), 'cron_entry_failed');
      }
    })
  );
}

/**
 * Bridges a domain `Result` into a cron entry's throw-based failure channel.
 * The thrown message is the domain code (codes, never content); the full
 * domain error rides `cause` for the Telemetry port's scrubbed capture.
 */
export async function runOrThrow<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  const settled = await result;
  if (settled.isErr()) {
    throw new Error(settled.error.code, { cause: settled.error });
  }
  return settled.value;
}
