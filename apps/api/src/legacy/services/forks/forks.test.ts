import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, asc } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  messages,
  contentItems,
  conversations,
  conversationMembers,
  epochs,
  conversationForks,
  type Database,
} from '@hushbox/db';
import { userFactory, conversationFactory, conversationMemberFactory } from '@hushbox/db/factories';
import { createFirstEpoch, generateKeyPair } from '@hushbox/crypto';
import { placeholderBytes } from '@hushbox/db/factories';
import {
  MAX_FORKS_PER_CONVERSATION,
  ERROR_CODE_FORK_LIMIT_REACHED,
  ERROR_CODE_FORK_NAME_TAKEN,
} from '@hushbox/shared';
import { createFork, deleteFork, renameFork, ForkError } from './forks.js';

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

  const convData = conversationFactory.build({ userId: createdUser.id, nextSequence: 1 });
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

  const memberData = conversationMemberFactory.build({
    conversationId: createdConv.id,
    userId: createdUser.id,
    privilege: 'owner',
    visibleFromEpoch: 1,
    acceptedAt: new Date(),
    leftAt: null,
  });
  await db.insert(conversationMembers).values(memberData);

  return {
    user: createdUser,
    conversation: createdConv,
    epoch: createdEpoch,
  };
}

const textBlob = placeholderBytes(64);
const wrappedContentKey = placeholderBytes(81);

/** Generates a unique message ID to avoid PK collisions across test runs. */
function msgId(): string {
  return crypto.randomUUID();
}

async function insertMessage(
  db: Database,
  params: {
    id: string;
    conversationId: string;
    sequenceNumber: number;
    senderType: string;
    senderId?: string;
    parentMessageId?: string | null;
  }
): Promise<void> {
  await db.insert(messages).values({
    id: params.id,
    conversationId: params.conversationId,
    wrappedContentKey,
    senderType: params.senderType,
    senderId: params.senderId,
    epochNumber: 1,
    sequenceNumber: params.sequenceNumber,
    parentMessageId: params.parentMessageId ?? undefined,
  });
  await db.insert(contentItems).values({
    messageId: params.id,
    contentType: 'text',
    position: 0,
    encryptedBlob: textBlob,
    ...(params.senderType === 'ai' ? { modelName: 'test-model' } : {}),
    isSmartModel: false,
  });
}

