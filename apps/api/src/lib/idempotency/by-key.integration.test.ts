import { LOCAL_NEON_DEV_CONFIG, createDb, idempotencyKeys } from '@hushbox/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { unavailableError } from '../errors/index.js';
import { ResultAsync, errAsync, okAsync } from '../result/index.js';
import { byKey, continueFromClaim } from './by-key.js';
import { hashCanonicalJson } from './canonical-json.js';
import { isIdempotencyConflict } from './errors.js';
import { claimKeyRow } from './key-row.js';
import type { DomainError } from '../errors/index.js';
import type { DbTransaction } from './transaction.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for idempotency integration tests');
}

// Two clients (each a max-1 pool) so a concurrent rival rides its own
// connection, the way a second isolate would.
const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const rival = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const createdUserIds: string[] = [];

const responseSchema = z.object({ n: z.number() });

function setup(): { userId: string; scope: { userId: string; route: string; key: string } } {
  const userId = crypto.randomUUID();
  createdUserIds.push(userId);
  return { userId, scope: { userId, route: '/things', key: crypto.randomUUID() } };
}

/** A DB-visible side effect the wrapper must commit exactly once. */
function insertEffect(tx: DbTransaction, userId: string): Promise<unknown> {
  return tx.insert(idempotencyKeys).values({
    userId,
    route: '/effects',
    key: crypto.randomUUID(),
    kind: 'request',
    bodyHash: 'effect',
    claimedBy: 'effect',
  });
}

async function countEffects(userId: string): Promise<number> {
  const rows = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.route, '/effects')));
  return rows.length;
}

async function readKeyRow(scope: {
  userId: string;
  route: string;
  key: string;
}): Promise<typeof idempotencyKeys.$inferSelect> {
  const rows = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, scope.userId),
        eq(idempotencyKeys.route, scope.route),
        eq(idempotencyKeys.key, scope.key)
      )
    );
  const row = rows[0];
  if (row === undefined) throw new Error('expected a key row');
  return row;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.userId, createdUserIds));
  }
  await db.$client.end();
  await rival.$client.end();
});

