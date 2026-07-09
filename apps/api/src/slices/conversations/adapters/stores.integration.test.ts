import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, conversations, createDb, users } from '@hushbox/db';
import { createConversationsStores } from './stores.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for conversations store tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createConversationsStores(db);

const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

async function seedUserAndConversation(): Promise<{ userId: string; conversationId: string }> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userRows = await db
    .insert(users)
    .values({
      email: `${username}@fork-stores.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: crypto.getRandomValues(new Uint8Array(32)),
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const userId = userRows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  const conversationRows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = conversationRows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(conversationId);
  return { userId, conversationId };
}

async function seedConversation(): Promise<string> {
  const seeded = await seedUserAndConversation();
  return seeded.conversationId;
}

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

/**
 * The real Postgres error chains behind the fork-name catch mapping. The
 * domain pre-checks make these unreachable through the routes (the byKey
 * transaction would abort), so the raw-client store contract is proven here.
 */
describe('fork store unique-violation mapping (real error chains)', () => {
  it('maps the fork-name unique violation to name-taken on insert', async () => {
    const conversationId = await seedConversation();
    const first = await stores.forks.insert({
      id: null,
      conversationId,
      name: 'Dup',
      tipMessageId: null,
    });
    expect(first._unsafeUnwrap()).not.toBe('name-taken');
    const second = await stores.forks.insert({
      id: null,
      conversationId,
      name: 'Dup',
      tipMessageId: null,
    });
    expect(second._unsafeUnwrap()).toBe('name-taken');
  });

  it('maps the fork-name unique violation to name-taken on rename', async () => {
    const conversationId = await seedConversation();
    const seeded = await stores.forks.insert({
      id: null,
      conversationId,
      name: 'One',
      tipMessageId: null,
    });
    expect(seeded._unsafeUnwrap()).not.toBe('name-taken');
    const other = await stores.forks.insert({
      id: null,
      conversationId,
      name: 'Two',
      tipMessageId: null,
    });
    const otherRecord = other._unsafeUnwrap();
    if (otherRecord === 'name-taken') throw new Error('seed fork collided');
    const renamed = await stores.forks.rename({
      conversationId,
      forkId: otherRecord.id,
      name: 'One',
    });
    expect(renamed._unsafeUnwrap()).toBe('name-taken');
  });

  it('answers unavailable for a non-unique constraint failure', async () => {
    const result = await stores.forks.insert({
      id: null,
      conversationId: crypto.randomUUID(),
      name: 'Orphan',
      tipMessageId: null,
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('single-statement contract arms unreachable through the domain', () => {
  it('converges a member insert lost to the active-unique index to null', async () => {
    const { userId, conversationId } = await seedUserAndConversation();
    const insert = {
      conversationId,
      userId,
      privilege: 'write' as const,
      visibleFromEpoch: 1,
      acceptedAt: null,
      invitedByUserId: null,
    };
    const first = await stores.members.insert(insert);
    expect(first._unsafeUnwrap()).not.toBeNull();
    const second = await stores.members.insert(insert);
    expect(second._unsafeUnwrap()).toBeNull();
  });

  it('answers null when marking an unknown member left', async () => {
    const conversationId = await seedConversation();
    const result = await stores.members.markLeft({
      conversationId,
      memberId: crypto.randomUUID(),
    });
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('answers null for a missing epoch number', async () => {
    const conversationId = await seedConversation();
    const missing = await stores.epochs.byNumber(conversationId, 99);
    expect(missing._unsafeUnwrap()).toBeNull();
  });

  it('answers null for the latest message of an empty conversation', async () => {
    const conversationId = await seedConversation();
    const latest = await stores.messages.latestId(conversationId);
    expect(latest._unsafeUnwrap()).toBeNull();
  });
});

describe('conversation budget exposure', () => {
  it('surfaces the configured per-conversation budget on the record', async () => {
    const { userId } = await seedUserAndConversation();
    const rows = await db
      .insert(conversations)
      .values({ userId, title: BYTES, budgetNanoUsd: 3_000_000_000n })
      .returning({ id: conversations.id });
    const conversationId = rows[0]?.id;
    if (conversationId === undefined) throw new Error('budget conversation seed failed');
    createdConversationIds.push(conversationId);

    const found = await stores.conversations.get(conversationId);
    expect(found._unsafeUnwrap()?.budgetNanoUsd).toBe(3_000_000_000n);
  });

  it('defaults an unconfigured conversation budget to zero (unlimited)', async () => {
    const conversationId = await seedConversation();
    const found = await stores.conversations.get(conversationId);
    expect(found._unsafeUnwrap()?.budgetNanoUsd).toBe(0n);
  });
});