describe('createFork', () => {
  let db: Database;
  const createdUserIds: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterEach(async () => {
    for (const userId of createdUserIds) {
      // Conversations cascade to messages, forks, epochs, and members
      await db.delete(conversations).where(eq(conversations.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    createdUserIds.length = 0;
  });

  it('creates Main + Fork 1 when no forks exist', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const m1 = msgId();
    const m2 = msgId();
    const m3 = msgId();

    await insertMessage(db, {
      id: m1,
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: null,
    });
    await insertMessage(db, {
      id: m2,
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      senderType: 'ai',
      parentMessageId: m1,
    });
    await insertMessage(db, {
      id: m3,
      conversationId: setup.conversation.id,
      sequenceNumber: 3,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: m2,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 4 })
      .where(eq(conversations.id, setup.conversation.id));

    const forkId = crypto.randomUUID();
    const result = await createFork(db, {
      id: forkId,
      conversationId: setup.conversation.id,
      fromMessageId: m2,
    });

    expect(result.isNew).toBe(true);
    expect(result.forks).toHaveLength(2);

    const mainFork = result.forks.find((f) => f.name === 'Main');
    expect(mainFork).toBeDefined();
    expect(mainFork!.tipMessageId).toBe(m3);

    const newFork = result.forks.find((f) => f.id === forkId);
    expect(newFork).toBeDefined();
    expect(newFork!.name).toBe('Fork 1');
    expect(newFork!.tipMessageId).toBe(m2);
  });

  it('creates one new fork record when forks already exist', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const m1 = msgId();
    const m2 = msgId();
    const m3 = msgId();

    await insertMessage(db, {
      id: m1,
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: null,
    });
    await insertMessage(db, {
      id: m2,
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      senderType: 'ai',
      parentMessageId: m1,
    });
    await insertMessage(db, {
      id: m3,
      conversationId: setup.conversation.id,
      sequenceNumber: 3,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: m2,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 4 })
      .where(eq(conversations.id, setup.conversation.id));

    const forkId1 = crypto.randomUUID();
    await createFork(db, {
      id: forkId1,
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });

    const forkId2 = crypto.randomUUID();
    const result = await createFork(db, {
      id: forkId2,
      conversationId: setup.conversation.id,
      fromMessageId: m2,
    });

    expect(result.isNew).toBe(true);
    expect(result.forks).toHaveLength(3);

    const fork2 = result.forks.find((f) => f.id === forkId2);
    expect(fork2).toBeDefined();
    expect(fork2!.name).toBe('Fork 2');
    expect(fork2!.tipMessageId).toBe(m2);
  });

  it('returns existing forks when same fork ID is provided (idempotent)', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const m1 = msgId();
    const m2 = msgId();

    await insertMessage(db, {
      id: m1,
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: null,
    });
    await insertMessage(db, {
      id: m2,
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      senderType: 'ai',
      parentMessageId: m1,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 3 })
      .where(eq(conversations.id, setup.conversation.id));

    const forkId = crypto.randomUUID();

    const result1 = await createFork(db, {
      id: forkId,
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });
    expect(result1.isNew).toBe(true);

    const result2 = await createFork(db, {
      id: forkId,
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });
    expect(result2.isNew).toBe(false);
    expect(result2.forks).toHaveLength(result1.forks.length);
  });

  it('throws FORK_LIMIT_REACHED when at maximum forks', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const m1 = msgId();
    const m2 = msgId();

    await insertMessage(db, {
      id: m1,
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: null,
    });
    await insertMessage(db, {
      id: m2,
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      senderType: 'ai',
      parentMessageId: m1,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 3 })
      .where(eq(conversations.id, setup.conversation.id));

    // Create first fork (creates Main + Fork 1 = 2 records)
    await createFork(db, {
      id: crypto.randomUUID(),
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });

    // Create forks until limit
    for (let index = 2; index < MAX_FORKS_PER_CONVERSATION; index++) {
      await createFork(db, {
        id: crypto.randomUUID(),
        conversationId: setup.conversation.id,
        fromMessageId: m1,
      });
    }

    const existingForks = await db
      .select()
      .from(conversationForks)
      .where(eq(conversationForks.conversationId, setup.conversation.id));
    expect(existingForks).toHaveLength(MAX_FORKS_PER_CONVERSATION);

    await expect(
      createFork(db, {
        id: crypto.randomUUID(),
        conversationId: setup.conversation.id,
        fromMessageId: m1,
      })
    ).rejects.toThrow(ForkError);

    try {
      await createFork(db, {
        id: crypto.randomUUID(),
        conversationId: setup.conversation.id,
        fromMessageId: m1,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ForkError);
      expect((error as ForkError).code).toBe(ERROR_CODE_FORK_LIMIT_REACHED);
    }
  });

  it('throws FORK_NAME_TAKEN when name already exists', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const m1 = msgId();
    const m2 = msgId();

    await insertMessage(db, {
      id: m1,
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: null,
    });
    await insertMessage(db, {
      id: m2,
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      senderType: 'ai',
      parentMessageId: m1,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 3 })
      .where(eq(conversations.id, setup.conversation.id));

    await createFork(db, {
      id: crypto.randomUUID(),
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });

    await expect(
      createFork(db, {
        id: crypto.randomUUID(),
        conversationId: setup.conversation.id,
        fromMessageId: m2,
        name: 'Main',
      })
    ).rejects.toThrow(ForkError);

    try {
      await createFork(db, {
        id: crypto.randomUUID(),
        conversationId: setup.conversation.id,
        fromMessageId: m2,
        name: 'Main',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ForkError);
      expect((error as ForkError).code).toBe(ERROR_CODE_FORK_NAME_TAKEN);
    }
  });

  it('auto-generates sequential fork names', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const m1 = msgId();
    const m2 = msgId();

    await insertMessage(db, {
      id: m1,
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: null,
    });
    await insertMessage(db, {
      id: m2,
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      senderType: 'ai',
      parentMessageId: m1,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 3 })
      .where(eq(conversations.id, setup.conversation.id));

    await createFork(db, {
      id: crypto.randomUUID(),
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });

    const result2 = await createFork(db, {
      id: crypto.randomUUID(),
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });
    const fork2 = result2.forks.find((f) => f.name === 'Fork 2');
    expect(fork2).toBeDefined();

    const result3 = await createFork(db, {
      id: crypto.randomUUID(),
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });
    const fork3 = result3.forks.find((f) => f.name === 'Fork 3');
    expect(fork3).toBeDefined();
  });
});

