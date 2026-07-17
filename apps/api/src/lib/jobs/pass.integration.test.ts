import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
import { eq, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { completeOk } from './complete.js';
import { enqueueWithinTx } from './enqueue.js';
import { jobOutcome } from './outcome.js';
import { createJobExecutor } from './pass.js';
import { createJobRegistry } from './registry.js';
import type { Telemetry } from '../telemetry/index.js';
import type { JobExecution, JobHandler, JobRegistry, JobShard } from './registry.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for jobs integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/**
 * The one committing file in the jobs suite: these tests commit claimable
 * rows, and only on the `default` shard. The contract with the parallel
 * rollback files: they scope every assertion to rows they own and keep
 * their shard-wide FOR UPDATE operations on the `bulk` shard — even a
 * rolled-back transaction's row locks would make this file's SKIP LOCKED
 * claims transiently miss committed rows. In return, this file's shard-wide
 * assertions (idle/scheduled re-arm advice) stay deterministic, while its
 * positive assertions stay scoped to rows each test created. Tests run
 * sequentially within the file and the type-prefixed cleanup below removes
 * every row a test committed.
 *
 * The contract has a second dimension: concurrent suite RUNS share one dev
 * database. A rival run's copy of this file commits claimable default-shard
 * rows too — its committed pass claims and dead-letters this run's rows
 * (its registry lacks this run's types), and its type-prefixed cleanup
 * deletes them mid-test. The advisory lock taken in `beforeAll` serializes
 * this one committing file across runs; rollback-only files need no lock
 * (their writes are invisible to other sessions and their lock-taking ops
 * stay on the bulk shard, which no run commits claimable rows to). A run
 * killed while holding the lock releases it with its session; the
 * post-acquire sweep clears any committed debris such a run left behind.
 */
const TYPE_PREFIX = 'test.pass';

let typeCounter = 0;
function freshType(): string {
  typeCounter += 1;
  return `${TYPE_PREFIX}${String(typeCounter)}.v1`;
}

interface RecordedTelemetry {
  readonly port: Telemetry;
  readonly events: { msg: string; fields: Record<string, unknown> | undefined }[];
  readonly errorCodes: string[];
}

function recordingTelemetry(): RecordedTelemetry {
  const events: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
  const errorCodes: string[] = [];
  const record = (msg: string, fields?: Record<string, unknown>): void => {
    events.push({ msg, fields });
  };
  return {
    port: {
      debug: record,
      info: record,
      warn: record,
      error: record,
      emitMetric: () => {},
      captureError: (_error, errorCode) => {
        errorCodes.push(errorCode);
      },
    },
    events,
    errorCodes,
  };
}

interface ExecutorOptions {
  readonly registry: JobRegistry;
  readonly telemetry?: Telemetry;
  readonly claimantId?: string;
  readonly passBudgetMs?: number;
}

function makeExecutor(options: ExecutorOptions): ReturnType<typeof createJobExecutor> {
  return createJobExecutor({
    withDb: (use) => use(db),
    registry: options.registry,
    telemetry: options.telemetry ?? recordingTelemetry().port,
    claimantId: options.claimantId ?? `claimant-${crypto.randomUUID()}`,
    random: () => 0.5,
    now: () => Date.now(),
    passBudgetMs: options.passBudgetMs ?? 60_000,
  });
}

const emptyPayloadSchema = z.looseObject({});

interface RegisterOptions {
  readonly leaseSeconds?: number;
  readonly maxFailures?: number;
  readonly shard?: JobShard;
}

function registryWithHandler(
  type: string,
  handler: JobHandler<Record<string, unknown>>,
  options: RegisterOptions = {}
): JobRegistry {
  const registry = createJobRegistry();
  registry.register({
    type,
    schema: emptyPayloadSchema,
    leaseSeconds: options.leaseSeconds ?? 60,
    maxFailures: options.maxFailures ?? 5,
    idempotency: 'natural',
    handler,
    ...(options.shard === undefined ? {} : { shard: options.shard }),
  });
  return registry;
}

function registerTxnHandler(
  registry: JobRegistry,
  type: string,
  handler: JobHandler<Record<string, unknown>>
): void {
  registry.register({
    type,
    schema: emptyPayloadSchema,
    leaseSeconds: 60,
    maxFailures: 5,
    idempotency: 'txn',
    handler,
  });
}

/** The effect a txn-class test handler writes: a follow-up job row. */
function registryWithEffectType(registry: JobRegistry, effectType: string): void {
  registry.register({
    type: effectType,
    schema: emptyPayloadSchema,
    leaseSeconds: 60,
    maxFailures: 5,
    idempotency: 'natural',
    handler: () => Promise.resolve(jobOutcome.ok()),
  });
}

async function enqueueCommitted(registry: JobRegistry, type: string): Promise<string> {
  const result = await db.transaction((tx) => enqueueWithinTx(tx, registry, { type, payload: {} }));
  if (!result.enqueued) throw new Error('expected an enqueued job');
  return result.jobId;
}

async function readJob(jobId: string): Promise<typeof jobs.$inferSelect> {
  const rows = await db.select().from(jobs).where(eq(jobs.id, jobId));
  const row = rows[0];
  if (row === undefined) throw new Error(`job ${jobId} not found`);
  return row;
}

async function statusOf(jobId: string): Promise<string> {
  const row = await readJob(jobId);
  return row.status;
}

/**
 * Dedicated session for the cross-run advisory lock. It must not come from
 * `db` — that pool is sized to one connection, and a permanently checked-out
 * lock client there would starve every query in the file.
 */
const lockDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

interface LockSession {
  query(text: string): Promise<unknown>;
  release(): void;
}

let lockSession: LockSession | undefined;

// Generous hook timeout: acquisition legitimately waits for a rival run's
// entire pass file (~4s unloaded, far longer under full-suite load).
beforeAll(async () => {
  // Checked out (never idle) so the pool cannot cull the session and
  // silently drop the lock mid-file.
  lockSession = await lockDb.$client.connect();
  await lockSession.query("select pg_advisory_lock(hashtext('jobs.pass.integration'))");
  await db.delete(jobs).where(like(jobs.type, `${TYPE_PREFIX}%`));
}, 120_000);

afterEach(async () => {
  await db.delete(jobs).where(like(jobs.type, `${TYPE_PREFIX}%`));
});

afterAll(async () => {
  // Ending the lock session is what releases the advisory lock.
  lockSession?.release();
  await lockDb.$client.end();
  await db.$client.end();
});

describe('the dispatcher pass', () => {
  it('recovers a lost enqueue: a committed row whose wake was lost executes on the next pulse', async () => {
    const type = freshType();
    let executions = 0;
    const registry = registryWithHandler(type, () => {
      executions += 1;
      return Promise.resolve(jobOutcome.ok({ done: true }));
    });
    // Commit the enqueue but deliberately send no wake — only the pulse runs.
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    // The recovery under test is row-scoped: our committed row was claimed and
    // run by the pulse alone. The pass's shard-wide advice (idle/scheduled) is
    // NOT asserted here — it is a `min(nextAttemptAt)` over the whole shared
    // `default` shard, so a foreign due-now row committed by a concurrent
    // (non-jobs) test file legitimately flips it to `scheduled`. That advice
    // has its own dedicated test.
    expect(executions).toBe(1);
    const row = await readJob(jobId);
    expect(row.status).toBe('succeeded');
    expect(row.result).toEqual({ done: true });
  });

  it('dead-letters a poison job at claim without harming its batch', async () => {
    const type = freshType();
    const executedJobIds: string[] = [];
    const registry = registryWithHandler(type, (execution) => {
      executedJobIds.push(execution.jobId);
      return Promise.resolve(jobOutcome.ok());
    });
    const healthyA = await enqueueCommitted(registry, type);
    const healthyB = await enqueueCommitted(registry, type);
    const poisonId = await enqueueCommitted(registry, type);
    // A poison history: every claim crashed the isolate, none completed.
    await db.update(jobs).set({ claims: 8 }).where(eq(jobs.id, poisonId));
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    expect(await statusOf(poisonId)).toBe('dead');
    expect(await statusOf(healthyA)).toBe('succeeded');
    expect(await statusOf(healthyB)).toBe('succeeded');
    expect(executedJobIds).not.toContain(poisonId);
    expect(
      telemetry.events.some(
        (event) =>
          event.msg === 'job dead-lettered at claim' && event.fields?.['jobId'] === poisonId
      )
    ).toBe(true);
    expect(telemetry.errorCodes).toContain('job_dead_letter');
  });

  it('lets a checkpoint yield consume no attempts and drains the re-pended row in the same pass', async () => {
    const type = freshType();
    const seenSteps: unknown[] = [];
    const registry = registryWithHandler(type, (execution) => {
      seenSteps.push(execution.payload['step']);
      if (execution.payload['step'] === undefined) {
        return Promise.resolve(jobOutcome.yield({ step: 2 }));
      }
      return Promise.resolve(jobOutcome.ok());
    });
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(seenSteps).toEqual([undefined, 2]);
    expect(row.status).toBe('succeeded');
    // One completed execution: the yield gave its claim increment back.
    expect(row.claims).toBe(1);
    expect(row.failures).toBe(0);
  });

  it('fails a hung handler at its lease timeout without eating the pass, and fences out its late writes', async () => {
    const hungType = freshType();
    const quickType = freshType();
    let capturedExecution: JobExecution<Record<string, unknown>> | undefined;
    const registry = createJobRegistry();
    registry.register({
      type: hungType,
      schema: emptyPayloadSchema,
      leaseSeconds: 1,
      maxFailures: 5,
      idempotency: 'natural',
      handler: (execution) => {
        capturedExecution = execution;
        return new Promise(() => {});
      },
    });
    let quickExecutions = 0;
    registry.register({
      type: quickType,
      schema: emptyPayloadSchema,
      leaseSeconds: 60,
      maxFailures: 5,
      idempotency: 'natural',
      handler: () => {
        quickExecutions += 1;
        return Promise.resolve(jobOutcome.ok());
      },
    });
    const claimantId = `claimant-${crypto.randomUUID()}`;
    const hungId = await enqueueCommitted(registry, hungType);
    const quickId = await enqueueCommitted(registry, quickType);
    await makeExecutor({ registry, claimantId }).runPass('default');

    expect(quickExecutions).toBe(1);
    expect(await statusOf(quickId)).toBe('succeeded');
    const hungRow = await readJob(hungId);
    expect(hungRow.status).toBe('pending');
    expect(hungRow.failures).toBe(1);
    expect(hungRow.errors[0]?.error).toContain('lease');

    // The losing handler is now a zombie: its heartbeat and its late
    // completion both miss the fence.
    if (capturedExecution === undefined) throw new Error('hung handler never started');
    expect(await capturedExecution.heartbeat()).toBe('lost');
    expect(
      await completeOk(db, { jobId: hungId, claimedBy: claimantId, claims: 1 }, { late: true })
    ).toBe('lost');
    expect(await statusOf(hungId)).toBe('pending');
  });

  it('resolves cancel-vs-claim: a cancel requested before the pass cancels the job un-run', async () => {
    const type = freshType();
    let executions = 0;
    const registry = registryWithHandler(type, () => {
      executions += 1;
      return Promise.resolve(jobOutcome.ok());
    });
    const jobId = await enqueueCommitted(registry, type);
    await db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, jobId));
    await makeExecutor({ registry }).runPass('default');
    expect(executions).toBe(0);
    expect(await statusOf(jobId)).toBe('cancelled');
  });

  it('resolves cancel-vs-checkpoint: a cancel landing mid-execution settles at the yield boundary', async () => {
    const type = freshType();
    let executions = 0;
    const registry = registryWithHandler(type, async (execution) => {
      executions += 1;
      await db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, execution.jobId));
      return jobOutcome.yield({ step: 2 });
    });
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    expect(executions).toBe(1);
    expect(await statusOf(jobId)).toBe('cancelled');
  });

  it('re-claims a lease-expired running row', async () => {
    const type = freshType();
    let executions = 0;
    const registry = registryWithHandler(type, () => {
      executions += 1;
      return Promise.resolve(jobOutcome.ok());
    });
    const jobId = await enqueueCommitted(registry, type);
    // A claimant died mid-job: running, lease long expired, no completion.
    await db
      .update(jobs)
      .set({
        status: 'running',
        claims: 1,
        claimedAt: sql`now() - interval '120 seconds'`,
        claimedBy: 'dead-claimant',
      })
      .where(eq(jobs.id, jobId));
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(executions).toBe(1);
    expect(row.status).toBe('succeeded');
    expect(row.claims).toBe(2);
  });

  it('redrives a dead job through an explicit update', async () => {
    const type = freshType();
    let attempts = 0;
    const registry = registryWithHandler(type, () => {
      attempts += 1;
      return Promise.resolve(
        attempts === 1 ? jobOutcome.dead('deterministic-validation-error') : jobOutcome.ok()
      );
    });
    const jobId = await enqueueCommitted(registry, type);
    const executor = makeExecutor({ registry });
    await executor.runPass('default');
    expect(await statusOf(jobId)).toBe('dead');
    // The explicit admin redrive: dead rows are rows, revived by UPDATE.
    await db
      .update(jobs)
      .set({ status: 'pending', claims: 0, failures: 0, nextAttemptAt: sql`now()` })
      .where(eq(jobs.id, jobId));
    await executor.runPass('default');
    expect(await statusOf(jobId)).toBe('succeeded');
    expect(attempts).toBe(2);
  });

  it('re-pends a failed job and advises the exact backoff as the next alarm', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () =>
      Promise.resolve(jobOutcome.fail('gateway-5xx'))
    );
    const jobId = await enqueueCommitted(registry, type);
    const result = await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(row.status).toBe('pending');
    expect(row.failures).toBe(1);
    expect(row.errors[0]).toMatchObject({ claim: 1, error: 'gateway-5xx' });
    // failures=1 with centered jitter → 1s backoff; the pass advises it.
    expect(result.kind).toBe('scheduled');
    if (result.kind === 'scheduled') {
      expect(result.delayMs).toBeGreaterThanOrEqual(250);
      expect(result.delayMs).toBeLessThanOrEqual(1000);
    }
  });

  it('re-pends a throwing handler as a failure', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () => Promise.reject(new Error('handler exploded')));
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(row.status).toBe('pending');
    expect(row.failures).toBe(1);
    expect(row.errors[0]?.error).toBe('handler exploded');
  });

  it('records a non-Error throw stringified in the error history', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error rejection path is the behavior under test
      Promise.reject('string-rejection')
    );
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(row.errors[0]?.error).toBe('string-rejection');
  });

  it('returns due when the pass budget is exhausted with work remaining', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () =>
      Promise.resolve(jobOutcome.yield({ again: true }))
    );
    await enqueueCommitted(registry, type);
    const result = await makeExecutor({ registry, passBudgetMs: 0 }).runPass('default');
    expect(result).toEqual({ kind: 'due' });
  });

  // The shard-global re-arm advice (`idle` when the whole shard has no
  // pending/scheduled work; `scheduled` at the exact `min(nextAttemptAt)`) is a
  // property of ALL rows on the shared `default` shard, which foreign production
  // rows committed by other test files (`payment.verify.v1` at admission) can
  // legitimately hold — so it is not a stable observation against the live DB.
  // That advice mapping is covered against a controlled (foreign-row-free) DB in
  // the `pass.test.ts` unit suite instead. The scheduled branch also has a
  // live-DB witness above ("re-pends a failed job and advises the exact
  // backoff"), whose assertion band tolerates a foreign due-now row.

  it('dead-letters an unregistered job type with a distinct code', async () => {
    const knownType = freshType();
    const registry = registryWithHandler(knownType, () => Promise.resolve(jobOutcome.ok()));
    const rows = await db
      .insert(jobs)
      .values({
        type: `${TYPE_PREFIX}unknown.v1`,
        payload: {},
        maxClaims: 8,
        maxFailures: 5,
        leaseSeconds: 60,
      })
      .returning({ id: jobs.id });
    const jobId = rows[0]?.id;
    if (jobId === undefined) throw new Error('insert failed');
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(row.status).toBe('dead');
    expect(row.errors[0]?.error).toBe('unregistered job type');
  });

  it('dead-letters an unparseable payload with a distinct code', async () => {
    const type = freshType();
    const registry = createJobRegistry();
    let executions = 0;
    registry.register({
      type,
      schema: z.object({ userId: z.string() }),
      leaseSeconds: 60,
      maxFailures: 5,
      idempotency: 'natural',
      handler: () => {
        executions += 1;
        return Promise.resolve(jobOutcome.ok());
      },
    });
    const rows = await db
      .insert(jobs)
      .values({ type, payload: { userId: 42 }, maxClaims: 8, maxFailures: 5, leaseSeconds: 60 })
      .returning({ id: jobs.id });
    const jobId = rows[0]?.id;
    if (jobId === undefined) throw new Error('insert failed');
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(executions).toBe(0);
    expect(row.status).toBe('dead');
    expect(row.errors[0]?.error).toBe('payload failed its registered schema');
  });

  it('gives a live handler an alive heartbeat through the fence', async () => {
    const type = freshType();
    let heartbeat: 'alive' | 'lost' | undefined;
    const registry = registryWithHandler(type, async (execution) => {
      heartbeat = await execution.heartbeat();
      return jobOutcome.ok();
    });
    await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    expect(heartbeat).toBe('alive');
  });

  it('logs and discards a completion that lost the fence', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, async (execution) => {
      // A rival reclaim while this handler runs: the claim counter moves on.
      await db
        .update(jobs)
        .set({ claims: sql`${jobs.claims} + 1` })
        .where(eq(jobs.id, execution.jobId));
      return jobOutcome.ok();
    });
    const jobId = await enqueueCommitted(registry, type);
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    expect(await statusOf(jobId)).toBe('running');
    expect(
      telemetry.events.some(
        (event) =>
          event.msg === 'job completion lost the fence' && event.fields?.['jobId'] === jobId
      )
    ).toBe(true);
  });

  it('emits telemetry when a completion write fails after the handler ran', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () =>
      // A jsonb-unserializable result: the completion write itself rejects.
      Promise.resolve(jobOutcome.ok({ poison: 1n }))
    );
    const jobId = await enqueueCommitted(registry, type);
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    expect(
      telemetry.events.some(
        (event) => event.msg === 'job completion write failed' && event.fields?.['jobId'] === jobId
      )
    ).toBe(true);
    expect(telemetry.errorCodes).toContain('job_completion_write_failed');
  });

  it('leaves a job whose completion write failed claimed for lease recovery', async () => {
    const type = freshType();
    const registry = registryWithHandler(type, () =>
      Promise.resolve(jobOutcome.ok({ poison: 1n }))
    );
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    expect(await statusOf(jobId)).toBe('running');
  });

  it('commits a txn-class handler effect with its completion in one transaction', async () => {
    const type = freshType();
    const effectType = freshType();
    const registry = createJobRegistry();
    registryWithEffectType(registry, effectType);
    registerTxnHandler(registry, type, (execution) =>
      db.transaction(async (tx) => {
        await enqueueWithinTx(tx, registry, { type: effectType, payload: {} });
        return execution.completeWithinTx(tx, { settled: true });
      })
    );
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    expect(row.status).toBe('succeeded');
    expect(row.result).toEqual({ settled: true });
    const effects = await db.select().from(jobs).where(eq(jobs.type, effectType));
    expect(effects).toHaveLength(1);
  });

  it('skips the executor terminal write after a handler self-completion', async () => {
    const type = freshType();
    const registry = createJobRegistry();
    registerTxnHandler(registry, type, (execution) =>
      db.transaction((tx) => execution.completeWithinTx(tx, { settled: true }))
    );
    const jobId = await enqueueCommitted(registry, type);
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    expect(await statusOf(jobId)).toBe('succeeded');
    // A redundant executor write would miss the consumed fence and pollute
    // the genuine zombie signal with this warning.
    expect(telemetry.events.some((event) => event.msg === 'job completion lost the fence')).toBe(
      false
    );
  });

  it('rolls back a txn-class effect with its terminal transition when the handler crashes before commit', async () => {
    const type = freshType();
    const effectType = freshType();
    const registry = createJobRegistry();
    registryWithEffectType(registry, effectType);
    registerTxnHandler(registry, type, (execution) =>
      db.transaction(async (tx) => {
        await enqueueWithinTx(tx, registry, { type: effectType, payload: {} });
        await execution.completeWithinTx(tx, { settled: true });
        throw new Error('crash-before-commit');
      })
    );
    const jobId = await enqueueCommitted(registry, type);
    await makeExecutor({ registry }).runPass('default');
    const row = await readJob(jobId);
    // Neither the effect nor the terminal transition persisted; the row
    // re-pends through the ordinary failure path and stays retryable.
    expect(await db.select().from(jobs).where(eq(jobs.type, effectType))).toHaveLength(0);
    expect(row.status).toBe('pending');
    expect(row.result).toBeNull();
    expect(row.failures).toBe(1);
    expect(row.errors[0]?.error).toBe('crash-before-commit');
  });

  it('aborts a txn-class completion that lost the fence so the effect cannot commit', async () => {
    const type = freshType();
    const effectType = freshType();
    const registry = createJobRegistry();
    registryWithEffectType(registry, effectType);
    let thrownInHandler: unknown;
    registerTxnHandler(registry, type, async (execution) => {
      // A rival reclaim while this handler runs: the claim counter moves on.
      await db
        .update(jobs)
        .set({ claims: sql`${jobs.claims} + 1` })
        .where(eq(jobs.id, execution.jobId));
      try {
        return await db.transaction(async (tx) => {
          await enqueueWithinTx(tx, registry, { type: effectType, payload: {} });
          return await execution.completeWithinTx(tx, { settled: true });
        });
      } catch (error) {
        thrownInHandler = error;
        throw error;
      }
    });
    const jobId = await enqueueCommitted(registry, type);
    const telemetry = recordingTelemetry();
    await makeExecutor({ registry, telemetry: telemetry.port }).runPass('default');
    expect(String(thrownInHandler)).toContain('fence');
    expect(await db.select().from(jobs).where(eq(jobs.type, effectType))).toHaveLength(0);
    expect(await statusOf(jobId)).toBe('running');
    expect(telemetry.events.some((event) => event.msg === 'job completion lost the fence')).toBe(
      true
    );
  });

  it('claims each job exactly once across two concurrent dispatchers', async () => {
    const type = freshType();
    const executionsByJob = new Map<string, number>();
    const registry = registryWithHandler(type, (execution) => {
      executionsByJob.set(execution.jobId, (executionsByJob.get(execution.jobId) ?? 0) + 1);
      return Promise.resolve(jobOutcome.ok());
    });
    const ids = await Promise.all(
      Array.from({ length: 4 }, () => enqueueCommitted(registry, type))
    );
    await Promise.all([
      makeExecutor({ registry, claimantId: 'claimant-a' }).runPass('default'),
      makeExecutor({ registry, claimantId: 'claimant-b' }).runPass('default'),
    ]);
    for (const jobId of ids) {
      expect(executionsByJob.get(jobId)).toBe(1);
      expect(await statusOf(jobId)).toBe('succeeded');
    }
  });
});
