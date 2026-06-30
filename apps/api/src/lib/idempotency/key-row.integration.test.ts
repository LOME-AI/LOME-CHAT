import { LOCAL_NEON_DEV_CONFIG, createDb, idempotencyKeys } from '@hushbox/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { isIdempotencyConflict } from './errors.js';
import { claimKeyRow, failKeyRow, heartbeatKeyRow, succeedKeyRow } from './key-row.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../errors/index.js';
import type { ResultAsync } from '../result/index.js';
import type { ClaimKeyRowParams, KeyRowClaim, KeyRowFence } from './key-row.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for idempotency integration tests');
}

// Two clients (each a max-1 pool) so concurrent claims ride two real
// connections, the way two isolates would.
const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const rival = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const createdUserIds: string[] = [];

function freshScope(): { userId: string; route: string; key: string } {
  const userId = crypto.randomUUID();
  createdUserIds.push(userId);
  return { userId, route: '/things', key: crypto.randomUUID() };
}

function params(overrides: Partial<ClaimKeyRowParams> = {}): ClaimKeyRowParams {
  return {
    scope: freshScope(),
    kind: 'request',
    bodyHash: 'hash-a',
    executorId: 'executor-a',
    leaseSeconds: 3600,
    ...overrides,
  };
}

async function unwrap<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

async function unwrapErr<T>(result: ResultAsync<T, DomainError>): Promise<DomainError> {
  const settled = await result;
  return settled._unsafeUnwrapErr();
}

async function expectExecutor(
  result: ResultAsync<KeyRowClaim, DomainError>
): Promise<typeof idempotencyKeys.$inferSelect & { claims: number }> {
  const claim = await unwrap(result);
  if (claim.outcome !== 'executor') {
    throw new Error(`expected executor, got ${claim.outcome}`);
  }
  return claim.row;
}

async function readRow(scope: { userId: string }): Promise<typeof idempotencyKeys.$inferSelect> {
  const rows = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.userId, scope.userId));
  const row = rows[0];
  if (row === undefined) throw new Error('expected a key row');
  return row;
}

async function backdateClaim(scope: { userId: string }): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({ claimedAt: sql`now() - interval '2 hours'` })
    .where(eq(idempotencyKeys.userId, scope.userId));
}

function fenceOf(row: { id: string; claimedBy: string; claims: number }): KeyRowFence {
  return { id: row.id, executorId: row.claimedBy, claims: row.claims };
}

type InterceptableMethod = 'insert' | 'select' | 'update';

/**
 * Wraps the real client so a hook completes immediately before intercepted
 * statements execute. Drizzle builders are lazy thenables — the chain builds
 * synchronously and runs at await — so awaiting a wrapped chain runs the
 * hook (a rival's committed writes) first, giving a deterministic interleave
 * between this client's consecutive statements that two raw connections
 * cannot order.
 */
function withHooks(
  real: Database,
  hooks: Partial<Record<InterceptableMethod, () => Promise<void>>>
): Database {
  const wrapChain = (chain: object, hook: () => Promise<void>): unknown =>
    new Proxy(chain, {
      get(target, property, receiver): unknown {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property === 'then' && typeof value === 'function') {
          // A `then` implementation: run the hook, execute the real chain,
          // then hand the outcome to the callbacks `await` supplied.
          return async (
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown
          ): Promise<unknown> => {
            try {
              await hook();
              const result = await (target as PromiseLike<unknown>);
              return onFulfilled === undefined ? result : onFulfilled(result);
            } catch (error) {
              if (onRejected === undefined) throw error;
              return onRejected(error);
            }
          };
        }
        return typeof value === 'function'
          ? (...args: unknown[]): unknown =>
              wrapChain((value as (...inner: unknown[]) => object).apply(target, args), hook)
          : value;
      },
    });
  return new Proxy(real, {
    get(target, property, receiver): unknown {
      const value: unknown = Reflect.get(target, property, receiver);
      const hook = hooks[property as InterceptableMethod];
      if (hook !== undefined && typeof value === 'function') {
        return (...args: unknown[]): unknown =>
          wrapChain((value as (...inner: unknown[]) => object).apply(target, args), hook);
      }
      return typeof value === 'function'
        ? (value as (...inner: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.userId, createdUserIds));
  }
  await db.$client.end();
  await rival.$client.end();
});