describe('deleteFork', () => {
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

  it('deletes fork and its exclusive messages', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    // Build a tree:
    // M1 -> M2 -> M3 (Main tip)
    //          \-> M4 -> M5 (Fork 1 tip)
    // M4, M5 are exclusive to Fork 1

    const m1 = msgId();
    const m2 = msgId();
    const m3 = msgId();
    const m4 = msgId();
    const m5 = msgId();

    await insertMessage(db, {
      id: m1,
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: null,
    });
    await insertMessage(db, {
      id: m2,
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      senderType: 'ai',
      parentMessageId: m1,
    });
    await insertMessage(db, {
      id: m3,
      conversationId: setup.conversation.id,
      sequenceNumber: 3,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: m2,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 4 })
      .where(eq(conversations.id, setup.conversation.id));

    const forkId = crypto.randomUUID();
    await createFork(db, {
      id: forkId,
      conversationId: setup.conversation.id,
      fromMessageId: m2,
    });

    await insertMessage(db, {
      id: m4,
      conversationId: setup.conversation.id,
      sequenceNumber: 4,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: m2,
    });
    await insertMessage(db, {
      id: m5,
      conversationId: setup.conversation.id,
      sequenceNumber: 5,
      senderType: 'ai',
      parentMessageId: m4,
    });

    await db
      .update(conversationForks)
      .set({ tipMessageId: m5 })
      .where(eq(conversationForks.id, forkId));

    const result = await deleteFork(db, {
      conversationId: setup.conversation.id,
      forkId,
    });

    const remainingMessages = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, setup.conversation.id))
      .orderBy(asc(messages.sequenceNumber));

    const remainingIds = remainingMessages.map((msg) => msg.id);
    expect(remainingIds).toContain(m1);
    expect(remainingIds).toContain(m2);
    expect(remainingIds).toContain(m3);
    expect(remainingIds).not.toContain(m4);
    expect(remainingIds).not.toContain(m5);

    // Only Main fork left, so it gets cleaned up too (reverts to linear)
    expect(result.remainingForks).toHaveLength(0);
  });

  it('preserves shared messages when deleting a fork', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    // Build a tree:
    // M1 -> M2 -> M3 (Main tip)
    //    \-> M4 -> M5 (Fork 1 tip)
    //    \-> M6 (Fork 2 tip)

    const m1 = msgId();
    const m2 = msgId();
    const m3 = msgId();
    const m4 = msgId();
    const m5 = msgId();
    const m6 = msgId();

    await insertMessage(db, {
      id: m1,
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: null,
    });
    await insertMessage(db, {
      id: m2,
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      senderType: 'ai',
      parentMessageId: m1,
    });
    await insertMessage(db, {
      id: m3,
      conversationId: setup.conversation.id,
      sequenceNumber: 3,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: m2,
    });
    await insertMessage(db, {
      id: m4,
      conversationId: setup.conversation.id,
      sequenceNumber: 4,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: m1,
    });
    await insertMessage(db, {
      id: m5,
      conversationId: setup.conversation.id,
      sequenceNumber: 5,
      senderType: 'ai',
      parentMessageId: m4,
    });
    await insertMessage(db, {
      id: m6,
      conversationId: setup.conversation.id,
      sequenceNumber: 6,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: m1,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 7 })
      .where(eq(conversations.id, setup.conversation.id));

    const forkId1 = crypto.randomUUID();
    await createFork(db, {
      id: forkId1,
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });

    const forkId2 = crypto.randomUUID();
    await createFork(db, {
      id: forkId2,
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });

    // Set fork tips: Main -> M3, Fork 1 -> M5, Fork 2 -> M6
    const forks = await db
      .select()
      .from(conversationForks)
      .where(eq(conversationForks.conversationId, setup.conversation.id));

    const mainFork = forks.find((f) => f.name === 'Main')!;
    await db
      .update(conversationForks)
      .set({ tipMessageId: m3 })
      .where(eq(conversationForks.id, mainFork.id));
    await db
      .update(conversationForks)
      .set({ tipMessageId: m5 })
      .where(eq(conversationForks.id, forkId1));
    await db
      .update(conversationForks)
      .set({ tipMessageId: m6 })
      .where(eq(conversationForks.id, forkId2));

    await deleteFork(db, {
      conversationId: setup.conversation.id,
      forkId: forkId1,
    });

    const remainingMessages = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, setup.conversation.id))
      .orderBy(asc(messages.sequenceNumber));

    const remainingIds = remainingMessages.map((msg) => msg.id);

    expect(remainingIds).toContain(m1);
    expect(remainingIds).toContain(m2);
    expect(remainingIds).toContain(m3);
    expect(remainingIds).toContain(m6);
    expect(remainingIds).not.toContain(m4);
    expect(remainingIds).not.toContain(m5);
  });

  it('reverts to linear when only one fork remains after deletion', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const m1 = msgId();
    const m2 = msgId();

    await insertMessage(db, {
      id: m1,
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: null,
    });
    await insertMessage(db, {
      id: m2,
      conversationId: setup.conversation.id,
      sequenceNumber: 2,
      senderType: 'ai',
      parentMessageId: m1,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 3 })
      .where(eq(conversations.id, setup.conversation.id));

    const forkId = crypto.randomUUID();
    await createFork(db, {
      id: forkId,
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });

    const result = await deleteFork(db, {
      conversationId: setup.conversation.id,
      forkId,
    });

    expect(result.remainingForks).toHaveLength(0);

    const dbForks = await db
      .select()
      .from(conversationForks)
      .where(eq(conversationForks.conversationId, setup.conversation.id));
    expect(dbForks).toHaveLength(0);
  });

  it('returns remaining forks when fork already deleted (idempotent)', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const m1 = msgId();

    await insertMessage(db, {
      id: m1,
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: null,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 2 })
      .where(eq(conversations.id, setup.conversation.id));

    const forkId1 = crypto.randomUUID();
    await createFork(db, {
      id: forkId1,
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });
    const forkId2 = crypto.randomUUID();
    await createFork(db, {
      id: forkId2,
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });

    await deleteFork(db, {
      conversationId: setup.conversation.id,
      forkId: forkId1,
    });

    const result = await deleteFork(db, {
      conversationId: setup.conversation.id,
      forkId: forkId1,
    });

    // Should still return Main + Fork 2
    expect(result.remainingForks).toHaveLength(2);
  });
});

