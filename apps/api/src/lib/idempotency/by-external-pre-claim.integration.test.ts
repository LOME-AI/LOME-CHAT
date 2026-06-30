import { LOCAL_NEON_DEV_CONFIG, createDb, idempotencyKeys } from '@hushbox/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { unavailableError } from '../errors/index.js';
import { ResultAsync, errAsync, okAsync } from '../result/index.js';
import { byExternalPreClaim } from './by-external-pre-claim.js';
import type { DomainError } from '../errors/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for idempotency integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
// The reconciliation reader: its own connection, the way a verify job's
// isolate would see the data.
const reconciler = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const createdUserIds: string[] = [];

const PRE_CLAIM_ROUTE = '/payments/charge';

function freshUserId(): string {
  const userId = crypto.randomUUID();
  createdUserIds.push(userId);
  return userId;
}

/** The durable pre-claim: a pending row written before the charge. */
function writePreClaim(userId: string): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    db
      .insert(idempotencyKeys)
      .values({
        userId,
        route: PRE_CLAIM_ROUTE,
        key: crypto.randomUUID(),
        kind: 'request',
        bodyHash: 'pre-claim',
        claimedBy: 'charger',
      })
      .returning({ id: idempotencyKeys.id }),
    (cause) => unavailableError('pre-claim failed', cause)
  ).map((rows) => {
    const row = rows[0];
    if (row === undefined) throw new Error('pre-claim insert returned no row');
    return row.id;
  });
}

function finalizePreClaim(id: string): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    db
      .update(idempotencyKeys)
      .set({ status: 'succeeded', completedAt: sql`now()` })
      .where(eq(idempotencyKeys.id, id))
      .returning({ id: idempotencyKeys.id }),
    (cause) => unavailableError('finalize failed', cause)
  ).map(() => id);
}

/** The verify-job query: pre-claims never finalized. */
async function findStalePreClaims(userId: string): Promise<string[]> {
  const rows = await reconciler
    .select({ id: idempotencyKeys.id })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.route, PRE_CLAIM_ROUTE),
        eq(idempotencyKeys.status, 'claimed')
      )
    );
  return rows.map((row) => row.id);
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.userId, createdUserIds));
  }
  await db.$client.end();
  await reconciler.$client.end();
});

describe('idempotent.byExternalPreClaim', () => {
  it('runs pre-claim, external call, and finalize in order', async () => {
    const userId = freshUserId();
    const order: string[] = [];
    const result = await byExternalPreClaim({
      preClaim: () =>
        writePreClaim(userId).map((id) => {
          order.push('pre-claim');
          return id;
        }),
      external: () => {
        order.push('external');
        return okAsync({ chargeId: 'ch_1' });
      },
      finalize: (id) =>
        finalizePreClaim(id).map((finalized) => {
          order.push('finalize');
          return finalized;
        }),
    });
    expect(result.isOk()).toBe(true);
    expect(order).toEqual(['pre-claim', 'external', 'finalize']);
    expect(await findStalePreClaims(userId)).toEqual([]);
  });

  it('commits the pre-claim durably before the external call runs', async () => {
    const userId = freshUserId();
    let visibleDuringExternal: string[] = [];
    const result = await byExternalPreClaim({
      preClaim: () => writePreClaim(userId),
      external: () =>
        ResultAsync.fromSafePromise(findStalePreClaims(userId)).andThen((found) => {
          visibleDuringExternal = found;
          return okAsync({ chargeId: 'ch_2' });
        }),
      finalize: (id) => finalizePreClaim(id),
    });
    expect(result.isOk()).toBe(true);
    expect(visibleDuringExternal).toHaveLength(1);
  });

  it('leaves the pre-claim discoverable when the process dies after the external effect', async () => {
    const userId = freshUserId();
    // Crash between the external call and finalize: finalize never runs.
    await expect(
      byExternalPreClaim({
        preClaim: () => writePreClaim(userId),
        external: () => okAsync({ chargeId: 'ch_3' }),
        finalize: () => {
          throw new Error('process died');
        },
      })
    ).rejects.toThrow('process died');
    const stale = await findStalePreClaims(userId);
    expect(stale).toHaveLength(1);
  });

  it('leaves the pre-claim pending when the external call fails', async () => {
    const userId = freshUserId();
    let finalized = 0;
    const result = await byExternalPreClaim({
      preClaim: () => writePreClaim(userId),
      external: () =>
        errAsync<{ chargeId: string }, DomainError>(unavailableError('processor timeout')),
      finalize: (id) => {
        finalized += 1;
        return finalizePreClaim(id);
      },
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(finalized).toBe(0);
    expect(await findStalePreClaims(userId)).toHaveLength(1);
  });

  it('never reaches the external call when the pre-claim fails', async () => {
    let externals = 0;
    const result = await byExternalPreClaim({
      preClaim: () => errAsync<string, DomainError>(unavailableError('insert failed')),
      external: () => {
        externals += 1;
        return okAsync({ chargeId: 'ch_4' });
      },
      finalize: (id: string) => okAsync(id),
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(externals).toBe(0);
  });
});