describe('idempotent.byKey', () => {
  it('executes the mutation and flips the key row to succeeded', async () => {
    const { userId, scope } = setup();
    const result = await byKey({
      db,
      scope,
      body: { a: 1 },
      executorId: 'worker-1',
      responseSchema,
      execute: (tx) => ResultAsync.fromSafePromise(insertEffect(tx, userId)).map(() => ({ n: 7 })),
    });
    expect(result._unsafeUnwrap()).toEqual({ n: 7 });
    const row = await readKeyRow(scope);
    expect(row.status).toBe('succeeded');
    expect(row.response).toEqual({ n: 7 });
    expect(await countEffects(userId)).toBe(1);
  });

  it('replays the stored response on duplicate delivery without re-executing', async () => {
    const { userId, scope } = setup();
    let executions = 0;
    const run = (): ResultAsync<{ n: number }, DomainError> =>
      byKey({
        db,
        scope,
        body: { a: 1 },
        executorId: 'worker-1',
        responseSchema,
        execute: (tx) => {
          executions += 1;
          return ResultAsync.fromSafePromise(insertEffect(tx, userId)).map(() => ({
            n: executions,
          }));
        },
      });
    const first = await run();
    const second = await run();
    expect(first._unsafeUnwrap()).toEqual({ n: 1 });
    expect(second._unsafeUnwrap()).toEqual({ n: 1 });
    expect(executions).toBe(1);
    expect(await countEffects(userId)).toBe(1);
  });

  it('treats a key-reordered body as the same body', async () => {
    const { scope } = setup();
    const base = {
      db,
      scope,
      executorId: 'worker-1',
      responseSchema,
      execute: (): ResultAsync<{ n: number }, DomainError> => okAsync({ n: 1 }),
    };
    const first = await byKey({ ...base, body: { a: 1, b: 2 } });
    const second = await byKey({ ...base, body: { b: 2, a: 1 } });
    expect(first.isOk()).toBe(true);
    expect(second._unsafeUnwrap()).toEqual({ n: 1 });
  });

  it('rejects a reused key with a different body', async () => {
    const { scope } = setup();
    const base = {
      db,
      scope,
      executorId: 'worker-1',
      responseSchema,
      execute: (): ResultAsync<{ n: number }, DomainError> => okAsync({ n: 1 }),
    };
    const first = await byKey({ ...base, body: { a: 1 } });
    expect(first.isOk()).toBe(true);
    const result = await byKey({ ...base, body: { a: 2 } });
    const error = result._unsafeUnwrapErr();
    expect(isIdempotencyConflict(error) && error.wireCode).toBe('IDEMPOTENCY_BODY_MISMATCH');
  });

  it('answers in-progress to a concurrent request on the same key', async () => {
    const { scope } = setup();
    let executions = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const slow = byKey({
      db,
      scope,
      body: { a: 1 },
      executorId: 'worker-1',
      responseSchema,
      execute: () => {
        executions += 1;
        signalEntered();
        return ResultAsync.fromSafePromise(gate).map(() => ({ n: 1 }));
      },
    });
    await entered;
    const racer = await byKey({
      db: rival,
      scope,
      body: { a: 1 },
      executorId: 'worker-2',
      responseSchema,
      execute: () => {
        executions += 1;
        return okAsync({ n: 2 });
      },
    });
    releaseGate();
    const winner = await slow;
    const error = racer._unsafeUnwrapErr();
    expect(isIdempotencyConflict(error) && error.wireCode).toBe('REQUEST_IN_PROGRESS');
    expect(winner._unsafeUnwrap()).toEqual({ n: 1 });
    expect(executions).toBe(1);
  });

  it('marks the key failed and commits nothing when execution fails', async () => {
    const { userId, scope } = setup();
    const result = await byKey({
      db,
      scope,
      body: { a: 1 },
      executorId: 'worker-1',
      responseSchema,
      execute: (tx) =>
        ResultAsync.fromSafePromise(insertEffect(tx, userId)).andThen(() =>
          errAsync<{ n: number }, DomainError>(unavailableError('downstream broke'))
        ),
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(await countEffects(userId)).toBe(0);
    const row = await readKeyRow(scope);
    expect(row.status).toBe('failed');
  });

  it('re-executes exactly once on retry after a failure', async () => {
    const { userId, scope } = setup();
    const failing = await byKey({
      db,
      scope,
      body: { a: 1 },
      executorId: 'worker-1',
      responseSchema,
      execute: () => errAsync<{ n: number }, DomainError>(unavailableError('boom')),
    });
    expect(failing.isErr()).toBe(true);
    const retry = await byKey({
      db,
      scope,
      body: { a: 1 },
      executorId: 'worker-2',
      responseSchema,
      execute: (tx) => ResultAsync.fromSafePromise(insertEffect(tx, userId)).map(() => ({ n: 9 })),
    });
    expect(retry._unsafeUnwrap()).toEqual({ n: 9 });
    const row = await readKeyRow(scope);
    expect(row.claims).toBe(2);
    expect(await countEffects(userId)).toBe(1);
  });

  it('re-executes exactly once after a crashed executor expires its lease', async () => {
    const { userId, scope } = setup();
    // A crashed executor: claimed row, no terminal write, lease long expired.
    await db.insert(idempotencyKeys).values({
      userId: scope.userId,
      route: scope.route,
      key: scope.key,
      kind: 'request',
      bodyHash: await hashCanonicalJson({ a: 1 }),
      claimedBy: 'dead-worker',
      claimedAt: sql`now() - interval '2 hours'`,
    });
    const result = await byKey({
      db,
      scope,
      body: { a: 1 },
      executorId: 'worker-2',
      responseSchema,
      execute: (tx) => ResultAsync.fromSafePromise(insertEffect(tx, userId)).map(() => ({ n: 3 })),
    });
    expect(result._unsafeUnwrap()).toEqual({ n: 3 });
    const row = await readKeyRow(scope);
    expect(row.claims).toBe(2);
    expect(row.claimedBy).toBe('worker-2');
    expect(await countEffects(userId)).toBe(1);
  });

  it('rolls back a zombie executor whose fence was reclaimed mid-execution', async () => {
    const { userId, scope } = setup();
    const reclaimMidExecution = async (tx: DbTransaction): Promise<void> => {
      await insertEffect(tx, userId);
      await rival
        .update(idempotencyKeys)
        .set({ claims: sql`${idempotencyKeys.claims} + 1`, claimedBy: 'worker-2' })
        .where(
          and(eq(idempotencyKeys.userId, scope.userId), eq(idempotencyKeys.route, scope.route))
        );
    };
    const result = await byKey({
      db,
      scope,
      body: { a: 1 },
      executorId: 'worker-1',
      responseSchema,
      execute: (tx) => ResultAsync.fromSafePromise(reclaimMidExecution(tx)).map(() => ({ n: 1 })),
    });
    expect(result._unsafeUnwrapErr().code).toBe('conflict');
    expect(await countEffects(userId)).toBe(0);
    const row = await readKeyRow(scope);
    expect(row.claimedBy).toBe('worker-2');
  });

  it('fails closed when the succeeded flip itself fails inside the transaction', async () => {
    const { scope } = setup();
    const poison = async (tx: DbTransaction): Promise<void> => {
      // Poisons the open transaction: PG aborts it, so the succeeded flip
      // that follows fails as a store error rather than a fence loss.
      try {
        await tx.execute(sql`select 1/0`);
      } catch {
        // Swallowed: the aborted-transaction state is the point.
      }
    };
    const result = await byKey({
      db,
      scope,
      body: { a: 1 },
      executorId: 'worker-1',
      responseSchema,
      execute: (tx) => ResultAsync.fromSafePromise(poison(tx)).map(() => ({ n: 1 })),
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    const row = await readKeyRow(scope);
    expect(row.status).toBe('failed');
  });

  it('treats an attach outcome on a request-kind claim as a defect', async () => {
    const { scope } = setup();
    const claimed = await claimKeyRow(db, {
      scope,
      kind: 'request',
      bodyHash: await hashCanonicalJson({ a: 1 }),
      executorId: 'worker-1',
      leaseSeconds: 3600,
    });
    const claim = claimed._unsafeUnwrap();
    if (claim.outcome !== 'executor') throw new Error(`expected executor, got ${claim.outcome}`);
    expect(() =>
      continueFromClaim(
        {
          db,
          scope,
          body: { a: 1 },
          executorId: 'worker-1',
          responseSchema,
          execute: () => okAsync({ n: 1 }),
        },
        { outcome: 'attach', row: claim.row }
      )
    ).toThrow(/attach/);
  });

  it('keeps a non-canonicalizable body throwing as a defect', async () => {
    const { scope } = setup();
    await expect(
      byKey({
        db,
        scope,
        body: { callback: () => 1 },
        executorId: 'worker-1',
        responseSchema,
        execute: () => okAsync({ n: 1 }),
      })
    ).rejects.toThrow(/canonicalJson/);
  });

  it('marks the key failed and rethrows when execution throws a defect', async () => {
    const { scope } = setup();
    await expect(
      byKey({
        db,
        scope,
        body: { a: 1 },
        executorId: 'worker-1',
        responseSchema,
        execute: () => {
          throw new Error('a defect');
        },
      })
    ).rejects.toThrow('a defect');
    const row = await readKeyRow(scope);
    expect(row.status).toBe('failed');
  });
});