describe('renameFork', () => {
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

  it('renames a fork', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const m1 = msgId();

    await insertMessage(db, {
      id: m1,
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: null,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 2 })
      .where(eq(conversations.id, setup.conversation.id));

    const forkId = crypto.randomUUID();
    await createFork(db, {
      id: forkId,
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });

    await renameFork(db, {
      forkId,
      conversationId: setup.conversation.id,
      name: 'My Custom Fork',
    });

    const [updated] = await db
      .select()
      .from(conversationForks)
      .where(eq(conversationForks.id, forkId));
    expect(updated!.name).toBe('My Custom Fork');
  });

  it('throws FORK_NAME_TAKEN when renaming to existing name', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const m1 = msgId();

    await insertMessage(db, {
      id: m1,
      conversationId: setup.conversation.id,
      sequenceNumber: 1,
      senderType: 'user',
      senderId: setup.user.id,
      parentMessageId: null,
    });

    await db
      .update(conversations)
      .set({ nextSequence: 2 })
      .where(eq(conversations.id, setup.conversation.id));

    const forkId = crypto.randomUUID();
    await createFork(db, {
      id: forkId,
      conversationId: setup.conversation.id,
      fromMessageId: m1,
    });

    await expect(
      renameFork(db, {
        forkId,
        conversationId: setup.conversation.id,
        name: 'Main',
      })
    ).rejects.toThrow(ForkError);

    try {
      await renameFork(db, {
        forkId,
        conversationId: setup.conversation.id,
        name: 'Main',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ForkError);
      expect((error as ForkError).code).toBe(ERROR_CODE_FORK_NAME_TAKEN);
    }
  });
});
