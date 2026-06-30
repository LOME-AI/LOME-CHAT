import { LOCAL_NEON_DEV_CONFIG, createDb, idempotencyKeys } from '@hushbox/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { unavailableError } from '../errors/index.js';
import { ResultAsync, errAsync, okAsync } from '../result/index.js';
import { byTransition } from './by-transition.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../errors/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for idempotency integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const rival = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const createdUserIds: string[] = [];

/** A state-machine row: claimed → failed is the step under test. */
async function seedRow(): Promise<{ id: string; userId: string }> {
  const userId = crypto.randomUUID();
  createdUserIds.push(userId);
  const rows = await db
    .insert(idempotencyKeys)
    .values({
      userId,
      route: '/payments',
      key: crypto.randomUUID(),
      kind: 'request',
      bodyHash: 'machine',
      claimedBy: 'state-machine',
    })
    .returning({ id: idempotencyKeys.id });
  const row = rows[0];
  if (row === undefined) throw new Error('seed insert returned no row');
  return { id: row.id, userId };
}

/** One atomic conditional UPDATE; null signals 0 rows matched. */
function transitionToFailed(client: Database, id: string): ResultAsync<string | null, DomainError> {
  return ResultAsync.fromPromise(
    client
      .update(idempotencyKeys)
      .set({ status: 'failed' })
      .where(and(eq(idempotencyKeys.id, id), eq(idempotencyKeys.status, 'claimed')))
      .returning({ id: idempotencyKeys.id }),
    (cause) => unavailableError('transition failed', cause)
  ).map((rows) => rows[0]?.id ?? null);
}

async function statusOf(id: string): Promise<string> {
  const rows = await db
    .select({ status: idempotencyKeys.status })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.id, id));
  const row = rows[0];
  if (row === undefined) throw new Error('expected a row');
  return row.status;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.userId, createdUserIds));
  }
  await db.$client.end();
  await rival.$client.end();
});

describe('idempotent.byTransition', () => {
  it('applies the transition when the expected state matches', async () => {
    const { id } = await seedRow();
    const result = await byTransition({
      transition: () => transitionToFailed(db, id),
      onZeroRows: () => okAsync('disambiguated'),
    });
    expect(result._unsafeUnwrap()).toBe(id);
    expect(await statusOf(id)).toBe('failed');
  });

  it('resolves duplicate delivery through zero-row disambiguation', async () => {
    const { id } = await seedRow();
    let disambiguations = 0;
    const run = (): ResultAsync<string | null, DomainError> =>
      byTransition({
        transition: () => transitionToFailed(db, id),
        onZeroRows: () => {
          disambiguations += 1;
          return okAsync('already-failed');
        },
      });
    const first = await run();
    const second = await run();
    expect(first._unsafeUnwrap()).toBe(id);
    expect(second._unsafeUnwrap()).toBe('already-failed');
    expect(disambiguations).toBe(1);
  });

  it('grants the transition to exactly one racing caller', async () => {
    const { id } = await seedRow();
    const run = (client: Database): ResultAsync<string | null, DomainError> =>
      byTransition({
        transition: () => transitionToFailed(client, id),
        onZeroRows: () => okAsync('already-failed'),
      });
    const [a, b] = await Promise.all([run(db), run(rival)]);
    const values = [a._unsafeUnwrap(), b._unsafeUnwrap()];
    expect(new Set(values)).toEqual(new Set([id, 'already-failed']));
    expect(values.filter((v) => v === id)).toHaveLength(1);
  });

  it('keeps an illegal-state defect thrown from disambiguation throwing', async () => {
    const { id } = await seedRow();
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
    await expect(
      byTransition({
        transition: () => transitionToFailed(db, id),
        onZeroRows: () => {
          throw new Error('illegal state: row missing');
        },
      })
    ).rejects.toThrow('illegal state');
  });

  it('propagates transition errors without disambiguating', async () => {
    let disambiguations = 0;
    const result = await byTransition({
      transition: () => errAsync<string | null, DomainError>(unavailableError('connection lost')),
      onZeroRows: () => {
        disambiguations += 1;
        return okAsync('never');
      },
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(disambiguations).toBe(0);
  });
});