describe('claimKeyRow', () => {
  it('claims a fresh key by unique insert and returns the executor outcome', async () => {
    const p = params();
    const row = await expectExecutor(claimKeyRow(db, p));
    expect(row.claims).toBe(1);
    const stored = await readRow(p.scope);
    expect(stored.status).toBe('claimed');
    expect(stored.claimedBy).toBe('executor-a');
  });

  it('replays the stored response for a succeeded key', async () => {
    const p = params();
    const row = await expectExecutor(claimKeyRow(db, p));
    const flip = await unwrap(succeedKeyRow(db, fenceOf(row), { answer: 42 }));
    expect(flip).toBe('flipped');
    const claim = await unwrap(claimKeyRow(db, p));
    expect(claim).toEqual({ outcome: 'replay', response: { answer: 42 } });
  });

  it('rejects a reused key whose body hash differs', async () => {
    const p = params();
    await expectExecutor(claimKeyRow(db, p));
    const error = await unwrapErr(claimKeyRow(db, { ...p, bodyHash: 'hash-b' }));
    expect(isIdempotencyConflict(error) && error.wireCode).toBe('IDEMPOTENCY_BODY_MISMATCH');
  });

  it('answers in-progress for a live claimed request-kind key', async () => {
    const p = params();
    await expectExecutor(claimKeyRow(db, p));
    const error = await unwrapErr(claimKeyRow(db, { ...p, executorId: 'executor-b' }));
    expect(isIdempotencyConflict(error) && error.wireCode).toBe('REQUEST_IN_PROGRESS');
  });

  it('attaches to a live claimed run-kind key', async () => {
    const runId = crypto.randomUUID();
    const p = params({ kind: 'run', runId });
    await expectExecutor(claimKeyRow(db, p));
    const claim = await unwrap(claimKeyRow(db, { ...p, executorId: 'executor-b' }));
    if (claim.outcome !== 'attach') throw new Error(`expected attach, got ${claim.outcome}`);
    expect(claim.row.runId).toBe(runId);
    expect(claim.row.claimedBy).toBe('executor-a');
  });

  it('lets a retry reclaim a lease-expired key', async () => {
    const p = params();
    await expectExecutor(claimKeyRow(db, p));
    await backdateClaim(p.scope);
    const row = await expectExecutor(claimKeyRow(db, { ...p, executorId: 'executor-b' }));
    expect(row.claims).toBe(2);
    const stored = await readRow(p.scope);
    expect(stored.claimedBy).toBe('executor-b');
  });

  it('grants exactly one executor when two retries race an expired lease', async () => {
    const p = params();
    await expectExecutor(claimKeyRow(db, p));
    await backdateClaim(p.scope);
    const [a, b] = await Promise.all([
      claimKeyRow(db, { ...p, executorId: 'executor-b' }),
      claimKeyRow(rival, { ...p, executorId: 'executor-c' }),
    ]);
    const outcomes = [a, b].map((r) =>
      r.match(
        (claim) => claim.outcome,
        (error) => (isIdempotencyConflict(error) ? error.wireCode : error.code)
      )
    );
    expect(outcomes.filter((o) => o === 'executor')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'REQUEST_IN_PROGRESS')).toHaveLength(1);
  });

  it('lets a retry reclaim a failed key exactly once', async () => {
    const p = params();
    const row = await expectExecutor(claimKeyRow(db, p));
    const flip = await unwrap(failKeyRow(db, fenceOf(row)));
    expect(flip).toBe('flipped');
    const reclaimed = await expectExecutor(claimKeyRow(db, { ...p, executorId: 'executor-b' }));
    expect(reclaimed.claims).toBe(2);
    const stored = await readRow(p.scope);
    expect(stored.status).toBe('claimed');
    expect(stored.completedAt).toBeNull();
  });

  it('rejects a claim whose kind contradicts the stored row', async () => {
    const p = params();
    await expectExecutor(claimKeyRow(db, p));
    await expect(claimKeyRow(db, { ...p, kind: 'run' })).rejects.toThrow(/kind/);
  });

  it('identifies the kind-contradiction defect by row id, never the client key', async () => {
    const p = params();
    const row = await expectExecutor(claimKeyRow(db, p));
    const defect = await claimKeyRow(db, { ...p, kind: 'run' }).then(
      () => {
        throw new Error('expected the kind contradiction to throw');
      },
      (error: unknown) => error as Error
    );
    expect(defect.message).toContain(row.id);
    expect(defect.message).not.toContain(p.scope.key);
    expect(defect.message).not.toContain(p.bodyHash);
  });

  it('replays a response that lands while a retry is mid-reclaim', async () => {
    // Row-lock interleave, ordered not raced: the original executor's
    // succeeded flip signals only AFTER its UPDATE has executed inside an
    // open transaction (row lock held), and the retry starts only on that
    // signal — so the retry can never win the reclaim CAS. Its claim blocks
    // on the open flip; on commit the CAS re-check matches nothing and the
    // disambiguating re-read must surface the freshly stored response.
    const p = params();
    const row = await expectExecutor(claimKeyRow(db, p));
    await backdateClaim(p.scope);
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let signalFlipExecuted!: () => void;
    const flipExecuted = new Promise<void>((resolve) => {
      signalFlipExecuted = resolve;
    });
    const original = rival.transaction(async (tx) => {
      const flip = await succeedKeyRow(tx, fenceOf(row), { landed: true });
      expect(flip._unsafeUnwrap()).toBe('flipped');
      signalFlipExecuted();
      await lockHeld;
    });
    await flipExecuted;
    const retry = claimKeyRow(db, { ...p, executorId: 'executor-b' });
    // Gives the retry time to block on the held lock before the flip
    // commits; the asserted outcome is identical on either side of the
    // commit, so this timing is not load-bearing for correctness.
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseLock();
    await original;
    const claim = await unwrap(retry);
    expect(claim).toEqual({ outcome: 'replay', response: { landed: true } });
  });

  it('gives up unavailable when the claim insert keeps conflicting with a vanishing row', async () => {
    const p = params();
    const hooked = withHooks(db, {
      // The rival's row exists at every insert and vanishes before every
      // read: the purge-race retry loop must exhaust and fail closed.
      insert: async () => {
        await rival
          .insert(idempotencyKeys)
          .values({
            userId: p.scope.userId,
            route: p.scope.route,
            key: p.scope.key,
            kind: 'request',
            bodyHash: p.bodyHash,
            claimedBy: 'rival',
          })
          .onConflictDoNothing();
      },
      select: async () => {
        await rival.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, p.scope.userId));
      },
    });
    const error = await unwrapErr(claimKeyRow(hooked, p));
    expect(error.code).toBe('unavailable');
  });

  it('re-claims fresh when the row vanishes after a lost reclaim race', async () => {
    const p = params();
    await expectExecutor(claimKeyRow(db, p));
    await backdateClaim(p.scope);
    let selects = 0;
    const hooked = withHooks(db, {
      update: async () => {
        // A rival reclaim lands first, so this client's CAS must miss...
        await rival
          .update(idempotencyKeys)
          .set({ claims: sql`${idempotencyKeys.claims} + 1`, claimedBy: 'rival' })
          .where(eq(idempotencyKeys.userId, p.scope.userId));
      },
      select: async () => {
        selects += 1;
        if (selects === 2) {
          // ...and the row vanishes before the disambiguating re-read, so
          // the claim loop's second pass inserts fresh.
          await rival.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, p.scope.userId));
        }
      },
    });
    const row = await expectExecutor(claimKeyRow(hooked, { ...p, executorId: 'executor-b' }));
    expect(row.claimedBy).toBe('executor-b');
    expect(row.claims).toBe(1);
  });

  it('replays the rival response when the reclaim race loser re-reads a settled row', async () => {
    const p = params();
    await expectExecutor(claimKeyRow(db, p));
    await backdateClaim(p.scope);
    const hooked = withHooks(db, {
      update: async () => {
        // The rival wins the whole lifecycle — reclaim and succeeded flip —
        // before this client's CAS runs, so the disambiguating re-read must
        // surface the rival's stored response.
        const rivalRow = await expectExecutor(
          claimKeyRow(rival, { ...p, executorId: 'executor-c' })
        );
        const flip = await unwrap(succeedKeyRow(rival, fenceOf(rivalRow), { raced: true }));
        expect(flip).toBe('flipped');
      },
    });
    const claim = await unwrap(claimKeyRow(hooked, { ...p, executorId: 'executor-b' }));
    expect(claim).toEqual({ outcome: 'replay', response: { raced: true } });
  });

  it('maps a store failure into the unavailable error channel', async () => {
    // Nothing listens on this port: the connection itself fails.
    const broken = createDb('postgresql://nobody:nothing@127.0.0.1:1/nope', {
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
    try {
      const error = await unwrapErr(claimKeyRow(broken, params()));
      expect(error.code).toBe('unavailable');
    } finally {
      await broken.$client.end();
    }
  });
});

