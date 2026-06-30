import { sql } from 'drizzle-orm';
import { jobs } from '@hushbox/db';
import { backoffSeconds } from './backoff.js';
import {
  batchSizeForShard,
  claimBatch,
  deadLetterExhausted,
  sweepCancelRequested,
} from './claim.js';
import { completeDead, completeFail, completeOk, completeYield, heartbeatJob } from './complete.js';
import { jobOutcome } from './outcome.js';
import type { Database } from '@hushbox/db';
import type { JobPassExecutor, JobPassResult } from '@hushbox/realtime';
import type { DbWriter } from '../idempotency/transaction.js';
import type { Telemetry } from '../telemetry/index.js';
import type { JobFence } from './complete.js';
import type { JobOutcome } from './outcome.js';
import type { JobRegistry, JobRow, JobShard } from './registry.js';

/**
 * The dispatcher's executor core: one pass = sweep cancels, dead-letter
 * exhausted rows, claim a batch, execute with per-job lease timeouts,
 * complete through the fence — then advise the next alarm. Plain module by
 * design (thin-shell doctrine); the JobDispatcher DO calls this through
 * `@hushbox/realtime`'s core.
 */

/** Floor on the re-arm delay; sub-floor advice would busy-spin the alarm. */
export const MIN_REARM_DELAY_MS = 250;

export interface JobExecutorDeps {
  /**
   * Scopes a fresh Database to one pass (fresh Neon connection per
   * invocation; the production binding closes the pool afterwards).
   */
  withDb<T>(use: (db: Database) => Promise<T>): Promise<T>;
  readonly registry: JobRegistry;
  readonly telemetry: Telemetry;
  /** Completion-fence identity; unique per dispatcher instance. */
  readonly claimantId: string;
  /** Jitter source for retry backoff — injected so tests can seed it. */
  readonly random: () => number;
  readonly now: () => number;
  /**
   * Wall budget for drain chaining: when claims keep returning full batches
   * past this, the pass yields and advises an immediate re-fire instead of
   * running into the platform's alarm wall cap.
   */
  readonly passBudgetMs: number;
}

/**
 * Converts the Postgres-computed re-arm interval (epoch seconds of
 * `min(next attempt) - now()`) to milliseconds. The interval arrives from
 * the database clock, never from comparing PG timestamps to the DO clock.
 */
export function rearmDelayMs(epochSeconds?: string | number | null): number | undefined {
  if (epochSeconds === null || epochSeconds === undefined) return undefined;
  const seconds = typeof epochSeconds === 'number' ? epochSeconds : Number(epochSeconds);
  if (Number.isNaN(seconds)) {
    throw new TypeError(
      `jobs pass: non-numeric re-arm delay from Postgres: ${String(epochSeconds)}`
    );
  }
  return Math.max(MIN_REARM_DELAY_MS, Math.ceil(seconds * 1000));
}

function parseShard(shard: string): JobShard {
  if (shard === 'default' || shard === 'bulk') return shard;
  throw new Error(
    `jobs pass: unknown shard ${JSON.stringify(shard)} — dispatcher DOs are named default|bulk`
  );
}

