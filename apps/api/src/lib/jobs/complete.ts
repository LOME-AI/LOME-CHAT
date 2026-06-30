import { and, eq, sql } from 'drizzle-orm';
import { jobs } from '@hushbox/db';
import type { SQL } from 'drizzle-orm';
import type { DbWriter } from '../idempotency/transaction.js';

/**
 * The completion-fence identity every finishing write must present: the row
 * must still be `running`, held by this claimant, at this claim count. A
 * zombie claimant (lease expired, row re-claimed) matches zero rows — it can
 * neither finish, checkpoint, nor keep a dead lease alive. Writers accept an
 * open transaction so a `txn`-class handler can commit its effect and the
 * terminal transition atomically.
 */
export interface JobFence {
  readonly jobId: string;
  readonly claimedBy: string;
  readonly claims: number;
}

export type JobOkCompletion = 'succeeded' | 'cancelled' | 'lost';
export type JobRepenedCompletion = 'repended' | 'cancelled' | 'lost';
export type JobDeadCompletion = 'dead' | 'cancelled' | 'lost';

export interface JobFailParams {
  readonly error: string;
  readonly backoffSeconds: number;
}

/**
 * Storage cap (characters) for one entry in a job's error history. Error
 * strings are operator diagnostics — codes and summaries per the handler
 * contract, never user content — but a throw stringified from an external
 * call can drag an arbitrary body along; the cap keeps a retry loop from
 * bloating the row, while `errors` keeps one capped entry per attempt.
 */
export const JOB_ERROR_MESSAGE_CAP = 4096;

function fenceCondition(fence: JobFence): SQL | undefined {
  return and(
    eq(jobs.id, fence.jobId),
    eq(jobs.status, 'running'),
    eq(jobs.claimedBy, fence.claimedBy),
    eq(jobs.claims, fence.claims)
  );
}

/** `cancelRequested` at the fence wins over any other terminal state. */
function statusUnlessCancelled(status: 'succeeded' | 'pending' | 'dead'): SQL {
  // status is one of three compile-time literals — safe inside sql.raw.
  const fallback = sql.raw(`'${status}'::job_status`);
  return sql`CASE WHEN ${jobs.cancelRequested} THEN 'cancelled'::job_status ELSE ${fallback} END`;
}

function appendedErrors(fence: JobFence, error: string): SQL {
  const capped = error.slice(0, JOB_ERROR_MESSAGE_CAP);
  // The ::int/::text casts are load-bearing: jsonb_build_object takes "any"
  // arguments, so Postgres cannot infer bind-parameter types without them.
  return sql`${jobs.errors} || jsonb_build_array(jsonb_build_object('at', now()::text, 'claim', ${fence.claims}::int, 'error', ${capped}::text))`;
}

function fenceWriteResult(rows: { status: string }[]): 'applied' | 'cancelled' | 'lost' {
  const row = rows[0];
  if (row === undefined) return 'lost';
  return row.status === 'cancelled' ? 'cancelled' : 'applied';
}

export async function completeOk(
  writer: DbWriter,
  fence: JobFence,
  result: unknown
): Promise<JobOkCompletion> {
  const rows = await writer
    .update(jobs)
    .set({
      status: statusUnlessCancelled('succeeded'),
      result,
      finishedAt: sql`now()`,
    })
    .where(fenceCondition(fence))
    .returning({ status: jobs.status });
  const written = fenceWriteResult(rows);
  return written === 'applied' ? 'succeeded' : written;
}

/**
 * Failure re-pends at the caller-computed backoff; the row keeps its full
 * `{at, claim, error}` history. The claim identity is cleared so the pending
 * row carries no stale lease.
 */
export async function completeFail(
  writer: DbWriter,
  fence: JobFence,
  params: JobFailParams
): Promise<JobRepenedCompletion> {
  const rows = await writer
    .update(jobs)
    .set({
      status: statusUnlessCancelled('pending'),
      failures: sql`${jobs.failures} + 1`,
      nextAttemptAt: sql`now() + make_interval(secs => ${params.backoffSeconds}::double precision)`,
      errors: appendedErrors(fence, params.error),
      claimedAt: null,
      claimedBy: null,
      finishedAt: sql`CASE WHEN ${jobs.cancelRequested} THEN now() ELSE NULL END`,
    })
    .where(fenceCondition(fence))
    .returning({ status: jobs.status });
  const written = fenceWriteResult(rows);
  return written === 'applied' ? 'repended' : written;
}

/**
 * Checkpoint: re-pend immediately with the updated payload and neutralize
 * this execution's claim increment — yields never consume retries. The write
 * passes the same fence as terminal writes, and `cancelRequested` is honored
 * here, so a cancel lands at the next checkpoint boundary.
 */
export async function completeYield(
  writer: DbWriter,
  fence: JobFence,
  checkpoint: unknown
): Promise<JobRepenedCompletion> {
  const rows = await writer
    .update(jobs)
    .set({
      status: statusUnlessCancelled('pending'),
      payload: checkpoint,
      claims: sql`${jobs.claims} - 1`,
      nextAttemptAt: sql`now()`,
      claimedAt: null,
      claimedBy: null,
      finishedAt: sql`CASE WHEN ${jobs.cancelRequested} THEN now() ELSE NULL END`,
    })
    .where(fenceCondition(fence))
    .returning({ status: jobs.status });
  const written = fenceWriteResult(rows);
  return written === 'applied' ? 'repended' : written;
}

export async function completeDead(
  writer: DbWriter,
  fence: JobFence,
  error: string
): Promise<JobDeadCompletion> {
  const rows = await writer
    .update(jobs)
    .set({
      status: statusUnlessCancelled('dead'),
      errors: appendedErrors(fence, error),
      finishedAt: sql`now()`,
    })
    .where(fenceCondition(fence))
    .returning({ status: jobs.status });
  const written = fenceWriteResult(rows);
  return written === 'applied' ? 'dead' : written;
}

/**
 * Fenced lease touch for long-running handlers: refreshes `claimedAt` so the
 * lease stays live. A zombie's heartbeat matches zero rows.
 */
export async function heartbeatJob(writer: DbWriter, fence: JobFence): Promise<'alive' | 'lost'> {
  const rows = await writer
    .update(jobs)
    .set({ claimedAt: sql`now()` })
    .where(fenceCondition(fence))
    .returning({ id: jobs.id });
  return rows.length === 1 ? 'alive' : 'lost';
}
