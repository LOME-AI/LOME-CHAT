import { afterAll, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationForks,
  conversations,
  createDb,
  epochs,
  messages,
  users,
} from '@hushbox/db';
import { createConversationsStores } from '../adapters/stores.js';
import { advanceForkTipWithinTx, resolveForkTipWithinTx } from './fork-tip.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The highest-risk cross-path fork race: a settling turn advancing a fork's tip
 * vs a concurrent `PUT /forks/:id/tip` on the SAME fork. Both take the fork row
 * `FOR UPDATE` (`resolveForkTipWithinTx` / the route's `lockById`) and both CAS
 * with the identical `IS NOT DISTINCT FROM expected` predicate, so the settling
 * turn's lock serializes the PUT and the PUT's now-stale expected tip loses.
 *
 * A full mid-settlement-pause race is inherently flaky; this proves the lock
 * level deterministically instead. Two real connections: A holds the fork lock
 * across a barrier while B, under a short `lock_timeout`, provably blocks trying
 * to take the same lock; after A commits its tip advance, B's stale CAS finds
 * zero rows — the conflict outcome the route maps. No sleeps, no polling.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for fork-tip settlement serialization tests');
}

// Two independent pools (each `max: 1`) = two distinct Postgres connections, the
// prerequisite for observing one blocking on the other's row lock.
const dbA = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const dbB = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([5, 5, 5]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

/** Postgres `lock_not_available` (55P03), the deterministic "was blocked" signal. */
function isLockTimeout(error: DomainError): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    if ((current as { code?: unknown }).code === '55P03') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

interface ForkFixture {
  readonly conversationId: string;
  readonly forkId: string;
  readonly oldTip: string;
  readonly newTip: string;
}

/** Fails the seed loudly rather than letting an undefined id flow downstream. */
function requireSeeded<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} seed failed`);
  return value;
}

async function seedForkFixture(): Promise<ForkFixture> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const userRows = await dbA
    .insert(users)
    .values({
      email: `${suffix}@fork-tip-settle.test`,
      username: `fts${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const userId = requireSeeded(userRows[0]?.id, 'user');
  createdUserIds.push(userId);

  const conversationRows = await dbA
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = requireSeeded(conversationRows[0]?.id, 'conversation');
  createdConversationIds.push(conversationId);

  await dbA.insert(epochs).values({
    conversationId,
    epochNumber: 1,
    epochPublicKey: BYTES,
    confirmationHash: BYTES,
  });

  const messageRows = await dbA
    .insert(messages)
    .values([
      {
        conversationId,
        senderType: 'user',
        wrappedContentKey: BYTES,
        epochNumber: 1,
        sequenceNumber: 1,
      },
      {
        conversationId,
        senderType: 'assistant',
        wrappedContentKey: BYTES,
        epochNumber: 1,
        sequenceNumber: 2,
      },
    ])
    .returning({ id: messages.id });
  const oldTip = requireSeeded(messageRows[0]?.id, 'first message');
  const newTip = requireSeeded(messageRows[1]?.id, 'second message');

  const forkRows = await dbA
    .insert(conversationForks)
    .values({ conversationId, name: 'F1', tipMessageId: oldTip })
    .returning({ id: conversationForks.id });
  const forkId = requireSeeded(forkRows[0]?.id, 'fork');

  return { conversationId, forkId, oldTip, newTip };
}

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await dbA.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await dbA.delete(users).where(inArray(users.id, createdUserIds));
  }
  await dbA.$client.end();
  await dbB.$client.end();
});

describe('fork-tip settlement-vs-PUT serialization', () => {
  it('blocks a concurrent PUT lock while a settling turn holds the fork FOR UPDATE, then the stale CAS loses', async () => {
    const { conversationId, forkId, oldTip, newTip } = await seedForkFixture();

    // Barrier promises make "A holds the lock before B tries" deterministic.
    let signalLocked!: () => void;
    const aLocked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseA!: () => void;
    const aHeld = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    // A = the settling turn: resolve (FOR UPDATE-lock) the tip, hold the lock
    // across the rest of settlement (the barrier stands in), then advance + commit.
    const aTxn = dbA.transaction(async (tx) => {
      const stores = createConversationsStores(tx);
      const resolved = await resolveForkTipWithinTx(stores, { conversationId, forkId });
      expect(resolved._unsafeUnwrap().tipMessageId).toBe(oldTip);
      signalLocked();
      await aHeld;
      const advanced = await advanceForkTipWithinTx(stores, {
        conversationId,
        forkId,
        expectedTipMessageId: oldTip,
        newTipMessageId: newTip,
      });
      expect(advanced._unsafeUnwrap()).toBe(true);
    });

    await aLocked;

    // B = the PUT /tip route: it cannot even take the fork's FOR UPDATE lock
    // while A holds it. A short lock_timeout turns "blocked" into a deterministic
    // 55P03 rather than an indefinite wait.
    const blocked = await dbB.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '750ms'`);
      return createConversationsStores(tx).forks.lockById(conversationId, forkId);
    });
    expect(blocked.isErr()).toBe(true);
    expect(isLockTimeout(blocked._unsafeUnwrapErr())).toBe(true);

    // Release A: it advances the tip (oldTip → newTip) and commits.
    releaseA();
    await aTxn;

    // B now sees the committed advance; its CAS with the now-stale expected tip
    // matches zero rows — the null the route disambiguates into a tip-conflict.
    const storesB = createConversationsStores(dbB);
    const staleCas = await storesB.forks.updateTip({
      conversationId,
      forkId,
      expectedTipMessageId: oldTip,
      tipMessageId: oldTip,
    });
    expect(staleCas._unsafeUnwrap()).toBeNull();

    const current = await storesB.forks.byId(conversationId, forkId);
    expect(current._unsafeUnwrap()?.tipMessageId).toBe(newTip);
  });

  it('takes the fork FOR UPDATE lock without timing out when uncontended', async () => {
    // The causation control: the same short lock_timeout succeeds with no
    // contender, so the timeout above is A's lock, not a misconfigured budget.
    const { conversationId, forkId, oldTip } = await seedForkFixture();

    const locked = await dbB.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '750ms'`);
      return createConversationsStores(tx).forks.lockById(conversationId, forkId);
    });

    expect(locked._unsafeUnwrap()?.tipMessageId).toBe(oldTip);
  });
});
