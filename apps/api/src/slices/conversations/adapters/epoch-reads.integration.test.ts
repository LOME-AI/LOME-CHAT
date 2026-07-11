import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, conversations, createDb, epochs, users } from '@hushbox/db';
import { createEpochPublicKeyReader } from './epoch-reads.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for epoch-reads integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([5, 5, 5]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

async function seedConversationWithEpoch(epochPublicKey: Uint8Array): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const userRows = await db
    .insert(users)
    .values({
      email: `${suffix}@epoch-key.test`,
      username: `ek${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
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
  await db.insert(epochs).values({
    conversationId,
    epochNumber: 1,
    epochPublicKey,
    confirmationHash: BYTES,
  });
  return conversationId;
}

describe('createEpochPublicKeyReader (conversations-published reader)', () => {
  it('reads the epoch public key for the exact (conversation, epoch) pair', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const conversationId = await seedConversationWithEpoch(key);
    const read = createEpochPublicKeyReader();
    expect(await read(db, conversationId, 1)).toEqual(key);
  });

  it('answers null for an absent epoch', async () => {
    const conversationId = await seedConversationWithEpoch(BYTES);
    const read = createEpochPublicKeyReader();
    expect(await read(db, conversationId, 2)).toBeNull();
  });
});
