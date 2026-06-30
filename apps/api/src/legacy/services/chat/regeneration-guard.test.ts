import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  messages,
  conversations,
  conversationMembers,
  epochs,
  type Database,
} from '@hushbox/db';
import {
  userFactory,
  conversationFactory,
  conversationMemberFactory,
  messageFactory,
} from '@hushbox/db/factories';
import { createFirstEpoch, generateKeyPair } from '@hushbox/crypto';
import { canRegenerate } from './regeneration-guard.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

interface TestSetup {
  user: typeof users.$inferSelect;
  conversation: typeof conversations.$inferSelect;
  epoch: typeof epochs.$inferSelect;
}

async function createTestSetup(db: Database): Promise<TestSetup> {
  const accountKeyPair = generateKeyPair();
  const userData = userFactory.build({ publicKey: accountKeyPair.publicKey });
  const [createdUser] = await db.insert(users).values(userData).returning();
  if (!createdUser) throw new Error('Failed to create test user');

  const convData = conversationFactory.build({ userId: createdUser.id });
  const [createdConv] = await db.insert(conversations).values(convData).returning();
  if (!createdConv) throw new Error('Failed to create test conversation');

  const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
  const [createdEpoch] = await db
    .insert(epochs)
    .values({
      conversationId: createdConv.id,
      epochNumber: 1,
      epochPublicKey: epochResult.epochPublicKey,
      confirmationHash: epochResult.confirmationHash,
    })
    .returning();
  if (!createdEpoch) throw new Error('Failed to create test epoch');

  return {
    user: createdUser,
    conversation: createdConv,
    epoch: createdEpoch,
  };
}

async function insertTestMessage(
  db: Database,
  overrides: Partial<typeof messages.$inferSelect> & {
    conversationId: string;
    sequenceNumber: number;
    epochNumber: number;
  }
): Promise<typeof messages.$inferSelect> {
  const data = messageFactory.build({
    senderType: 'user',
    ...overrides,
  });
  const [msg] = await db.insert(messages).values(data).returning();
  if (!msg) throw new Error('Failed to insert test message');
  return msg;
}

