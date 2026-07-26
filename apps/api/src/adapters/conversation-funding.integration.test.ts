import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  users,
} from '@hushbox/db';
import { createConversationFundingReader } from './conversation-funding.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for conversation funding reader tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const read = createConversationFundingReader(db);
const BYTES = new Uint8Array([5, 5, 5]);
const CONVERSATION_CAP = 3_000_000_000n;

const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

async function seedUser(): Promise<string> {
  const username = `zzcf${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@conversation-funding.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: crypto.getRandomValues(new Uint8Array(32)),
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

async function seedConversation(ownerUserId: string): Promise<string> {
  const conversationId = crypto.randomUUID();
  await db.insert(conversations).values({
    id: conversationId,
    userId: ownerUserId,
    title: BYTES,
    conversationBudgetNanoUsd: CONVERSATION_CAP,
  });
  createdConversationIds.push(conversationId);
  return conversationId;
}

async function seedMember(conversationId: string, userId: string): Promise<string> {
  const rows = await db
    .insert(conversationMembers)
    .values({
      conversationId,
      userId,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    })
    .returning({ id: conversationMembers.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('member seed failed');
  return id;
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

describe('createConversationFundingReader', () => {
  it("resolves a member's own membership row as the member-budget scope", async () => {
    const ownerUserId = await seedUser();
    const memberUserId = await seedUser();
    const conversationId = await seedConversation(ownerUserId);
    const memberId = await seedMember(conversationId, memberUserId);

    const facts = await read({ conversationId, callerUserId: memberUserId });
    expect(facts._unsafeUnwrap()).toEqual({
      conversationId,
      memberId,
      ownerUserId,
      conversationBudgetNanoUsd: CONVERSATION_CAP,
    });
  });

  it('answers null for the conversation owner — an owner funds their own turns', async () => {
    const ownerUserId = await seedUser();
    const conversationId = await seedConversation(ownerUserId);
    await seedMember(conversationId, ownerUserId);

    const facts = await read({ conversationId, callerUserId: ownerUserId });
    expect(facts._unsafeUnwrap()).toBeNull();
  });

  it('answers null for a caller with no active membership', async () => {
    const ownerUserId = await seedUser();
    const strangerUserId = await seedUser();
    const conversationId = await seedConversation(ownerUserId);

    const facts = await read({ conversationId, callerUserId: strangerUserId });
    expect(facts._unsafeUnwrap()).toBeNull();
  });

  it('answers null for an absent conversation', async () => {
    const callerUserId = await seedUser();
    const facts = await read({ conversationId: crypto.randomUUID(), callerUserId });
    expect(facts._unsafeUnwrap()).toBeNull();
  });
});
