import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, asc } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  conversations,
  messages,
  users,
  epochs,
  epochMembers,
  conversationMembers,
  conversationForks,
  wallets,
} from '@hushbox/db';
import { userFactory, walletFactory } from '@hushbox/db/factories';
import { saveChatTurn, saveUserOnlyMessage } from '../services/chat/message-persistence.js';
import {
  resolveParentMessageId,
  InvalidParentMessageError,
} from '../services/chat/message-helpers.js';
import { createFork } from '../services/forks/forks.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

function placeholderBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = index % 256;
  }
  return bytes;
}

const RUN_ID = String(Date.now());
const cleanupConvIds: string[] = [];
const cleanupUserIds: string[] = [];

describe('parent chain integration', () => {
  const db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  let userId: string;

  beforeAll(async () => {
    const userData = userFactory.build({
      email: `parent-chain-${RUN_ID}@test.com`,
      username: `pc_${RUN_ID}`,
      emailVerified: true,
    });
    const [user] = await db.insert(users).values(userData).returning();
    if (!user) throw new Error('Failed to create test user');
    userId = user.id;
    cleanupUserIds.push(userId);

    // Create wallet with sufficient balance for test charges
    const walletData = walletFactory.build({
      userId,
      type: 'purchased',
      balance: '100.00000000',
      priority: 0,
    });
    await db.insert(wallets).values(walletData);
  });

  afterAll(async () => {
    for (const cId of cleanupConvIds) {
      await db.delete(conversationForks).where(eq(conversationForks.conversationId, cId));
    }
    if (cleanupConvIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, cleanupConvIds));
    }
    if (cleanupUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, cleanupUserIds));
    }
  });

  async function createTestConversation(): Promise<string> {
    const convId = crypto.randomUUID();
    cleanupConvIds.push(convId);

    await db.insert(conversations).values({
      id: convId,
      userId,
      title: new TextEncoder().encode('parent chain test'),
      titleEpochNumber: 1,
      currentEpoch: 1,
      nextSequence: 1,
    });

    const [epoch] = await db
      .insert(epochs)
      .values({
        conversationId: convId,
        epochNumber: 1,
        epochPublicKey: placeholderBytes(32),
        confirmationHash: placeholderBytes(32),
      })
      .returning();

    if (epoch) {
      const [user] = await db
        .select({ publicKey: users.publicKey })
        .from(users)
        .where(eq(users.id, userId));
      if (user) {
        await db.insert(epochMembers).values({
          epochId: epoch.id,
          memberPublicKey: user.publicKey,
          wrap: placeholderBytes(48),
          visibleFromEpoch: 1,
        });
      }
    }

    await db.insert(conversationMembers).values({
      conversationId: convId,
      userId,
      privilege: 'owner',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    return convId;
  }

  async function fetchMessages(
    conversationId: string
  ): Promise<
    { id: string; parentMessageId: string | null; senderType: string; sequenceNumber: number }[]
  > {
    return db
      .select({
        id: messages.id,
        parentMessageId: messages.parentMessageId,
        senderType: messages.senderType,
        sequenceNumber: messages.sequenceNumber,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.sequenceNumber));
  }

  function walkChainFromTip(
    tipId: string,
    allMessages: { id: string; parentMessageId: string | null }[]
  ): string[] {
    const map = new Map(allMessages.map((m) => [m.id, m]));
    const chain: string[] = [];
    let current = map.get(tipId);
    while (current) {
      chain.push(current.id);
      current = current.parentMessageId ? map.get(current.parentMessageId) : undefined;
    }
    return chain.toReversed();
  }

  describe('saveChatTurn with resolveParentMessageId builds complete parent chain', () => {
    let convId: string;
    const turnIds: { userMsgId: string; aiMsgId: string }[] = [];

    beforeAll(async () => {
      convId = await createTestConversation();

      // Simulate 3 chat turns using the same code path as the API route
      for (let turn = 0; turn < 3; turn++) {
        const parentMessageId = await resolveParentMessageId(db, convId);
        const userMsgId = crypto.randomUUID();
        const aiMsgId = crypto.randomUUID();
        turnIds.push({ userMsgId, aiMsgId });

        await saveChatTurn(db, {
          conversationId: convId,
          userId,
          senderId: userId,
          userMessageId: userMsgId,
          userContent: `User message ${String(turn + 1)}`,
          assistantMessageId: aiMsgId,
          assistantContent: `AI response ${String(turn + 1)}`,
          model: 'test-model',
          totalCost: 0.001,
          inputTokens: 10,
          outputTokens: 20,
          parentMessageId,
        });
      }
    });

    it('first user message has no parent', async () => {
      const msgs = await fetchMessages(convId);
      const firstUser = msgs.find((m) => m.id === turnIds[0]!.userMsgId);
      expect(firstUser?.parentMessageId).toBeNull();
    });

    it('first AI message parent is first user message', async () => {
      const msgs = await fetchMessages(convId);
      const firstAi = msgs.find((m) => m.id === turnIds[0]!.aiMsgId);
      expect(firstAi?.parentMessageId).toBe(turnIds[0]!.userMsgId);
    });

    it('second user message parent is first AI message', async () => {
      const msgs = await fetchMessages(convId);
      const secondUser = msgs.find((m) => m.id === turnIds[1]!.userMsgId);
      expect(secondUser?.parentMessageId).toBe(turnIds[0]!.aiMsgId);
    });

    it('third user message parent is second AI message', async () => {
      const msgs = await fetchMessages(convId);
      const thirdUser = msgs.find((m) => m.id === turnIds[2]!.userMsgId);
      expect(thirdUser?.parentMessageId).toBe(turnIds[1]!.aiMsgId);
    });

    it('walking from last message reaches all 6 messages', async () => {
      const msgs = await fetchMessages(convId);
      expect(msgs).toHaveLength(6);
      const lastMsgId = turnIds[2]!.aiMsgId;
      const chain = walkChainFromTip(lastMsgId, msgs);
      expect(chain).toHaveLength(6);
      expect(chain[0]).toBe(turnIds[0]!.userMsgId);
      expect(chain[5]).toBe(turnIds[2]!.aiMsgId);
    });
  });

  describe('fork creation preserves reachable chains', () => {
    let convId: string;
    const turnIds: { userMsgId: string; aiMsgId: string }[] = [];

    beforeAll(async () => {
      convId = await createTestConversation();

      // Create 3 turns with proper parent chain
      for (let turn = 0; turn < 3; turn++) {
        const parentMessageId = await resolveParentMessageId(db, convId);
        const userMsgId = crypto.randomUUID();
        const aiMsgId = crypto.randomUUID();
        turnIds.push({ userMsgId, aiMsgId });

        await saveChatTurn(db, {
          conversationId: convId,
          userId,
          senderId: userId,
          userMessageId: userMsgId,
          userContent: `User message ${String(turn + 1)}`,
          assistantMessageId: aiMsgId,
          assistantContent: `AI response ${String(turn + 1)}`,
          model: 'test-model',
          totalCost: 0.001,
          inputTokens: 10,
          outputTokens: 20,
          parentMessageId,
        });
      }
    });

    it('Main fork tip reaches all 6 messages via parent chain', async () => {
      // Fork at message 4 (second AI message)
      const forkId = crypto.randomUUID();
      await createFork(db, {
        id: forkId,
        conversationId: convId,
        fromMessageId: turnIds[1]!.aiMsgId,
      });

      const allForks = await db
        .select({ name: conversationForks.name, tipMessageId: conversationForks.tipMessageId })
        .from(conversationForks)
        .where(eq(conversationForks.conversationId, convId));

      const mainFork = allForks.find((f) => f.name === 'Main');
      expect(mainFork).toBeDefined();
      expect(mainFork!.tipMessageId).toBe(turnIds[2]!.aiMsgId);

      const msgs = await fetchMessages(convId);
      const mainChain = walkChainFromTip(mainFork!.tipMessageId!, msgs);
      expect(mainChain).toHaveLength(6);
    });

    it('Fork 1 tip reaches first 4 messages via parent chain', async () => {
      const allForks = await db
        .select({ name: conversationForks.name, tipMessageId: conversationForks.tipMessageId })
        .from(conversationForks)
        .where(eq(conversationForks.conversationId, convId));

      const fork1 = allForks.find((f) => f.name === 'Fork 1');
      expect(fork1).toBeDefined();
      expect(fork1!.tipMessageId).toBe(turnIds[1]!.aiMsgId);

      const msgs = await fetchMessages(convId);
      const forkChain = walkChainFromTip(fork1!.tipMessageId!, msgs);
      expect(forkChain).toHaveLength(4);
      expect(forkChain[0]).toBe(turnIds[0]!.userMsgId);
      expect(forkChain[3]).toBe(turnIds[1]!.aiMsgId);
    });
  });

  describe('saveUserOnlyMessage builds parent chain', () => {
    it('user-only message parent is the last existing message', async () => {
      const convId = await createTestConversation();

      // Save one chat turn first
      const userMsgId = crypto.randomUUID();
      const aiMsgId = crypto.randomUUID();
      await saveChatTurn(db, {
        conversationId: convId,
        userId,
        senderId: userId,
        userMessageId: userMsgId,
        userContent: 'First user message',
        assistantMessageId: aiMsgId,
        assistantContent: 'AI response',
        model: 'test-model',
        totalCost: 0.001,
        inputTokens: 10,
        outputTokens: 20,
        parentMessageId: null,
      });

      // Now save a user-only message with resolved parent
      const parentMessageId = await resolveParentMessageId(db, convId);
      const userOnlyId = crypto.randomUUID();
      await saveUserOnlyMessage(db, {
        conversationId: convId,
        userId,
        senderId: userId,
        messageId: userOnlyId,
        content: 'User-only follow-up',
        parentMessageId,
      });

      const msgs = await fetchMessages(convId);
      const userOnlyMsg = msgs.find((m) => m.id === userOnlyId);
      expect(userOnlyMsg?.parentMessageId).toBe(aiMsgId);
    });
  });

  describe('messages in a fork continue from fork tip', () => {
    it('new message in fork has parent = fork tip', async () => {
      const convId = await createTestConversation();

      // Create 2 turns
      const turn1User = crypto.randomUUID();
      const turn1Ai = crypto.randomUUID();
      await saveChatTurn(db, {
        conversationId: convId,
        userId,
        senderId: userId,
        userMessageId: turn1User,
        userContent: 'Turn 1',
        assistantMessageId: turn1Ai,
        assistantContent: 'Response 1',
        model: 'test-model',
        totalCost: 0.001,
        inputTokens: 10,
        outputTokens: 20,
        parentMessageId: null,
      });

      const parent2 = await resolveParentMessageId(db, convId);
      const turn2User = crypto.randomUUID();
      const turn2Ai = crypto.randomUUID();
      await saveChatTurn(db, {
        conversationId: convId,
        userId,
        senderId: userId,
        userMessageId: turn2User,
        userContent: 'Turn 2',
        assistantMessageId: turn2Ai,
        assistantContent: 'Response 2',
        model: 'test-model',
        totalCost: 0.001,
        inputTokens: 10,
        outputTokens: 20,
        parentMessageId: parent2,
      });

      // Create fork at turn1Ai
      const forkId = crypto.randomUUID();
      await createFork(db, {
        id: forkId,
        conversationId: convId,
        fromMessageId: turn1Ai,
      });

      // Get fork 1 (not Main)
      const allForks = await db
        .select({ id: conversationForks.id, name: conversationForks.name })
        .from(conversationForks)
        .where(eq(conversationForks.conversationId, convId));
      const fork1 = allForks.find((f) => f.name === 'Fork 1');
      expect(fork1).toBeDefined();

      // Send a message in the fork
      const forkParent = await resolveParentMessageId(db, convId, fork1!.id);
      expect(forkParent).toBe(turn1Ai);

      const forkUserMsg = crypto.randomUUID();
      const forkAiMsg = crypto.randomUUID();
      await saveChatTurn(db, {
        conversationId: convId,
        userId,
        senderId: userId,
        userMessageId: forkUserMsg,
        userContent: 'Fork message',
        assistantMessageId: forkAiMsg,
        assistantContent: 'Fork response',
        model: 'test-model',
        totalCost: 0.001,
        inputTokens: 10,
        outputTokens: 20,
        parentMessageId: forkParent,
        forkId: fork1!.id,
      });

      const msgs = await fetchMessages(convId);

      // Fork user message parent = fork tip (turn1Ai)
      const forkUser = msgs.find((m) => m.id === forkUserMsg);
      expect(forkUser?.parentMessageId).toBe(turn1Ai);

      // Fork AI message parent = fork user message
      const forkAi = msgs.find((m) => m.id === forkAiMsg);
      expect(forkAi?.parentMessageId).toBe(forkUserMsg);

      // Walking from fork AI reaches 4 messages: turn1User → turn1Ai → forkUser → forkAi
      const forkChain = walkChainFromTip(forkAiMsg, msgs);
      expect(forkChain).toHaveLength(4);
      expect(forkChain[0]).toBe(turn1User);
    });
  });

  describe('validation: passing null parentMessageId after first message throws', () => {
    it('saveChatTurn with null parentMessageId throws InvalidParentMessageError', async () => {
      const convId = await createTestConversation();

      // First turn with null parentMessageId is valid (no messages exist yet)
      const turn1User = crypto.randomUUID();
      const turn1Ai = crypto.randomUUID();
      await saveChatTurn(db, {
        conversationId: convId,
        userId,
        senderId: userId,
        userMessageId: turn1User,
        userContent: 'Turn 1',
        assistantMessageId: turn1Ai,
        assistantContent: 'Response 1',
        model: 'test-model',
        totalCost: 0.001,
        inputTokens: 10,
        outputTokens: 20,
        parentMessageId: null,
      });

      // Second turn with null parentMessageId is now caught by validation
      const turn2User = crypto.randomUUID();
      const turn2Ai = crypto.randomUUID();
      await expect(
        saveChatTurn(db, {
          conversationId: convId,
          userId,
          senderId: userId,
          userMessageId: turn2User,
          userContent: 'Turn 2',
          assistantMessageId: turn2Ai,
          assistantContent: 'Response 2',
          model: 'test-model',
          totalCost: 0.001,
          inputTokens: 10,
          outputTokens: 20,
          parentMessageId: null,
        })
      ).rejects.toThrow(InvalidParentMessageError);
    });
  });

  describe('multi-conversation isolation', () => {
    it('resolveParentMessageId does not cross-contaminate between conversations', async () => {
      const convA = await createTestConversation();
      const convB = await createTestConversation();

      // Turn 1 in conv A
      const parentA1 = await resolveParentMessageId(db, convA);
      expect(parentA1).toBeNull();

      const a1User = crypto.randomUUID();
      const a1Ai = crypto.randomUUID();
      await saveChatTurn(db, {
        conversationId: convA,
        userId,
        senderId: userId,
        userMessageId: a1User,
        userContent: 'Conv A turn 1',
        assistantMessageId: a1Ai,
        assistantContent: 'A1 response',
        model: 'test-model',
        totalCost: 0.001,
        inputTokens: 10,
        outputTokens: 20,
        parentMessageId: parentA1,
      });

      // Turn 1 in conv B (interleaved)
      const parentB1 = await resolveParentMessageId(db, convB);
      expect(parentB1).toBeNull();

      const b1User = crypto.randomUUID();
      const b1Ai = crypto.randomUUID();
      await saveChatTurn(db, {
        conversationId: convB,
        userId,
        senderId: userId,
        userMessageId: b1User,
        userContent: 'Conv B turn 1',
        assistantMessageId: b1Ai,
        assistantContent: 'B1 response',
        model: 'test-model',
        totalCost: 0.001,
        inputTokens: 10,
        outputTokens: 20,
        parentMessageId: parentB1,
      });

      // Turn 2 in conv A — should resolve to a1Ai, not b1Ai
      const parentA2 = await resolveParentMessageId(db, convA);
      expect(parentA2).toBe(a1Ai);

      // Turn 2 in conv B — should resolve to b1Ai, not a1Ai
      const parentB2 = await resolveParentMessageId(db, convB);
      expect(parentB2).toBe(b1Ai);

      const a2User = crypto.randomUUID();
      const a2Ai = crypto.randomUUID();
      await saveChatTurn(db, {
        conversationId: convA,
        userId,
        senderId: userId,
        userMessageId: a2User,
        userContent: 'Conv A turn 2',
        assistantMessageId: a2Ai,
        assistantContent: 'A2 response',
        model: 'test-model',
        totalCost: 0.001,
        inputTokens: 10,
        outputTokens: 20,
        parentMessageId: parentA2,
      });

      // Verify conv A chain is complete and isolated
      const msgsA = await fetchMessages(convA);
      expect(msgsA).toHaveLength(4);
      const chainA = walkChainFromTip(a2Ai, msgsA);
      expect(chainA).toHaveLength(4);
      expect(chainA[0]).toBe(a1User);

      // Verify conv B chain is complete and isolated
      const msgsB = await fetchMessages(convB);
      expect(msgsB).toHaveLength(2);
      const chainB = walkChainFromTip(b1Ai, msgsB);
      expect(chainB).toHaveLength(2);
      expect(chainB[0]).toBe(b1User);
    });
  });
});
