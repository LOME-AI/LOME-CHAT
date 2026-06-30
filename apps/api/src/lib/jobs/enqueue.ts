import { sql } from 'drizzle-orm';
import { jobs } from '@hushbox/db';
import type { DbWriter } from '../idempotency/transaction.js';
import type { JobRegistry, JobShard } from './registry.js';

export interface EnqueueJobInput {
  readonly type: string;
  readonly payload: unknown;
  readonly shard?: JobShard;
  readonly priority?: number;
  /**
   * "At most one active" per key: the partial unique index only covers
   * pending/running rows, so finished rows never block re-enqueue.
   */
  readonly dedupeKey?: string;
  /** Delayed start: the dispatcher first attempts the job at this instant. */
  readonly scheduledAt?: Date;
}

export type EnqueueJobResult =
  | { readonly enqueued: true; readonly jobId: string }
  | { readonly enqueued: false; readonly reason: 'duplicate-active' };

/**
 * Pattern C's enqueue: an INSERT inside the caller's domain transaction, so
 * job creation is atomic with the work that requires it. Callers nudge the
 * dispatcher with the lossy post-commit `wakeJobDispatcher` — never inside
 * the transaction. An unregistered type or schema-violating payload is a
 * caller bug and throws (aborting the transaction); a dedupe conflict is an
 * expected outcome and never aborts (`ON CONFLICT DO NOTHING`).
 */
export async function enqueueWithinTx(
  tx: DbWriter,
  registry: JobRegistry,
  input: EnqueueJobInput
): Promise<EnqueueJobResult> {
  const registration = registry.get(input.type);
  if (registration === undefined) {
    throw new Error(`enqueueWithinTx: unregistered job type ${JSON.stringify(input.type)}`);
  }
  const parsed = registration.schema.safeParse(input.payload);
  if (!parsed.success) {
    throw new Error(`enqueueWithinTx: payload for ${input.type} failed its registered schema`, {
      cause: parsed.error,
    });
  }
  const insert = tx.insert(jobs).values({
    type: registration.type,
    shard: input.shard ?? registration.shard,
    priority: input.priority ?? 0,
    payload: parsed.data,
    leaseSeconds: registration.leaseSeconds,
    maxFailures: registration.maxFailures,
    maxClaims: registration.maxClaims,
    ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
    ...(input.scheduledAt === undefined
      ? {}
      : { scheduledAt: input.scheduledAt, nextAttemptAt: input.scheduledAt }),
  });
  const rows =
    input.dedupeKey === undefined
      ? await insert.returning({ id: jobs.id })
      : await insert
          .onConflictDoNothing({
            target: jobs.dedupeKey,
            where: sql`${jobs.status} IN ('pending', 'running')`,
          })
          .returning({ id: jobs.id });
  const row = rows[0];
  return row === undefined
    ? { enqueued: false, reason: 'duplicate-active' }
    : { enqueued: true, jobId: row.id };
}
