import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  messages,
  conversations,
  epochs,
  wallets,
  type Database,
} from '@hushbox/db';
import {
  userFactory,
  conversationFactory,
  walletFactory,
  messageFactory,
} from '@hushbox/db/factories';
import { createFirstEpoch, generateKeyPair } from '@hushbox/crypto';
import { deleteMessagesAfterAnchor } from './message-deletion.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

interface TestSetup {
  user: typeof users.$inferSelect;
  conversation: typeof conversations.$inferSelect;
  epoch: typeof epochs.$inferSelect;
  wallet: typeof wallets.$inferSelect;
  epochPrivateKey: Uint8Array;
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

  const walletData = walletFactory.build({
    userId: createdUser.id,
    type: 'purchased',
    balance: '10.00000000',
    priority: 0,
  });
  const [createdWallet] = await db.insert(wallets).values(walletData).returning();
  if (!createdWallet) throw new Error('Failed to create test wallet');

  return {
    user: createdUser,
    conversation: createdConv,
    epoch: createdEpoch,
    wallet: createdWallet,
    epochPrivateKey: epochResult.epochPrivateKey,
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

describe('deleteMessagesAfterAnchor', () => {
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

  describe('no-fork path (forkTipMessageId not provided)', () => {
    it('deletes all messages after the anchor by sequence number', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
      });
      const msg2 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        epochNumber: 1,
        senderId: setup.user.id,
      });
      const msg3 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 3,
        epochNumber: 1,
        senderId: setup.user.id,
      });
      const msg4 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 4,
        epochNumber: 1,
        senderId: setup.user.id,
      });

      const result = await db.transaction(async (tx) => {
        return deleteMessagesAfterAnchor(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          anchorMessageId: msg2.id,
        });
      });

      // Should delete msg3 and msg4
      expect(result.deletedIds).toHaveLength(2);
      expect(result.deletedIds).toContain(msg3.id);
      expect(result.deletedIds).toContain(msg4.id);

      // msg1 and msg2 should still exist
      const remaining = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      expect(remaining).toHaveLength(2);
      expect(remaining.map((m) => m.id).toSorted((a, b) => a.localeCompare(b))).toEqual(
        [msg1.id, msg2.id].toSorted((a, b) => a.localeCompare(b))
      );
    });

    it('returns empty array when no messages exist after anchor', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
      });

      const result = await db.transaction(async (tx) => {
        return deleteMessagesAfterAnchor(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          anchorMessageId: msg1.id,
        });
      });

      expect(result.deletedIds).toHaveLength(0);

      // msg1 still exists
      const [remaining] = await db.select().from(messages).where(eq(messages.id, msg1.id));
      expect(remaining).toBeDefined();
    });

    it('does not delete the anchor message itself', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const anchor = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
      });
      await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        epochNumber: 1,
        senderId: setup.user.id,
      });

      await db.transaction(async (tx) => {
        return deleteMessagesAfterAnchor(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          anchorMessageId: anchor.id,
        });
      });

      const [remaining] = await db.select().from(messages).where(eq(messages.id, anchor.id));
      expect(remaining).toBeDefined();
      expect(remaining!.id).toBe(anchor.id);
    });

    it('does not delete messages from other conversations', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      // Create a second conversation
      const convData2 = conversationFactory.build({ userId: setup.user.id });
      const [conv2] = await db.insert(conversations).values(convData2).returning();
      if (!conv2) throw new Error('Failed to create second conversation');

      await db.insert(epochs).values({
        conversationId: conv2.id,
        epochNumber: 1,
        epochPublicKey: setup.epoch.epochPublicKey,
        confirmationHash: new Uint8Array(32),
      });

      const anchor = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
      });
      await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        epochNumber: 1,
        senderId: setup.user.id,
      });

      const otherMsg = await insertTestMessage(db, {
        conversationId: conv2.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
      });

      await db.transaction(async (tx) => {
        return deleteMessagesAfterAnchor(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          anchorMessageId: anchor.id,
        });
      });

      // Other conversation's message should still exist
      const [remaining] = await db.select().from(messages).where(eq(messages.id, otherMsg.id));
      expect(remaining).toBeDefined();
    });

    it('is idempotent — second call deletes nothing', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const anchor = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
      });
      await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        epochNumber: 1,
        senderId: setup.user.id,
      });

      // First call
      const result1 = await db.transaction(async (tx) => {
        return deleteMessagesAfterAnchor(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          anchorMessageId: anchor.id,
        });
      });
      expect(result1.deletedIds).toHaveLength(1);

      // Second call — idempotent
      const result2 = await db.transaction(async (tx) => {
        return deleteMessagesAfterAnchor(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          anchorMessageId: anchor.id,
        });
      });
      expect(result2.deletedIds).toHaveLength(0);
    });
  });

  describe('fork path (forkTipMessageId provided)', () => {
    it('deletes messages in the fork chain between anchor and tip', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      // Build a chain: msg1 -> msg2 -> msg3 -> msg4
      // anchor = msg1, tip = msg4
      // Should delete msg2, msg3, msg4
      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const msg2 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        epochNumber: 1,
        senderId: setup.user.id,
        parentMessageId: msg1.id,
      });
      const msg3 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 3,
        epochNumber: 1,
        senderId: setup.user.id,
        parentMessageId: msg2.id,
      });
      const msg4 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 4,
        epochNumber: 1,
        senderId: setup.user.id,
        parentMessageId: msg3.id,
      });

      const result = await db.transaction(async (tx) => {
        return deleteMessagesAfterAnchor(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          anchorMessageId: msg1.id,
          forkTipMessageId: msg4.id,
        });
      });

      expect(result.deletedIds).toHaveLength(3);
      expect(result.deletedIds).toContain(msg2.id);
      expect(result.deletedIds).toContain(msg3.id);
      expect(result.deletedIds).toContain(msg4.id);

      // msg1 should still exist (anchor)
      const [remaining] = await db.select().from(messages).where(eq(messages.id, msg1.id));
      expect(remaining).toBeDefined();
    });

    it('does not delete shared messages that have children outside the candidate set', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      // Build a tree:
      // msg1 -> msg2 -> msg3 (fork A tip)
      //              -> msg4 (fork B, outside our chain)
      // anchor = msg1, tip = msg3
      // msg2 is shared (has child msg4 outside candidate set)
      // Should only delete msg3, NOT msg2
      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const msg2 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        epochNumber: 1,
        senderId: setup.user.id,
        parentMessageId: msg1.id,
      });
      const msg3 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 3,
        epochNumber: 1,
        senderId: setup.user.id,
        parentMessageId: msg2.id,
      });
      // msg4 is a sibling of msg3 (branches from msg2)
      const msg4 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 4,
        epochNumber: 1,
        senderId: setup.user.id,
        parentMessageId: msg2.id,
      });

      const result = await db.transaction(async (tx) => {
        return deleteMessagesAfterAnchor(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          anchorMessageId: msg1.id,
          forkTipMessageId: msg3.id,
        });
      });

      // msg3 deleted, msg2 kept (shared, has msg4 as child outside candidate set)
      expect(result.deletedIds).toHaveLength(1);
      expect(result.deletedIds).toContain(msg3.id);

      // msg1, msg2, msg4 should still exist
      const remaining = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      expect(remaining).toHaveLength(3);
      const remainingIds = remaining.map((m) => m.id).toSorted((a, b) => a.localeCompare(b));
      expect(remainingIds).toEqual(
        [msg1.id, msg2.id, msg4.id].toSorted((a, b) => a.localeCompare(b))
      );
    });

    it('does not delete the anchor message', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const msg2 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        epochNumber: 1,
        senderId: setup.user.id,
        parentMessageId: msg1.id,
      });

      await db.transaction(async (tx) => {
        return deleteMessagesAfterAnchor(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          anchorMessageId: msg1.id,
          forkTipMessageId: msg2.id,
        });
      });

      const [anchor] = await db.select().from(messages).where(eq(messages.id, msg1.id));
      expect(anchor).toBeDefined();
    });

    it('returns empty array when tip equals anchor', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });

      const result = await db.transaction(async (tx) => {
        return deleteMessagesAfterAnchor(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          anchorMessageId: msg1.id,
          forkTipMessageId: msg1.id,
        });
      });

      expect(result.deletedIds).toHaveLength(0);
    });

    it('is idempotent — second call deletes nothing', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const msg1 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        epochNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const msg2 = await insertTestMessage(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        epochNumber: 1,
        senderId: setup.user.id,
        parentMessageId: msg1.id,
      });

      // First call
      const result1 = await db.transaction(async (tx) => {
        return deleteMessagesAfterAnchor(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          anchorMessageId: msg1.id,
          forkTipMessageId: msg2.id,
        });
      });
      expect(result1.deletedIds).toHaveLength(1);

      // Second call — idempotent
      const result2 = await db.transaction(async (tx) => {
        return deleteMessagesAfterAnchor(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          anchorMessageId: msg1.id,
          forkTipMessageId: msg1.id,
        });
      });
      expect(result2.deletedIds).toHaveLength(0);
    });

    it('handles a long chain correctly', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      // Build a chain of 6 messages
      const msgIds: string[] = [];
      let parentId: string | null = null;
      for (let index = 1; index <= 6; index++) {
        const msg = await insertTestMessage(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: index,
          epochNumber: 1,
          senderId: setup.user.id,
          parentMessageId: parentId,
        });
        msgIds.push(msg.id);
        parentId = msg.id;
      }

      // Delete from anchor msg2 (index 1) to tip msg6 (index 5)
      const result = await db.transaction(async (tx) => {
        return deleteMessagesAfterAnchor(tx as unknown as Database, {
          conversationId: setup.conversation.id,
          anchorMessageId: msgIds[1]!,
          forkTipMessageId: msgIds[5]!,
        });
      });

      // Should delete msg3, msg4, msg5, msg6
      expect(result.deletedIds).toHaveLength(4);
      expect(result.deletedIds).toContain(msgIds[2]!);
      expect(result.deletedIds).toContain(msgIds[3]!);
      expect(result.deletedIds).toContain(msgIds[4]!);
      expect(result.deletedIds).toContain(msgIds[5]!);

      // msg1 and msg2 should remain
      const remaining = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      expect(remaining).toHaveLength(2);
    });
  });
});
