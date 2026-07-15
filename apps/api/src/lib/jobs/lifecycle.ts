import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { jobs } from '@hushbox/db';
import type { DbWriter } from '../idempotency/transaction.js';
import type { JobShard } from './registry.js';

/**
 * Admin dispositions over the dead inbox. Exactly two exist — redrive and
 * restorable discard — and every write here is an atomic conditional UPDATE:
 * on zero rows the actual state is read and disambiguated (already-done is a
 * no-op, wrong state is a typed refusal), never check-then-act.
 *
 * All three helpers take an open writer/transaction so the admin operation
 * can commit them atomically with its audit row. The dispatcher nudge is
 * caller-side: after the transaction commits, fire `wakeJobDispatcher` for
 * the shard a `redriven` outcome returns (via `waitUntil`, lossy by design —
 * never inside the transaction).
 */

export type RedriveJobResult =
  | { readonly outcome: 'redriven'; readonly shard: JobShard }
  | { readonly outcome: 'already-active' }
  | { readonly outcome: 'refused'; readonly reason: 'not-found' | 'discarded' | 'not-dead' };

/**
 * Revives a dead, undiscarded row for exactly one more retry cycle. Per the
 * documented redrive contract, `status`, `claims`, `failures`, and
 * `nextAttemptAt` reset together — a status-only redrive would be instantly
 * re-dead-lettered by the spent budgets. A stale cancel request is cleared
 * (the sweep would otherwise cancel the row before it ran) and the claim
 * identity dropped; the `errors` history is kept — it is the audit trail.
 * A discarded row refuses: it must be restored to the inbox first.
 */
export async function redriveJob(writer: DbWriter, jobId: string): Promise<RedriveJobResult> {
  const rows = await writer
    .update(jobs)
    .set({
      status: 'pending',
      claims: 0,
      failures: 0,
      nextAttemptAt: sql`now()`,
      claimedAt: null,
      claimedBy: null,
      cancelRequested: false,
      finishedAt: null,
    })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'dead'), isNull(jobs.discardedAt)))
    .returning({ shard: jobs.shard });
  const redriven = rows[0];
  if (redriven !== undefined) return { outcome: 'redriven', shard: redriven.shard };
  const actual = await readActualState(writer, jobId);
  if (actual === undefined) return { outcome: 'refused', reason: 'not-found' };
  if (actual.discardedAt !== null) return { outcome: 'refused', reason: 'discarded' };
  if (actual.status === 'pending' || actual.status === 'running') {
    return { outcome: 'already-active' };
  }
  if (actual.status === 'succeeded' || actual.status === 'cancelled') {
    return { outcome: 'refused', reason: 'not-dead' };
  }
  // dead + undiscarded after a zero-row conditional UPDATE: only a concurrent
  // restore committing in the read-committed gap can produce it — a defect
  // signal worth surfacing over silently mislabeling the state.
  throw new Error(`redriveJob: job ${jobId} transitioned concurrently; retry`);
}

export type DiscardJobResult = 'discarded' | 'already-discarded' | 'not-found' | 'not-dead';

/**
 * The restorable discard marker (never a delete): a discarded row leaves the
 * dead inbox and prunes on retention; the admin audit row is the permanent
 * record. Only a dead row can be discarded; already-discarded is a no-op
 * that keeps the original timestamp (the retention clock never restarts).
 */
export async function discardJob(writer: DbWriter, jobId: string): Promise<DiscardJobResult> {
  const rows = await writer
    .update(jobs)
    .set({ discardedAt: sql`now()` })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'dead'), isNull(jobs.discardedAt)))
    .returning({ id: jobs.id });
  if (rows.length === 1) return 'discarded';
  const actual = await readActualState(writer, jobId);
  if (actual === undefined) return 'not-found';
  if (actual.discardedAt !== null) return 'already-discarded';
  return 'not-dead';
}

export type RestoreJobResult = 'restored' | 'not-discarded' | 'not-found';

/**
 * Undoes a discard: the row returns to the plain dead inbox, budgets and
 * history untouched. Restore never redrives — running the job again is a
 * separate, explicit `redriveJob`.
 */
export async function restoreJob(writer: DbWriter, jobId: string): Promise<RestoreJobResult> {
  const rows = await writer
    .update(jobs)
    .set({ discardedAt: null })
    .where(and(eq(jobs.id, jobId), isNotNull(jobs.discardedAt)))
    .returning({ id: jobs.id });
  if (rows.length === 1) return 'restored';
  const actual = await readActualState(writer, jobId);
  return actual === undefined ? 'not-found' : 'not-discarded';
}

interface ActualState {
  readonly status: 'pending' | 'running' | 'succeeded' | 'cancelled' | 'dead';
  readonly discardedAt: Date | null;
}

async function readActualState(writer: DbWriter, jobId: string): Promise<ActualState | undefined> {
  const rows = await writer
    .select({ status: jobs.status, discardedAt: jobs.discardedAt })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  return rows[0];
}