describe('canRegenerate', () => {
  let db: Database;
  const createdUserIds: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterEach(async () => {
    for (const userId of createdUserIds) {
      await db.delete(conversations).where(eq(conversations.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    createdUserIds.length = 0;
  });

  describe('solo chats', () => {
    it('returns true for solo chat with own messages', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
        senderType: 'user',
        parentMessageId: null,
      });
      const msg2 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        epochNumber: 1,
        senderType: 'ai',
        senderId: null,
        parentMessageId: msg1.id,
      });

      const result = await db.transaction(async (tx) => {
        return canRegenerate(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          targetMessageId: msg2.id,
          userId: setup.user.id,
        });
      });

      expect(result).toBe(true);
    });

    it('returns true for solo chat even when target is an AI message', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
        senderType: 'user',
        parentMessageId: null,
      });

      const result = await db.transaction(async (tx) => {
        return canRegenerate(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          targetMessageId: msg1.id,
          userId: setup.user.id,
        });
      });

      expect(result).toBe(true);
    });
  });

  describe('group chats', () => {
    it('returns true when all user messages between target and tip are from the requesting user', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      // Create a member user
      const memberUserData = userFactory.build();
      const [memberUser] = await db.insert(users).values(memberUserData).returning();
      if (!memberUser) throw new Error('Failed to create member user');
      createdUserIds.push(memberUser.id);

      // Add member to conversation
      const memberData = conversationMemberFactory.build({
        conversationId: setup.conversation.id,
        userId: memberUser.id,
        privilege: 'write',
        visibleFromEpoch: 1,
      });
      await db.insert(conversationMembers).values(memberData);

      // All messages from the requesting user
      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
        senderType: 'user',
        parentMessageId: null,
      });
      const msg2 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        epochNumber: 1,
        senderType: 'ai',
        senderId: null,
        parentMessageId: msg1.id,
      });
      const msg3 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 3,
        epochNumber: 1,
        senderId: setup.user.id,
        senderType: 'user',
        parentMessageId: msg2.id,
      });

      const result = await db.transaction(async (tx) => {
        return canRegenerate(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          targetMessageId: msg1.id,
          userId: setup.user.id,
          forkTipMessageId: msg3.id,
        });
      });

      expect(result).toBe(true);
    });

    it('returns false when a user message between target and tip is from a different user', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const memberUserData = userFactory.build();
      const [memberUser] = await db.insert(users).values(memberUserData).returning();
      if (!memberUser) throw new Error('Failed to create member user');
      createdUserIds.push(memberUser.id);

      const memberData = conversationMemberFactory.build({
        conversationId: setup.conversation.id,
        userId: memberUser.id,
        privilege: 'write',
        visibleFromEpoch: 1,
      });
      await db.insert(conversationMembers).values(memberData);

      // msg1: owner, msg2: AI, msg3: member (different user)
      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
        senderType: 'user',
        parentMessageId: null,
      });
      const msg2 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        epochNumber: 1,
        senderType: 'ai',
        senderId: null,
        parentMessageId: msg1.id,
      });
      const msg3 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 3,
        epochNumber: 1,
        senderId: memberUser.id,
        senderType: 'user',
        parentMessageId: msg2.id,
      });

      const result = await db.transaction(async (tx) => {
        return canRegenerate(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          targetMessageId: msg1.id,
          userId: setup.user.id,
          forkTipMessageId: msg3.id,
        });
      });

      expect(result).toBe(false);
    });

    it('ignores AI messages when checking sender ownership', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const memberUserData = userFactory.build();
      const [memberUser] = await db.insert(users).values(memberUserData).returning();
      if (!memberUser) throw new Error('Failed to create member user');
      createdUserIds.push(memberUser.id);

      const memberData = conversationMemberFactory.build({
        conversationId: setup.conversation.id,
        userId: memberUser.id,
        privilege: 'write',
        visibleFromEpoch: 1,
      });
      await db.insert(conversationMembers).values(memberData);

      // user msg -> AI msg -> user msg (same user) — AI in the middle is fine
      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
        senderType: 'user',
        parentMessageId: null,
      });
      const msg2 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        epochNumber: 1,
        senderType: 'ai',
        senderId: null,
        parentMessageId: msg1.id,
      });
      const msg3 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 3,
        epochNumber: 1,
        senderId: setup.user.id,
        senderType: 'user',
        parentMessageId: msg2.id,
      });

      const result = await db.transaction(async (tx) => {
        return canRegenerate(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          targetMessageId: msg1.id,
          userId: setup.user.id,
          forkTipMessageId: msg3.id,
        });
      });

      expect(result).toBe(true);
    });

    it('returns true when target equals tip (no messages to check)', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const memberUserData = userFactory.build();
      const [memberUser] = await db.insert(users).values(memberUserData).returning();
      if (!memberUser) throw new Error('Failed to create member user');
      createdUserIds.push(memberUser.id);

      const memberData = conversationMemberFactory.build({
        conversationId: setup.conversation.id,
        userId: memberUser.id,
        privilege: 'write',
        visibleFromEpoch: 1,
      });
      await db.insert(conversationMembers).values(memberData);

      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
        senderType: 'user',
        parentMessageId: null,
      });

      const result = await db.transaction(async (tx) => {
        return canRegenerate(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          targetMessageId: msg1.id,
          userId: setup.user.id,
          forkTipMessageId: msg1.id,
        });
      });

      expect(result).toBe(true);
    });

    it('uses last message as tip when forkTipMessageId is not provided in group chat', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const memberUserData = userFactory.build();
      const [memberUser] = await db.insert(users).values(memberUserData).returning();
      if (!memberUser) throw new Error('Failed to create member user');
      createdUserIds.push(memberUser.id);

      const memberData = conversationMemberFactory.build({
        conversationId: setup.conversation.id,
        userId: memberUser.id,
        privilege: 'write',
        visibleFromEpoch: 1,
      });
      await db.insert(conversationMembers).values(memberData);

      // msg1 from owner, msg2 from member — without forkTipMessageId
      // walks from last message (msg2) backwards
      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
        senderType: 'user',
        parentMessageId: null,
      });
      await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        epochNumber: 1,
        senderId: memberUser.id,
        senderType: 'user',
        parentMessageId: msg1.id,
      });

      // Owner tries to regenerate from msg1 — msg2 from different user is in the way
      const result = await db.transaction(async (tx) => {
        return canRegenerate(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          targetMessageId: msg1.id,
          userId: setup.user.id,
        });
      });

      expect(result).toBe(false);
    });
  });
});