async function invokeHandler(
  handler: (execution: never) => Promise<JobOutcome>,
  execution: unknown
): Promise<JobOutcome> {
  try {
    return await handler(execution as never);
  } catch (error) {
    return jobOutcome.fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Races the handler against its lease-derived execution timeout so a hung
 * handler cannot eat the pass. The loser is abandoned, not killed: any late
 * write it attempts goes through the completion fence and loses there.
 */
async function raceLease(
  invocation: Promise<JobOutcome>,
  leaseMs: number
): Promise<JobOutcome | 'lease-timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'lease-timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('lease-timeout');
    }, leaseMs);
  });
  try {
    return await Promise.race([invocation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function nextScheduledDelayMs(db: Database, shard: JobShard): Promise<number | undefined> {
  // Schedulable work = pending rows at their nextAttemptAt and running rows
  // at their lease expiry (a crashed claimant's row becomes claimable then).
  const result = await db.execute(sql`
    SELECT extract(epoch FROM least(
      min(${jobs.nextAttemptAt}) FILTER (WHERE ${jobs.status} = 'pending' AND NOT ${jobs.cancelRequested}),
      min(${jobs.claimedAt} + make_interval(secs => ${jobs.leaseSeconds})) FILTER (WHERE ${jobs.status} = 'running')
    ) - now()) AS delay_seconds
    FROM ${jobs}
    WHERE ${jobs.shard} = ${shard} AND ${jobs.status} IN ('pending', 'running')
  `);
  const row = result.rows[0] as { delay_seconds: string | number | null } | undefined;
  return rearmDelayMs(row?.delay_seconds);
}

export function createJobExecutor(deps: JobExecutorDeps): JobPassExecutor {
  const { registry, telemetry, claimantId, random, now, passBudgetMs } = deps;

  async function executeOne(db: Database, job: JobRow): Promise<void> {
    const fence: JobFence = { jobId: job.id, claimedBy: claimantId, claims: job.claims };
    const registration = registry.get(job.type);
    if (registration === undefined) {
      await completeDead(db, fence, 'unregistered job type');
      telemetry.error('job dead-lettered: unregistered type', {
        jobId: job.id,
        jobType: job.type,
      });
      telemetry.captureError(new Error('job dead-lettered: unregistered type'), 'job_dead_letter');
      return;
    }
    const parsed = registration.schema.safeParse(job.payload);
    if (!parsed.success) {
      await completeDead(db, fence, 'payload failed its registered schema');
      telemetry.error('job dead-lettered: unparseable payload', {
        jobId: job.id,
        jobType: job.type,
      });
      telemetry.captureError(
        new Error('job dead-lettered: unparseable payload'),
        'job_dead_letter'
      );
      return;
    }
    const execution = {
      jobId: job.id,
      payload: parsed.data,
      claims: job.claims,
      heartbeat: () => heartbeatJob(db, fence),
      completeWithinTx: async (writer: DbWriter, result: unknown = null): Promise<JobOutcome> => {
        const written = await completeOk(writer, fence, result);
        if (written === 'lost') {
          // Thrown, not returned: aborting the handler's transaction is what
          // keeps a zombie's effect from committing without its transition.
          throw new Error('job completion lost the fence: this claimant is a zombie');
        }
        return { kind: 'completed', completion: written };
      },
    };
    const raced = await raceLease(
      invokeHandler(registration.handler, execution),
      job.leaseSeconds * 1000
    );
    const outcome =
      raced === 'lease-timeout'
        ? jobOutcome.fail('lease timeout: handler exceeded its leaseSeconds')
        : raced;
    // A txn-class handler already wrote the fenced terminal transition in its
    // own transaction; a second write here would miss the consumed fence and
    // pollute the genuine zombie signal below.
    if (outcome.kind === 'completed') return;
    const completion = await completeForOutcome(db, fence, job, outcome);
    if (completion === 'lost') {
      telemetry.warn('job completion lost the fence', { jobId: job.id, jobType: job.type });
    }
  }

  async function executeOneObserved(db: Database, job: JobRow): Promise<void> {
    try {
      await executeOne(db, job);
    } catch (error) {
      // executeOne rejects only when a completion write fails; the row's
      // lease already makes it reclaimable, so telemetry is the entire
      // response — a retry here would be a second delivery mechanism.
      telemetry.error('job completion write failed', { jobId: job.id, jobType: job.type });
      telemetry.captureError(
        error instanceof Error ? error : new Error(String(error)),
        'job_completion_write_failed'
      );
    }
  }

  async function completeForOutcome(
    db: Database,
    fence: JobFence,
    job: JobRow,
    outcome: Exclude<JobOutcome, { kind: 'completed' }>
  ): Promise<string> {
    switch (outcome.kind) {
      case 'ok': {
        return completeOk(db, fence, outcome.result);
      }
      case 'fail': {
        telemetry.warn('job handler failed', {
          jobId: job.id,
          jobType: job.type,
          attempt: job.claims,
        });
        return completeFail(db, fence, {
          error: outcome.error,
          backoffSeconds: backoffSeconds(job.failures + 1, random),
        });
      }
      case 'yield': {
        return completeYield(db, fence, outcome.checkpoint);
      }
      case 'dead': {
        telemetry.error('job dead-lettered by its handler', {
          jobId: job.id,
          jobType: job.type,
        });
        telemetry.captureError(new Error('job dead-lettered by its handler'), 'job_dead_letter');
        return completeDead(db, fence, outcome.error);
      }
    }
  }

  return {
    // async so a mis-named shard rejects (the DO awaits) instead of throwing
    // through the alarm handler synchronously.
    async runPass(shardName: string): Promise<JobPassResult> {
      const shard = parseShard(shardName);
      return deps.withDb(async (db): Promise<JobPassResult> => {
        const startedAt = now();
        let budgetExhausted = false;
        // Drain chaining: claim another batch immediately while due work
        // remains, bounded by the pass budget.
        for (;;) {
          await sweepCancelRequested(db, shard);
          const deadLettered = await deadLetterExhausted(db, shard);
          for (const dead of deadLettered) {
            telemetry.error('job dead-lettered at claim', { jobId: dead.id, jobType: dead.type });
            telemetry.captureError(new Error('job dead-lettered at claim'), 'job_dead_letter');
          }
          const batch = await claimBatch(db, {
            shard,
            claimantId,
            limit: batchSizeForShard(shard),
          });
          if (batch.length === 0) break;
          await Promise.all(batch.map((job) => executeOneObserved(db, job)));
          if (now() - startedAt >= passBudgetMs) {
            budgetExhausted = true;
            break;
          }
        }
        if (budgetExhausted) return { kind: 'due' };
        const delayMs = await nextScheduledDelayMs(db, shard);
        return delayMs === undefined ? { kind: 'idle' } : { kind: 'scheduled', delayMs };
      });
    },
  };
}
