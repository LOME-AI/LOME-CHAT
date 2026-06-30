import { LOCAL_NEON_DEV_CONFIG, createDb, idempotencyKeys } from '@hushbox/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { unavailableError } from '../errors/index.js';
import { ResultAsync, errAsync } from '../result/index.js';
import { byUpsert } from './by-upsert.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../errors/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for idempotency integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const rival = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const createdUserIds: string[] = [];

function freshUserId(): string {
  const userId = crypto.randomUUID();
  createdUserIds.push(userId);
  return userId;
}

/** Natural-key creation: the scope unique constraint is the guard. */
function insertByNaturalKey(
  client: Database,
  userId: string,
  key: string
): ResultAsync<number, DomainError> {
  return ResultAsync.fromPromise(
    client
      .insert(idempotencyKeys)
      .values({
        userId,
        route: '/device-tokens',
        key,
        kind: 'request',
        bodyHash: 'natural',
        claimedBy: 'upsert',
      })
      .onConflictDoNothing({
        target: [idempotencyKeys.userId, idempotencyKeys.route, idempotencyKeys.key],
      })
      .returning({ id: idempotencyKeys.id }),
    (cause) => unavailableError('insert failed', cause)
  ).map((rows) => rows.length);
}

async function countRows(userId: string): Promise<number> {
  const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));
  return rows.length;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.userId, createdUserIds));
  }
  await db.$client.end();
  await rival.$client.end();
});

describe('idempotent.byUpsert', () => {
  it('creates the row on first delivery', async () => {
    const userId = freshUserId();
    const result = await byUpsert(() => insertByNaturalKey(db, userId, 'token-1'));
    expect(result._unsafeUnwrap()).toBe(1);
    expect(await countRows(userId)).toBe(1);
  });

  it('converges duplicate delivery onto one row', async () => {
    const userId = freshUserId();
    const first = await byUpsert(() => insertByNaturalKey(db, userId, 'token-1'));
    const second = await byUpsert(() => insertByNaturalKey(db, userId, 'token-1'));
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(await countRows(userId)).toBe(1);
  });

  it('creates exactly one row when two deliveries race', async () => {
    const userId = freshUserId();
    const [a, b] = await Promise.all([
      byUpsert(() => insertByNaturalKey(db, userId, 'token-1')),
      byUpsert(() => insertByNaturalKey(rival, userId, 'token-1')),
    ]);
    expect(a.isOk()).toBe(true);
    expect(b.isOk()).toBe(true);
    expect(await countRows(userId)).toBe(1);
  });

  it('commits nothing on failure so a retry can create the row', async () => {
    const userId = freshUserId();
    const failed = await byUpsert(() =>
      errAsync<number, DomainError>(unavailableError('connection dropped'))
    );
    expect(failed._unsafeUnwrapErr().code).toBe('unavailable');
    expect(await countRows(userId)).toBe(0);
    const retry = await byUpsert(() => insertByNaturalKey(db, userId, 'token-1'));
    expect(retry._unsafeUnwrap()).toBe(1);
    expect(await countRows(userId)).toBe(1);
  });
});
