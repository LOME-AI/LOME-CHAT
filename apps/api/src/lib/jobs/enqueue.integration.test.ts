import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { enqueueWithinTx } from './enqueue.js';
import { jobOutcome } from './outcome.js';
import { createJobRegistry } from './registry.js';
import type { DbTransaction } from '../idempotency/transaction.js';
import type { JobRegistry } from './registry.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for jobs integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/**
 * Every test runs inside a rolled-back transaction: the jobs table is a
 * single shared queue, so a committed pending row here would be claimable by
 * the dispatcher-pass tests running in parallel.
 */
class Rollback extends Error {}

async function withRollback<T>(function_: (tx: DbTransaction) => Promise<T>): Promise<T> {
  let captured: { value: T } | undefined;
  try {
    await db.transaction(async (tx) => {
      captured = { value: await function_(tx) };
      throw new Rollback('roll back test writes');
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (captured === undefined) throw new Error('withRollback: body did not complete');
  return captured.value;
}

let typeCounter = 0;
function freshType(): string {
  typeCounter += 1;
  return `test.enqueue${String(typeCounter)}.v1`;
}

function registryWith(type: string, shard?: 'default' | 'bulk'): JobRegistry {
  const registry = createJobRegistry();
  registry.register({
    type,
    schema: z.object({ userId: z.string() }),
    leaseSeconds: 60,
    maxFailures: 5,
    idempotency: 'natural',
    handler: () => Promise.resolve(jobOutcome.ok()),
    ...(shard === undefined ? {} : { shard }),
  });
  return registry;
}

async function readJob(tx: DbTransaction, jobId: string): Promise<typeof jobs.$inferSelect> {
  const rows = await tx.select().from(jobs).where(eq(jobs.id, jobId));
  const row = rows[0];
  if (row === undefined) throw new Error(`job ${jobId} not found`);
  return row;
}

function requireEnqueued(result: Awaited<ReturnType<typeof enqueueWithinTx>>): string {
  if (!result.enqueued) throw new Error('expected an enqueued job');
  return result.jobId;
}

afterAll(async () => {
  await db.$client.end();
});

describe('enqueueWithinTx', () => {
  it('inserts a pending row carrying registry-derived budgets', async () => {
    const type = freshType();
    const row = await withRollback(async (tx) => {
      const result = await enqueueWithinTx(tx, registryWith(type), {
        type,
        payload: { userId: 'u1' },
      });
      return readJob(tx, requireEnqueued(result));
    });
    expect(row).toMatchObject({
      type,
      shard: 'default',
      priority: 0,
      status: 'pending',
      payload: { userId: 'u1' },
      leaseSeconds: 60,
      maxFailures: 5,
      maxClaims: 8,
      claims: 0,
      failures: 0,
    });
  });

  it('routes to the registration shard by default', async () => {
    const type = freshType();
    const row = await withRollback(async (tx) => {
      const result = await enqueueWithinTx(tx, registryWith(type, 'bulk'), {
        type,
        payload: { userId: 'u1' },
      });
      return readJob(tx, requireEnqueued(result));
    });
    expect(row.shard).toBe('bulk');
  });

  it('honors an explicit shard override', async () => {
    const type = freshType();
    const row = await withRollback(async (tx) => {
      const result = await enqueueWithinTx(tx, registryWith(type), {
        type,
        payload: { userId: 'u1' },
        shard: 'bulk',
      });
      return readJob(tx, requireEnqueued(result));
    });
    expect(row.shard).toBe('bulk');
  });

  it('honors an explicit priority', async () => {
    const type = freshType();
    const row = await withRollback(async (tx) => {
      const result = await enqueueWithinTx(tx, registryWith(type), {
        type,
        payload: { userId: 'u1' },
        priority: -5,
      });
      return readJob(tx, requireEnqueued(result));
    });
    expect(row.priority).toBe(-5);
  });

  it('sets a delayed start as both scheduledAt and nextAttemptAt', async () => {
    const type = freshType();
    const scheduledAt = new Date(Date.now() + 3_600_000);
    const row = await withRollback(async (tx) => {
      const result = await enqueueWithinTx(tx, registryWith(type), {
        type,
        payload: { userId: 'u1' },
        scheduledAt,
      });
      return readJob(tx, requireEnqueued(result));
    });
    expect(row.scheduledAt.getTime()).toBe(scheduledAt.getTime());
    expect(row.nextAttemptAt.getTime()).toBe(scheduledAt.getTime());
  });

  it('suppresses a duplicate while a dedupe-keyed job is active', async () => {
    const type = freshType();
    const registry = registryWith(type);
    const dedupeKey = `dedupe-${crypto.randomUUID()}`;
    const second = await withRollback(async (tx) => {
      requireEnqueued(
        await enqueueWithinTx(tx, registry, { type, payload: { userId: 'u1' }, dedupeKey })
      );
      return enqueueWithinTx(tx, registry, { type, payload: { userId: 'u1' }, dedupeKey });
    });
    expect(second).toEqual({ enqueued: false, reason: 'duplicate-active' });
  });

  it('allows re-enqueue once the dedupe-keyed job reached a terminal state', async () => {
    const type = freshType();
    const registry = registryWith(type);
    const dedupeKey = `dedupe-${crypto.randomUUID()}`;
    const { firstId, second } = await withRollback(async (tx) => {
      const firstJobId = requireEnqueued(
        await enqueueWithinTx(tx, registry, { type, payload: { userId: 'u1' }, dedupeKey })
      );
      await tx.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.id, firstJobId));
      return {
        firstId: firstJobId,
        second: await enqueueWithinTx(tx, registry, { type, payload: { userId: 'u1' }, dedupeKey }),
      };
    });
    expect(second.enqueued).toBe(true);
    if (second.enqueued) expect(second.jobId).not.toBe(firstId);
  });

  it('rejects an unregistered type', async () => {
    const registry = createJobRegistry();
    await expect(
      withRollback((tx) =>
        enqueueWithinTx(tx, registry, { type: 'missing.v1', payload: { userId: 'u1' } })
      )
    ).rejects.toThrow('unregistered');
  });

  it('rejects a payload that fails the registered schema', async () => {
    const type = freshType();
    await expect(
      withRollback((tx) =>
        enqueueWithinTx(tx, registryWith(type), { type, payload: { userId: 42 } })
      )
    ).rejects.toThrow('payload');
  });
});