describe('completion fence', () => {
  it('flips a live claim to succeeded and stores the response', async () => {
    const p = params();
    const row = await expectExecutor(claimKeyRow(db, p));
    const flip = await unwrap(succeedKeyRow(db, fenceOf(row), { ok: true }));
    expect(flip).toBe('flipped');
    const stored = await readRow(p.scope);
    expect(stored.status).toBe('succeeded');
    expect(stored.response).toEqual({ ok: true });
    expect(stored.completedAt).not.toBeNull();
  });

  it('denies a zombie claimant the succeeded flip after a reclaim', async () => {
    const p = params();
    const zombie = await expectExecutor(claimKeyRow(db, p));
    await backdateClaim(p.scope);
    await expectExecutor(claimKeyRow(db, { ...p, executorId: 'executor-b' }));
    const flip = await unwrap(succeedKeyRow(db, fenceOf(zombie), { ok: true }));
    expect(flip).toBe('lost');
    const stored = await readRow(p.scope);
    expect(stored.status).toBe('claimed');
    expect(stored.claimedBy).toBe('executor-b');
  });

  it('flips a live claim to failed through the same fence', async () => {
    const p = params();
    const row = await expectExecutor(claimKeyRow(db, p));
    const flip = await unwrap(failKeyRow(db, fenceOf(row)));
    expect(flip).toBe('flipped');
    const stored = await readRow(p.scope);
    expect(stored.status).toBe('failed');
    expect(stored.completedAt).not.toBeNull();
  });

  it('denies a zombie claimant the failed flip after a reclaim', async () => {
    const p = params();
    const zombie = await expectExecutor(claimKeyRow(db, p));
    await backdateClaim(p.scope);
    await expectExecutor(claimKeyRow(db, { ...p, executorId: 'executor-b' }));
    const flip = await unwrap(failKeyRow(db, fenceOf(zombie)));
    expect(flip).toBe('lost');
    const stored = await readRow(p.scope);
    expect(stored.claimedBy).toBe('executor-b');
  });
});

describe('heartbeat lease', () => {
  it('keeps an expired-looking lease alive against a reclaim attempt', async () => {
    const p = params();
    const row = await expectExecutor(claimKeyRow(db, p));
    await backdateClaim(p.scope);
    const beat = await unwrap(heartbeatKeyRow(db, fenceOf(row)));
    expect(beat).toBe('alive');
    const error = await unwrapErr(claimKeyRow(db, { ...p, executorId: 'executor-b' }));
    expect(isIdempotencyConflict(error) && error.wireCode).toBe('REQUEST_IN_PROGRESS');
  });

  it('refuses a zombie heartbeat after the lease was reclaimed', async () => {
    const p = params();
    const zombie = await expectExecutor(claimKeyRow(db, p));
    await backdateClaim(p.scope);
    await expectExecutor(claimKeyRow(db, { ...p, executorId: 'executor-b' }));
    const beat = await unwrap(heartbeatKeyRow(db, fenceOf(zombie)));
    expect(beat).toBe('lost');
    const stored = await readRow(p.scope);
    expect(stored.claims).toBe(2);
    expect(stored.claimedBy).toBe('executor-b');
  });
});
