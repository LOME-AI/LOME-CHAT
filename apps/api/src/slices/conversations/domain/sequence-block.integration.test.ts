import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, conversations, createDb, users } from '@hushbox/db';
import { createConversationsStores } from '../adapters/stores.js';
import { reserveSequenceBlockWithinTx } from './sequence-block.js';

/**
 * The conversation's monotonic sequence counter (`conversations.nextSequence`)
 * is the single source of message ordering: each turn reserves a contiguous
 * block, and reserved numbers are never reused (unlike a `MAX(sequence)+1`
 * scan, which reuses numbers after a delete). Single-writer: conversations
 * owns the counter; chat composes this published helper inside its settlement.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for sequence-block tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

async function seedConversation(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const userRows = await db
    .insert(users)
    .values({
      email: `${suffix}@seq-block.test`,
      username: `sb${suffix}`,
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
  return conversationId;
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

describe('reserveSequenceBlockWithinTx', () => {
  it('reserves a contiguous block from the counter, lowest first', async () => {
    const conversationId = await seedConversation();
    const result = await reserveSequenceBlockWithinTx(createConversationsStores(db), {
      conversationId,
      count: 2,
    });
    // A fresh conversation starts its counter at 1, so the first block is [1, 2].
    expect(result._unsafeUnwrap()).toEqual([1, 2]);
  });

  it('never reuses a number: a second reservation continues past the first', async () => {
    const conversationId = await seedConversation();
    const first = await reserveSequenceBlockWithinTx(createConversationsStores(db), {
      conversationId,
      count: 2,
    });
    expect(first._unsafeUnwrap()).toEqual([1, 2]);
    const second = await reserveSequenceBlockWithinTx(createConversationsStores(db), {
      conversationId,
      count: 3,
    });
    expect(second._unsafeUnwrap()).toEqual([3, 4, 5]);
    // The counter advanced by exactly the reserved counts.
    const rows = await db
      .select({ next: conversations.nextSequence })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(rows[0]?.next).toBe(6);
  });

  it('errors not_found when the conversation does not exist', async () => {
    const result = await reserveSequenceBlockWithinTx(createConversationsStores(db), {
      conversationId: crypto.randomUUID(),
      count: 2,
    });
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });
});
