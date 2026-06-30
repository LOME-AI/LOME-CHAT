import { LOCAL_NEON_DEV_CONFIG, createDb, idempotencyKeys } from '@hushbox/db';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { unavailableError } from '../errors/index.js';
import { ResultAsync, errAsync, okAsync } from '../result/index.js';
import { byEventId } from './by-event-id.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../errors/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for idempotency integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const rival = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const createdUserIds: string[] = [];

function freshEvent(): { userId: string; eventId: string } {
  const userId = crypto.randomUUID();
  createdUserIds.push(userId);
  return { userId, eventId: crypto.randomUUID() };
}

/**
 * The Postgres claim tier: a unique insert on the provider's event id —
 * money events always claim in Postgres.
 */
function claimEvent(
  client: Database,
  userId: string,
  eventId: string
): ResultAsync<boolean, DomainError> {
  return ResultAsync.fromPromise(
    client
      .insert(idempotencyKeys)
      .values({
        userId,
        route: '/webhooks/helcim',
        key: eventId,
        kind: 'request',
        bodyHash: 'event',
        claimedBy: 'webhook-consumer',
      })
      .onConflictDoNothing({
        target: [idempotencyKeys.userId, idempotencyKeys.route, idempotencyKeys.key],
      })
      .returning({ id: idempotencyKeys.id }),
    (cause) => unavailableError('event claim failed', cause)
  ).map((rows) => rows.length === 1);
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.userId, createdUserIds));
  }
  await db.$client.end();
  await rival.$client.end();
});

describe('idempotent.byEventId', () => {
  it('claims and executes on first delivery', async () => {
    const { userId, eventId } = freshEvent();
    let effects = 0;
    const result = await byEventId({
      claim: () => claimEvent(db, userId, eventId),
      execute: () => {
        effects += 1;
        return okAsync('credited');
      },
      onDuplicate: () => okAsync('duplicate'),
    });
    expect(result._unsafeUnwrap()).toBe('credited');
    expect(effects).toBe(1);
  });

  it('skips execution on duplicate delivery', async () => {
    const { userId, eventId } = freshEvent();
    let effects = 0;
    const run = (): ResultAsync<string, DomainError> =>
      byEventId({
        claim: () => claimEvent(db, userId, eventId),
        execute: () => {
          effects += 1;
          return okAsync('credited');
        },
        onDuplicate: () => okAsync('duplicate'),
      });
    const first = await run();
    const second = await run();
    expect(first._unsafeUnwrap()).toBe('credited');
    expect(second._unsafeUnwrap()).toBe('duplicate');
    expect(effects).toBe(1);
  });

  it('executes exactly once when two deliveries race', async () => {
    const { userId, eventId } = freshEvent();
    let effects = 0;
    const run = (client: Database): ResultAsync<string, DomainError> =>
      byEventId({
        claim: () => claimEvent(client, userId, eventId),
        execute: () => {
          effects += 1;
          return okAsync('credited');
        },
        onDuplicate: () => okAsync('duplicate'),
      });
    const [a, b] = await Promise.all([run(db), run(rival)]);
    const values = [a._unsafeUnwrap(), b._unsafeUnwrap()];
    expect(new Set(values)).toEqual(new Set(['credited', 'duplicate']));
    expect(effects).toBe(1);
  });

  it('propagates a claim failure without executing', async () => {
    let effects = 0;
    const result = await byEventId({
      claim: () => errAsync<boolean, DomainError>(unavailableError('store down')),
      execute: () => {
        effects += 1;
        return okAsync('credited');
      },
      onDuplicate: () => okAsync('duplicate'),
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(effects).toBe(0);
  });
});
