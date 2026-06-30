import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { asc, eq as eqDrizzle } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  messages,
  contentItems,
  conversations,
  conversationMembers,
  conversationSpending,
  memberBudgets,
  epochs,
  wallets,
  usageRecords,
  ledgerEntries,
  llmCompletions,
  mediaGenerations,
  conversationForks,
  type Database,
} from '@hushbox/db';
import {
  userFactory,
  conversationFactory,
  conversationMemberFactory,
  walletFactory,
} from '@hushbox/db/factories';
import {
  createFirstEpoch,
  generateKeyPair,
  openMessageEnvelope,
  decryptTextWithContentKey,
  type WrappedContentKey,
} from '@hushbox/crypto';
import { saveChatTurn, saveUserOnlyMessage } from './message-persistence.js';

/** Fetch the first text content item for a message. */
async function getTextContentItem(
  dbInst: Database,
  messageId: string
): Promise<typeof contentItems.$inferSelect> {
  const [item] = await dbInst
    .select()
    .from(contentItems)
    .where(eqDrizzle(contentItems.messageId, messageId))
    .orderBy(asc(contentItems.position))
    .limit(1);
  if (!item) throw new Error(`No content item found for message ${messageId}`);
  return item;
}

/** Decrypt a message's text content item using the epoch private key. */
function decryptMessageText(
  epochPrivateKey: Uint8Array,
  wrappedContentKey: Uint8Array,
  encryptedBlob: Uint8Array
): string {
  const contentKey = openMessageEnvelope(epochPrivateKey, wrappedContentKey as WrappedContentKey);
  return decryptTextWithContentKey(contentKey, encryptedBlob);
}

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

async function createTestSetup(db: Database, balance = '10.00000000'): Promise<TestSetup> {
  // Create user with a real keypair so we can decrypt epoch keys
  const accountKeyPair = generateKeyPair();
  const userData = userFactory.build({ publicKey: accountKeyPair.publicKey });
  const [createdUser] = await db.insert(users).values(userData).returning();
  if (!createdUser) throw new Error('Failed to create test user');

  const convData = conversationFactory.build({ userId: createdUser.id });
  const [createdConv] = await db.insert(conversations).values(convData).returning();
  if (!createdConv) throw new Error('Failed to create test conversation');

  // Create epoch 1 with a real keypair for testing decryption
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

  // Create wallet with specified balance
  const walletData = walletFactory.build({
    userId: createdUser.id,
    type: 'purchased',
    balance,
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

describe('saveChatTurn', () => {
  let db: Database;
  const createdUserIds: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterEach(async () => {
    // Clean up in reverse FK order. ledger_entries has a check constraint
    // requiring exactly one of (payment_id, usage_record_id, source_wallet_id)
    // to be NOT NULL, so we must delete ledger_entries before their parents.
    for (const userId of createdUserIds) {
      // Get wallet IDs for this user to delete their ledger entries
      const userWallets = await db
        .select({ id: wallets.id })
        .from(wallets)
        .where(eq(wallets.userId, userId));
      if (userWallets.length > 0) {
        await db.delete(ledgerEntries).where(
          inArray(
            ledgerEntries.walletId,
            userWallets.map((w) => w.id)
          )
        );
      }
      await db.delete(usageRecords).where(eq(usageRecords.userId, userId));
      await db.delete(wallets).where(eq(wallets.userId, userId));
      // Conversations cascade to messages and epochs
      await db.delete(conversations).where(eq(conversations.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    createdUserIds.length = 0;
  });

  it('inserts both user and AI messages atomically', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

    const result = await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      userMessageId,
      userContent: 'Hello from user',
      assistantMessageId,
      assistantContent: 'Hello from AI!',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.001_36,
      inputTokens: 100,
      outputTokens: 50,
      parentMessageId: null,
    });

    // User message exists with correct fields
    const [userMsg] = await db.select().from(messages).where(eq(messages.id, userMessageId));
    if (!userMsg) throw new Error('User message not found');
    expect(userMsg.senderType).toBe('user');
    expect(userMsg.senderId).toBe(setup.user.id);
    expect(userMsg.wrappedContentKey).toBeInstanceOf(Uint8Array);
    expect(userMsg.epochNumber).toBe(1);

    // AI message exists with correct fields
    const [aiMsg] = await db.select().from(messages).where(eq(messages.id, assistantMessageId));
    if (!aiMsg) throw new Error('AI message not found');
    expect(aiMsg.senderType).toBe('ai');
    expect(aiMsg.wrappedContentKey).toBeInstanceOf(Uint8Array);
    expect(aiMsg.epochNumber).toBe(1);

    const aiCi = await getTextContentItem(db, assistantMessageId);
    expect(aiCi.cost).toBe('0.00136000');

    const userCi = await getTextContentItem(db, userMessageId);
    expect(userCi.cost).toBeNull();

    expect(result.epochNumber).toBe(1);
  });

  it('encrypts messages with epoch public key', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const userText = 'Hello user message';
    const aiText = 'Hello AI response';

    await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      userMessageId,
      userContent: userText,
      assistantMessageId,
      assistantContent: aiText,
      model: 'openai/gpt-4o-mini',
      totalCost: 0.001,
      inputTokens: 50,
      outputTokens: 30,
      parentMessageId: null,
    });

    // Decrypt user message via wrap-once envelope
    const [userMsg] = await db.select().from(messages).where(eq(messages.id, userMessageId));
    if (!userMsg) throw new Error('User message not found');
    const userCi = await getTextContentItem(db, userMessageId);
    const decryptedUser = decryptMessageText(
      setup.epochPrivateKey,
      userMsg.wrappedContentKey,
      userCi.encryptedBlob!
    );
    expect(decryptedUser).toBe(userText);

    // Decrypt AI message via wrap-once envelope
    const [aiMsg] = await db.select().from(messages).where(eq(messages.id, assistantMessageId));
    if (!aiMsg) throw new Error('AI message not found');
    const aiCi = await getTextContentItem(db, assistantMessageId);
    const decryptedAi = decryptMessageText(
      setup.epochPrivateKey,
      aiMsg.wrappedContentKey,
      aiCi.encryptedBlob!
    );
    expect(decryptedAi).toBe(aiText);
  });

  it('assigns sequential sequence numbers', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    // Conversation starts with nextSequence = 1
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

    const result = await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      userMessageId,
      userContent: 'First user message',
      assistantMessageId,
      assistantContent: 'First AI response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.001,
      inputTokens: 50,
      outputTokens: 30,
      parentMessageId: null,
    });

    expect(result.userSequence).toBe(1);
    expect(result.aiSequence).toBe(2);

    // Verify messages have correct sequence numbers
    const [userMsg] = await db.select().from(messages).where(eq(messages.id, userMessageId));
    if (!userMsg) throw new Error('User message not found');
    expect(userMsg.sequenceNumber).toBe(1);

    const [aiMsg] = await db.select().from(messages).where(eq(messages.id, assistantMessageId));
    if (!aiMsg) throw new Error('AI message not found');
    expect(aiMsg.sequenceNumber).toBe(2);

    // Conversation nextSequence updated to 3
    const [updatedConv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, setup.conversation.id));
    if (!updatedConv) throw new Error('Conversation not found');
    expect(updatedConv.nextSequence).toBe(3);
  });

  it('charges wallet via chargeForUsage', async () => {
    const setup = await createTestSetup(db, '10.00000000');
    createdUserIds.push(setup.user.id);

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

    const result = await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      userMessageId,
      userContent: 'User message',
      assistantMessageId,
      assistantContent: 'AI response',
      model: 'anthropic/claude-3-opus',
      totalCost: 0.05,
      inputTokens: 200,
      outputTokens: 100,
      cachedTokens: 10,
      parentMessageId: null,
    });

    expect(result.cost).toBe('0.05000000');
    expect(result.usageRecordId).toBeDefined();

    // Wallet balance decreased
    const [updatedWallet] = await db.select().from(wallets).where(eq(wallets.id, setup.wallet.id));
    if (!updatedWallet) throw new Error('Wallet not found');
    expect(Number.parseFloat(updatedWallet.balance)).toBeCloseTo(10 - 0.05, 5);

    // Usage record created
    const [usageRecord] = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, result.usageRecordId));
    if (!usageRecord) throw new Error('Usage record not found');
    expect(usageRecord.status).toBe('completed');
    expect(usageRecord.sourceType).toBe('message');
    expect(usageRecord.sourceId).toBe(assistantMessageId);

    // Ledger entry created
    const [ledger] = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.usageRecordId, result.usageRecordId));
    if (!ledger) throw new Error('Ledger entry not found');
    expect(ledger.entryType).toBe('usage_charge');

    // LLM completion created
    const [completion] = await db
      .select()
      .from(llmCompletions)
      .where(eq(llmCompletions.usageRecordId, result.usageRecordId));
    if (!completion) throw new Error('LLM completion not found');
    expect(completion.model).toBe('anthropic/claude-3-opus');
    expect(completion.inputTokens).toBe(200);
    expect(completion.outputTokens).toBe(100);
    expect(completion.cachedTokens).toBe(10);
  });

  it('rolls back everything if charging fails', async () => {
    // Create user without any wallets
    const userData = userFactory.build();
    const [createdUser] = await db.insert(users).values(userData).returning();
    if (!createdUser) throw new Error('Failed to create test user');
    createdUserIds.push(createdUser.id);

    const convData = conversationFactory.build({ userId: createdUser.id });
    const [createdConv] = await db.insert(conversations).values(convData).returning();
    if (!createdConv) throw new Error('Failed to create test conversation');

    const epochResult = createFirstEpoch([createdUser.publicKey]);
    await db.insert(epochs).values({
      conversationId: createdConv.id,
      epochNumber: 1,
      epochPublicKey: epochResult.epochPublicKey,
      confirmationHash: epochResult.confirmationHash,
    });

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

    // Should fail because no wallets exist
    await expect(
      saveChatTurn(db, {
        conversationId: createdConv.id,
        userId: createdUser.id,
        senderId: createdUser.id,
        userMessageId,
        userContent: 'Should not persist',
        assistantMessageId,
        assistantContent: 'Should not persist either',
        model: 'openai/gpt-4o-mini',
        totalCost: 0.001,
        inputTokens: 50,
        outputTokens: 30,
        parentMessageId: null,
      })
    ).rejects.toThrow();

    // No messages should exist after rollback
    const [userMsg] = await db.select().from(messages).where(eq(messages.id, userMessageId));
    expect(userMsg).toBeUndefined();
    const [aiMsg] = await db.select().from(messages).where(eq(messages.id, assistantMessageId));
    expect(aiMsg).toBeUndefined();

    // No usage records should exist
    const userUsageRecords = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.userId, createdUser.id));
    expect(userUsageRecords).toHaveLength(0);

    // Conversation nextSequence should be unchanged
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, createdConv.id));
    if (!conv) throw new Error('Conversation not found');
    expect(conv.nextSequence).toBe(1);
  });

  it('rolls back on duplicate user message ID', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const userMessageId = crypto.randomUUID();
    const assistantMessageId1 = crypto.randomUUID();
    const assistantMessageId2 = crypto.randomUUID();

    // First insert succeeds
    await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      userMessageId,
      userContent: 'First attempt',
      assistantMessageId: assistantMessageId1,
      assistantContent: 'First response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.001,
      inputTokens: 50,
      outputTokens: 30,
      parentMessageId: null,
    });

    const [walletAfterFirst] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.id, setup.wallet.id));
    if (!walletAfterFirst) throw new Error('Wallet not found');
    const balanceAfterFirst = walletAfterFirst.balance;

    // Second insert with same userMessageId should fail
    await expect(
      saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId, // same user message ID
        userContent: 'Duplicate attempt',
        assistantMessageId: assistantMessageId2,
        assistantContent: 'Duplicate response',
        model: 'openai/gpt-4o-mini',
        totalCost: 0.001,
        inputTokens: 50,
        outputTokens: 30,
        parentMessageId: null,
      })
    ).rejects.toThrow();

    // Balance should not have been double-charged
    const [walletAfterDuplicate] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.id, setup.wallet.id));
    if (!walletAfterDuplicate) throw new Error('Wallet not found');
    expect(walletAfterDuplicate.balance).toBe(balanceAfterFirst);

    // Second assistant message should not exist
    const [dupAiMsg] = await db.select().from(messages).where(eq(messages.id, assistantMessageId2));
    expect(dupAiMsg).toBeUndefined();
  });

  it('handles zero cost', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

    const result = await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      userMessageId,
      userContent: 'Free message',
      assistantMessageId,
      assistantContent: 'Free response',
      model: 'meta/llama-3-8b',
      totalCost: 0,
      inputTokens: 50,
      outputTokens: 30,
      parentMessageId: null,
    });

    expect(result.cost).toBe('0.00000000');

    // Messages still saved
    const [userMsg] = await db.select().from(messages).where(eq(messages.id, userMessageId));
    expect(userMsg).toBeDefined();
    const [aiMsg] = await db.select().from(messages).where(eq(messages.id, assistantMessageId));
    expect(aiMsg).toBeDefined();

    // Wallet balance unchanged
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, setup.wallet.id));
    if (!wallet) throw new Error('Wallet not found');
    expect(wallet.balance).toBe('10.00000000');
  });

  it('continues sequence numbers across consecutive chat turns', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    // First turn: sequences 1, 2
    const turn1AiId = crypto.randomUUID();
    const result1 = await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      userMessageId: crypto.randomUUID(),
      userContent: 'First user message',
      assistantMessageId: turn1AiId,
      assistantContent: 'First AI response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.001,
      inputTokens: 50,
      outputTokens: 30,
      parentMessageId: null,
    });

    expect(result1.userSequence).toBe(1);
    expect(result1.aiSequence).toBe(2);

    // Second turn: sequences 3, 4
    const result2 = await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      userMessageId: crypto.randomUUID(),
      userContent: 'Second user message',
      assistantMessageId: crypto.randomUUID(),
      assistantContent: 'Second AI response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.002,
      inputTokens: 60,
      outputTokens: 40,
      parentMessageId: turn1AiId,
    });

    expect(result2.userSequence).toBe(3);
    expect(result2.aiSequence).toBe(4);

    // Conversation nextSequence should be 5
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, setup.conversation.id));
    if (!conv) throw new Error('Conversation not found');
    expect(conv.nextSequence).toBe(5);
  });

  it('falls back to lower-priority wallet when primary is insufficient', async () => {
    // Create user with two wallets: purchased (priority 0, low balance) and free_tier (priority 1, enough)
    const accountKeyPair = generateKeyPair();
    const userData = userFactory.build({ publicKey: accountKeyPair.publicKey });
    const [createdUser] = await db.insert(users).values(userData).returning();
    if (!createdUser) throw new Error('Failed to create test user');
    createdUserIds.push(createdUser.id);

    const convData = conversationFactory.build({ userId: createdUser.id });
    const [createdConv] = await db.insert(conversations).values(convData).returning();
    if (!createdConv) throw new Error('Failed to create test conversation');

    const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
    await db.insert(epochs).values({
      conversationId: createdConv.id,
      epochNumber: 1,
      epochPublicKey: epochResult.epochPublicKey,
      confirmationHash: epochResult.confirmationHash,
    });

    // Purchased wallet: only $0.01 (insufficient for $0.05 charge)
    const [purchasedWallet] = await db
      .insert(wallets)
      .values(
        walletFactory.build({
          userId: createdUser.id,
          type: 'purchased',
          balance: '0.01000000',
          priority: 0,
        })
      )
      .returning();
    if (!purchasedWallet) throw new Error('Failed to create purchased wallet');

    // Free tier wallet: $5.00 (sufficient)
    const [freeTierWallet] = await db
      .insert(wallets)
      .values(
        walletFactory.build({
          userId: createdUser.id,
          type: 'free_tier',
          balance: '5.00000000',
          priority: 1,
        })
      )
      .returning();
    if (!freeTierWallet) throw new Error('Failed to create free_tier wallet');

    const result = await saveChatTurn(db, {
      conversationId: createdConv.id,
      userId: createdUser.id,
      senderId: createdUser.id,
      userMessageId: crypto.randomUUID(),
      userContent: 'Message with wallet fallback',
      assistantMessageId: crypto.randomUUID(),
      assistantContent: 'AI response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.05,
      inputTokens: 100,
      outputTokens: 50,
      parentMessageId: null,
    });

    expect(result.cost).toBe('0.05000000');

    // Purchased wallet balance unchanged (was insufficient)
    const [updatedPurchased] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.id, purchasedWallet.id));
    if (!updatedPurchased) throw new Error('Purchased wallet not found');
    expect(updatedPurchased.balance).toBe('0.01000000');

    // Free tier wallet charged instead
    const [updatedFreeTier] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.id, freeTierWallet.id));
    if (!updatedFreeTier) throw new Error('Free tier wallet not found');
    expect(Number.parseFloat(updatedFreeTier.balance)).toBeCloseTo(5 - 0.05, 5);
  });

  it('rolls back when all wallets have insufficient balance', async () => {
    // Wallet exists but balance is too low
    const setup = await createTestSetup(db, '0.00100000');
    createdUserIds.push(setup.user.id);

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

    await expect(
      saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId,
        userContent: 'Should not persist',
        assistantMessageId,
        assistantContent: 'Should not persist',
        model: 'openai/gpt-4o-mini',
        totalCost: 1, // way more than 0.001 balance
        inputTokens: 500,
        outputTokens: 500,
        parentMessageId: null,
      })
    ).rejects.toThrow('Insufficient balance');

    // Verify full rollback: no messages
    const [userMsg] = await db.select().from(messages).where(eq(messages.id, userMessageId));
    expect(userMsg).toBeUndefined();

    // Wallet balance unchanged
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, setup.wallet.id));
    if (!wallet) throw new Error('Wallet not found');
    expect(wallet.balance).toBe('0.00100000');

    // Sequence not incremented
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, setup.conversation.id));
    if (!conv) throw new Error('Conversation not found');
    expect(conv.nextSequence).toBe(1);
  });

  it('encrypts and decrypts long messages with compression', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    // Generate a long message that triggers compression (>128 bytes)
    const longUserContent = 'This is a detailed question about quantum computing. '.repeat(50);
    const longAiContent =
      'Here is a comprehensive answer about quantum mechanics and computing principles. '.repeat(
        100
      );

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

    await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      userMessageId,
      userContent: longUserContent,
      assistantMessageId,
      assistantContent: longAiContent,
      model: 'openai/gpt-4o-mini',
      totalCost: 0.01,
      inputTokens: 2000,
      outputTokens: 4000,
      parentMessageId: null,
    });

    // Decrypt and verify exact content roundtrip via wrap-once envelope
    const [userMsg] = await db.select().from(messages).where(eq(messages.id, userMessageId));
    if (!userMsg) throw new Error('User message not found');
    const userCi = await getTextContentItem(db, userMessageId);
    const decryptedUser = decryptMessageText(
      setup.epochPrivateKey,
      userMsg.wrappedContentKey,
      userCi.encryptedBlob!
    );
    expect(decryptedUser).toBe(longUserContent);

    const [aiMsg] = await db.select().from(messages).where(eq(messages.id, assistantMessageId));
    if (!aiMsg) throw new Error('AI message not found');
    const aiCi = await getTextContentItem(db, assistantMessageId);
    const decryptedAi = decryptMessageText(
      setup.epochPrivateKey,
      aiMsg.wrappedContentKey,
      aiCi.encryptedBlob!
    );
    expect(decryptedAi).toBe(longAiContent);

    // Encrypted blob should be smaller than plaintext (compression working)
    expect(aiCi.encryptedBlob!.length).toBeLessThan(Buffer.from(longAiContent).length);
  });

  it('throws when conversation does not exist', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    await expect(
      saveChatTurn(db, {
        conversationId: crypto.randomUUID(), // non-existent conversation
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId: crypto.randomUUID(),
        userContent: 'Should fail',
        assistantMessageId: crypto.randomUUID(),
        assistantContent: 'Should fail',
        model: 'openai/gpt-4o-mini',
        totalCost: 0.001,
        inputTokens: 50,
        outputTokens: 30,
        parentMessageId: null,
      })
    ).rejects.toThrow('Conversation not found');
  });

  it('throws when epoch does not exist for conversation', async () => {
    // Create conversation but no epoch
    const accountKeyPair = generateKeyPair();
    const userData = userFactory.build({ publicKey: accountKeyPair.publicKey });
    const [createdUser] = await db.insert(users).values(userData).returning();
    if (!createdUser) throw new Error('Failed to create test user');
    createdUserIds.push(createdUser.id);

    const convData = conversationFactory.build({ userId: createdUser.id });
    const [createdConv] = await db.insert(conversations).values(convData).returning();
    if (!createdConv) throw new Error('Failed to create test conversation');

    // Wallet exists but no epoch — should fail at epoch lookup
    await db.insert(wallets).values(
      walletFactory.build({
        userId: createdUser.id,
        type: 'purchased',
        balance: '10.00000000',
        priority: 0,
      })
    );

    await expect(
      saveChatTurn(db, {
        conversationId: createdConv.id,
        userId: createdUser.id,
        senderId: createdUser.id,
        userMessageId: crypto.randomUUID(),
        userContent: 'Should fail',
        assistantMessageId: crypto.randomUUID(),
        assistantContent: 'Should fail',
        model: 'openai/gpt-4o-mini',
        totalCost: 0.001,
        inputTokens: 50,
        outputTokens: 30,
        parentMessageId: null,
      })
    ).rejects.toThrow('Epoch not found');
  });

  it('works with currentEpoch greater than 1', async () => {
    const accountKeyPair = generateKeyPair();
    const userData = userFactory.build({ publicKey: accountKeyPair.publicKey });
    const [createdUser] = await db.insert(users).values(userData).returning();
    if (!createdUser) throw new Error('Failed to create test user');
    createdUserIds.push(createdUser.id);

    // Conversation at epoch 3
    const convData = conversationFactory.build({ userId: createdUser.id, currentEpoch: 3 });
    const [createdConv] = await db.insert(conversations).values(convData).returning();
    if (!createdConv) throw new Error('Failed to create test conversation');

    // Create epoch 3 (the current epoch)
    const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
    await db.insert(epochs).values({
      conversationId: createdConv.id,
      epochNumber: 3,
      epochPublicKey: epochResult.epochPublicKey,
      confirmationHash: epochResult.confirmationHash,
    });

    await db.insert(wallets).values(
      walletFactory.build({
        userId: createdUser.id,
        type: 'purchased',
        balance: '10.00000000',
        priority: 0,
      })
    );

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

    const result = await saveChatTurn(db, {
      conversationId: createdConv.id,
      userId: createdUser.id,
      senderId: createdUser.id,
      userMessageId,
      userContent: 'Message in epoch 3',
      assistantMessageId,
      assistantContent: 'Response in epoch 3',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.001,
      inputTokens: 50,
      outputTokens: 30,
      parentMessageId: null,
    });

    expect(result.epochNumber).toBe(3);

    // Messages stored with correct epoch number
    const [userMsg] = await db.select().from(messages).where(eq(messages.id, userMessageId));
    if (!userMsg) throw new Error('User message not found');
    expect(userMsg.epochNumber).toBe(3);

    // Can decrypt with the epoch 3 private key
    const userCiD = await getTextContentItem(db, userMessageId);
    const decrypted = decryptMessageText(
      epochResult.epochPrivateKey,
      userMsg.wrappedContentKey,
      userCiD.encryptedBlob!
    );
    expect(decrypted).toBe('Message in epoch 3');
  });

  it('encrypts and decrypts empty string content', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

    await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      userMessageId,
      userContent: '',
      assistantMessageId,
      assistantContent: '',
      model: 'openai/gpt-4o-mini',
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      parentMessageId: null,
    });

    const [userMsg] = await db.select().from(messages).where(eq(messages.id, userMessageId));
    if (!userMsg) throw new Error('User message not found');
    const userCiE = await getTextContentItem(db, userMessageId);
    const decryptedUser = decryptMessageText(
      setup.epochPrivateKey,
      userMsg.wrappedContentKey,
      userCiE.encryptedBlob!
    );
    expect(decryptedUser).toBe('');

    const [aiMsg] = await db.select().from(messages).where(eq(messages.id, assistantMessageId));
    if (!aiMsg) throw new Error('AI message not found');
    const aiCiE = await getTextContentItem(db, assistantMessageId);
    const decryptedAi = decryptMessageText(
      setup.epochPrivateKey,
      aiMsg.wrappedContentKey,
      aiCiE.encryptedBlob!
    );
    expect(decryptedAi).toBe('');
  });

  it('stores provider as ai-gateway in LLM completion', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const result = await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      userMessageId: crypto.randomUUID(),
      userContent: 'Check provider',
      assistantMessageId: crypto.randomUUID(),
      assistantContent: 'Provider response',
      model: 'google/gemini-2.0-flash',
      totalCost: 0.003,
      inputTokens: 80,
      outputTokens: 60,
      parentMessageId: null,
    });

    const [completion] = await db
      .select()
      .from(llmCompletions)
      .where(eq(llmCompletions.usageRecordId, result.usageRecordId));
    if (!completion) throw new Error('LLM completion not found');
    expect(completion.provider).toBe('ai-gateway');
    expect(completion.model).toBe('google/gemini-2.0-flash');
  });

  it('updates conversation updatedAt', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const originalUpdatedAt = setup.conversation.updatedAt;

    // Small delay to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 50));

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

    await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      userMessageId,
      userContent: 'User message',
      assistantMessageId,
      assistantContent: 'AI response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.001,
      inputTokens: 50,
      outputTokens: 30,
      parentMessageId: null,
    });

    const [updatedConv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, setup.conversation.id));
    if (!updatedConv) throw new Error('Conversation not found');
    expect(updatedConv.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
  });

  describe('with groupBillingContext', () => {
    interface GroupTestSetup extends TestSetup {
      memberUser: typeof users.$inferSelect;
      member: typeof conversationMembers.$inferSelect;
    }

    async function createGroupTestSetup(
      database: Database,
      balance = '10.00000000'
    ): Promise<GroupTestSetup> {
      const setup = await createTestSetup(database, balance);

      // Create member user
      const memberUserData = userFactory.build();
      const [memberUser] = await database.insert(users).values(memberUserData).returning();
      if (!memberUser) throw new Error('Failed to create member user');

      // Create conversation_members row linking member to conversation
      const memberData = conversationMemberFactory.build({
        conversationId: setup.conversation.id,
        userId: memberUser.id,
        privilege: 'write',
        visibleFromEpoch: 1,
      });
      const [member] = await database.insert(conversationMembers).values(memberData).returning();
      if (!member) throw new Error('Failed to create conversation member');

      return { ...setup, memberUser, member };
    }

    it('creates conversation_spending when groupBillingContext provided', async () => {
      const setup = await createGroupTestSetup(db);
      createdUserIds.push(setup.user.id, setup.memberUser.id);

      await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId: crypto.randomUUID(),
        userContent: 'Group message',
        assistantMessageId: crypto.randomUUID(),
        assistantContent: 'Group response',
        model: 'openai/gpt-4o-mini',
        totalCost: 0.05,
        inputTokens: 100,
        outputTokens: 50,
        groupBillingContext: { memberId: setup.member.id },
        parentMessageId: null,
      });

      const [spending] = await db
        .select()
        .from(conversationSpending)
        .where(eq(conversationSpending.conversationId, setup.conversation.id));
      expect(spending).toBeDefined();
      expect(spending!.totalSpent).toBe('0.05000000');
    });

    it('creates member_budgets spent when groupBillingContext provided', async () => {
      const setup = await createGroupTestSetup(db);
      createdUserIds.push(setup.user.id, setup.memberUser.id);

      await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId: crypto.randomUUID(),
        userContent: 'Group message',
        assistantMessageId: crypto.randomUUID(),
        assistantContent: 'Group response',
        model: 'openai/gpt-4o-mini',
        totalCost: 0.05,
        inputTokens: 100,
        outputTokens: 50,
        groupBillingContext: { memberId: setup.member.id },
        parentMessageId: null,
      });

      const [budget] = await db
        .select()
        .from(memberBudgets)
        .where(eq(memberBudgets.memberId, setup.member.id));
      expect(budget).toBeDefined();
      expect(budget!.spent).toBe('0.05000000');
    });

    it('accumulates spending across sequential group messages', async () => {
      const setup = await createGroupTestSetup(db);
      createdUserIds.push(setup.user.id, setup.memberUser.id);

      const turn1AiId = crypto.randomUUID();
      await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId: crypto.randomUUID(),
        userContent: 'First',
        assistantMessageId: turn1AiId,
        assistantContent: 'Response 1',
        model: 'openai/gpt-4o-mini',
        totalCost: 0.03,
        inputTokens: 100,
        outputTokens: 50,
        groupBillingContext: { memberId: setup.member.id },
        parentMessageId: null,
      });

      await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId: crypto.randomUUID(),
        userContent: 'Second',
        assistantMessageId: crypto.randomUUID(),
        assistantContent: 'Response 2',
        model: 'openai/gpt-4o-mini',
        totalCost: 0.02,
        inputTokens: 80,
        outputTokens: 40,
        groupBillingContext: { memberId: setup.member.id },
        parentMessageId: turn1AiId,
      });

      const [spending] = await db
        .select()
        .from(conversationSpending)
        .where(eq(conversationSpending.conversationId, setup.conversation.id));
      expect(spending).toBeDefined();
      expect(spending!.totalSpent).toBe('0.05000000');

      const [budget] = await db
        .select()
        .from(memberBudgets)
        .where(eq(memberBudgets.memberId, setup.member.id));
      expect(budget).toBeDefined();
      expect(budget!.spent).toBe('0.05000000');
    });

    it('does not update spending tables without groupBillingContext', async () => {
      const setup = await createGroupTestSetup(db);
      createdUserIds.push(setup.user.id, setup.memberUser.id);

      await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId: crypto.randomUUID(),
        userContent: 'Solo message',
        assistantMessageId: crypto.randomUUID(),
        assistantContent: 'Solo response',
        model: 'openai/gpt-4o-mini',
        totalCost: 0.05,
        inputTokens: 100,
        outputTokens: 50,
        parentMessageId: null,
      });

      const spending = await db
        .select()
        .from(conversationSpending)
        .where(eq(conversationSpending.conversationId, setup.conversation.id));
      expect(spending).toHaveLength(0);

      const budgets = await db
        .select()
        .from(memberBudgets)
        .where(eq(memberBudgets.memberId, setup.member.id));
      expect(budgets).toHaveLength(0);
    });

    it('rejects when memberId has no conversation_members row', async () => {
      const setup = await createGroupTestSetup(db);
      createdUserIds.push(setup.user.id, setup.memberUser.id);

      await expect(
        saveChatTurn(db, {
          conversationId: setup.conversation.id,
          userId: setup.user.id,
          senderId: setup.user.id,
          userMessageId: crypto.randomUUID(),
          userContent: 'Bad member',
          assistantMessageId: crypto.randomUUID(),
          assistantContent: 'Should fail',
          model: 'openai/gpt-4o-mini',
          totalCost: 0.05,
          inputTokens: 100,
          outputTokens: 50,
          groupBillingContext: { memberId: 'nonexistent-member-id' },
          parentMessageId: null,
        })
      ).rejects.toThrow();

      // Verify transaction rolled back — no partial spending rows
      const spending = await db
        .select()
        .from(conversationSpending)
        .where(eq(conversationSpending.conversationId, setup.conversation.id));
      expect(spending).toHaveLength(0);
    });

    it('rolls back spending tables when charge fails', async () => {
      // Create group setup with zero balance so chargeForUsage fails
      const setup = await createGroupTestSetup(db, '0.00000000');
      createdUserIds.push(setup.user.id, setup.memberUser.id);

      await expect(
        saveChatTurn(db, {
          conversationId: setup.conversation.id,
          userId: setup.user.id,
          senderId: setup.user.id,
          userMessageId: crypto.randomUUID(),
          userContent: 'Should fail',
          assistantMessageId: crypto.randomUUID(),
          assistantContent: 'Should fail',
          model: 'openai/gpt-4o-mini',
          totalCost: 1,
          inputTokens: 500,
          outputTokens: 500,
          groupBillingContext: { memberId: setup.member.id },
          parentMessageId: null,
        })
      ).rejects.toThrow();

      // No spending records should exist after rollback
      const spending = await db
        .select()
        .from(conversationSpending)
        .where(eq(conversationSpending.conversationId, setup.conversation.id));
      expect(spending).toHaveLength(0);

      const budgets = await db
        .select()
        .from(memberBudgets)
        .where(eq(memberBudgets.memberId, setup.member.id));
      expect(budgets).toHaveLength(0);
    });
  });

  describe('multi-model assistantMessages', () => {
    it('inserts user + N assistant messages with sequential sequence numbers', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMessageId = crypto.randomUUID();
      const assistantId1 = crypto.randomUUID();
      const assistantId2 = crypto.randomUUID();

      const result = await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId,
        userContent: 'Compare these models',
        assistantMessages: [
          {
            modality: 'text' as const,
            id: assistantId1,
            content: 'Response from GPT-4o',
            model: 'openai/gpt-4o',
            cost: 0.002,
            inputTokens: 100,
            outputTokens: 80,
            isEstimated: false,
          },
          {
            modality: 'text' as const,
            id: assistantId2,
            content: 'Response from Claude',
            model: 'anthropic/claude-3.5-sonnet',
            cost: 0.003,
            inputTokens: 100,
            outputTokens: 120,
            isEstimated: false,
          },
        ],
        parentMessageId: null,
      });

      // 3 messages total: 1 user + 2 assistant
      const allMsgs = await db
        .select()
        .from(messages)
        .where(inArray(messages.id, [userMessageId, assistantId1, assistantId2]));
      expect(allMsgs).toHaveLength(3);

      // Sequence numbers are sequential: user=1, ai1=2, ai2=3
      const userMsg = allMsgs.find((m) => m.id === userMessageId)!;
      const ai1Msg = allMsgs.find((m) => m.id === assistantId1)!;
      const ai2Msg = allMsgs.find((m) => m.id === assistantId2)!;
      expect(userMsg.sequenceNumber).toBe(1);
      expect(ai1Msg.sequenceNumber).toBe(2);
      expect(ai2Msg.sequenceNumber).toBe(3);

      // Both AI messages' content items have correct model names
      const ai1Ci = await getTextContentItem(db, assistantId1);
      const ai2Ci = await getTextContentItem(db, assistantId2);
      expect(ai1Ci.modelName).toBe('openai/gpt-4o');
      expect(ai2Ci.modelName).toBe('anthropic/claude-3.5-sonnet');

      // Both AI messages are parented to the user message
      expect(ai1Msg.parentMessageId).toBe(userMessageId);
      expect(ai2Msg.parentMessageId).toBe(userMessageId);

      // Result contains per-model info
      expect(result.assistantResults).toHaveLength(2);
      expect(result.assistantResults[0]!.aiSequence).toBe(2);
      expect(result.assistantResults[1]!.aiSequence).toBe(3);
    });

    it('creates separate usage records per model', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMessageId = crypto.randomUUID();
      const assistantId1 = crypto.randomUUID();
      const assistantId2 = crypto.randomUUID();

      await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId,
        userContent: 'Test multi-model billing',
        assistantMessages: [
          {
            modality: 'text' as const,
            id: assistantId1,
            content: 'First model response',
            model: 'openai/gpt-4o',
            cost: 0.002,
            inputTokens: 100,
            outputTokens: 80,
            isEstimated: false,
          },
          {
            modality: 'text' as const,
            id: assistantId2,
            content: 'Second model response',
            model: 'anthropic/claude-3.5-sonnet',
            cost: 0.003,
            inputTokens: 100,
            outputTokens: 120,
            isEstimated: false,
          },
        ],
        parentMessageId: null,
      });

      // Should have 2 usage records
      const records = await db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.userId, setup.user.id));
      expect(records).toHaveLength(2);

      // Should have 2 LLM completions with different models
      const completions = await db
        .select()
        .from(llmCompletions)
        .where(
          inArray(
            llmCompletions.usageRecordId,
            records.map((r) => r.id)
          )
        );
      expect(completions).toHaveLength(2);
      const completionModels = completions
        .map((c) => c.model)
        .toSorted((a, b) => a.localeCompare(b));
      expect(completionModels).toEqual(['anthropic/claude-3.5-sonnet', 'openai/gpt-4o']);
    });

    it('produces identical results for single-model array vs legacy fields', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMessageId = crypto.randomUUID();
      const assistantId = crypto.randomUUID();

      const result = await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId,
        userContent: 'Single model via array',
        assistantMessages: [
          {
            modality: 'text' as const,
            id: assistantId,
            content: 'AI response',
            model: 'openai/gpt-4o',
            cost: 0.001,
            inputTokens: 50,
            outputTokens: 30,
            isEstimated: false,
          },
        ],
        parentMessageId: null,
      });

      expect(result.userSequence).toBe(1);
      expect(result.assistantResults).toHaveLength(1);
      expect(result.assistantResults[0]!.aiSequence).toBe(2);
      expect(result.epochNumber).toBe(1);
    });
  });

  describe('saveChatTurn with forkId', () => {
    it('updates fork tipMessageId to assistant message', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const forkId = crypto.randomUUID();
      await db.insert(conversationForks).values({
        id: forkId,
        conversationId: setup.conversation.id,
        name: 'Fork 1',
        tipMessageId: null,
      });

      const userMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();

      await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId,
        userContent: 'Message on fork',
        assistantMessageId,
        assistantContent: 'AI response on fork',
        model: 'openai/gpt-4o-mini',
        totalCost: 0.001,
        inputTokens: 50,
        outputTokens: 30,
        parentMessageId: null,
        forkId,
      });

      const [fork] = await db
        .select()
        .from(conversationForks)
        .where(eq(conversationForks.id, forkId));
      expect(fork!.tipMessageId).toBe(assistantMessageId);
    });

    it('multi-model sets fork tip to last assistant message', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const forkId = crypto.randomUUID();
      await db.insert(conversationForks).values({
        id: forkId,
        conversationId: setup.conversation.id,
        name: 'Fork 1',
        tipMessageId: null,
      });

      const userMessageId = crypto.randomUUID();
      const assistantId1 = crypto.randomUUID();
      const assistantId2 = crypto.randomUUID();

      await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId,
        userContent: 'Multi-model on fork',
        assistantMessages: [
          {
            modality: 'text' as const,
            id: assistantId1,
            content: 'GPT response',
            model: 'openai/gpt-4o',
            cost: 0.002,
            inputTokens: 100,
            outputTokens: 80,
            isEstimated: false,
          },
          {
            modality: 'text' as const,
            id: assistantId2,
            content: 'Claude response',
            model: 'anthropic/claude-3.5-sonnet',
            cost: 0.003,
            inputTokens: 100,
            outputTokens: 120,
            isEstimated: false,
          },
        ],
        parentMessageId: null,
        forkId,
      });

      const [fork] = await db
        .select()
        .from(conversationForks)
        .where(eq(conversationForks.id, forkId));
      // Tip must be the LAST assistant, not the first
      expect(fork!.tipMessageId).toBe(assistantId2);
    });

    it('regenerate-one of NON-tip assistant preserves the current fork tip', async () => {
      // Multi-model fork: three siblings, tip points at the LAST one (m3).
      // Per-tile Regenerate on m1 should delete only m1 and leave the tip on m3.
      // Pre-fix the unconditional updateForkTip would advance the tip to the new
      // assistant, silently breaking fork lineage.
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMsgId = crypto.randomUUID();
      const m1Id = crypto.randomUUID();
      const m2Id = crypto.randomUUID();
      const m3Id = crypto.randomUUID();

      // Seed: one user message + three assistant siblings, all on the fork.
      await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId: userMsgId,
        userContent: 'multi-model prompt',
        parentMessageId: null,
        assistantMessages: [
          {
            modality: 'text',
            id: m1Id,
            content: 'm1',
            model: 'openai/gpt-4o',
            cost: 0.001,
            inputTokens: 10,
            outputTokens: 10,
            isEstimated: false,
          },
          {
            modality: 'text',
            id: m2Id,
            content: 'm2',
            model: 'anthropic/claude-3.5-sonnet',
            cost: 0.001,
            inputTokens: 10,
            outputTokens: 10,
            isEstimated: false,
          },
          {
            modality: 'text',
            id: m3Id,
            content: 'm3',
            model: 'google/gemini-1.5-pro',
            cost: 0.001,
            inputTokens: 10,
            outputTokens: 10,
            isEstimated: false,
          },
        ],
      });

      const forkId = crypto.randomUUID();
      await db.insert(conversationForks).values({
        id: forkId,
        conversationId: setup.conversation.id,
        name: 'Main',
        tipMessageId: m3Id, // tip is on the LAST sibling
      });

      const newAssistantId = crypto.randomUUID();

      await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        treeAction: {
          kind: 'regenerate',
          anchorUserMessageId: userMsgId,
          replaceAssistantId: m1Id, // NOT the tip
          forkId,
          forkTipMessageId: m3Id,
        },
        forkId,
        assistantMessages: [
          {
            modality: 'text',
            id: newAssistantId,
            content: 'm1-regenerated',
            model: 'openai/gpt-4o',
            cost: 0.001,
            inputTokens: 10,
            outputTokens: 10,
            isEstimated: false,
          },
        ],
      });

      const [forkAfter] = await db
        .select({ tipMessageId: conversationForks.tipMessageId })
        .from(conversationForks)
        .where(eq(conversationForks.id, forkId));
      expect(forkAfter?.tipMessageId).toBe(m3Id);
    });

    it('regenerate-one of THE current fork tip advances the tip to the replacement', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMsgId = crypto.randomUUID();
      const m1Id = crypto.randomUUID();
      const m2Id = crypto.randomUUID();

      await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId: userMsgId,
        userContent: 'multi-model prompt',
        parentMessageId: null,
        assistantMessages: [
          {
            modality: 'text',
            id: m1Id,
            content: 'm1',
            model: 'openai/gpt-4o',
            cost: 0.001,
            inputTokens: 10,
            outputTokens: 10,
            isEstimated: false,
          },
          {
            modality: 'text',
            id: m2Id,
            content: 'm2',
            model: 'anthropic/claude-3.5-sonnet',
            cost: 0.001,
            inputTokens: 10,
            outputTokens: 10,
            isEstimated: false,
          },
        ],
      });

      const forkId = crypto.randomUUID();
      await db.insert(conversationForks).values({
        id: forkId,
        conversationId: setup.conversation.id,
        name: 'Main',
        tipMessageId: m2Id, // tip IS the assistant we'll replace
      });

      const newAssistantId = crypto.randomUUID();

      await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        treeAction: {
          kind: 'regenerate',
          anchorUserMessageId: userMsgId,
          replaceAssistantId: m2Id, // IS the tip
          forkId,
          forkTipMessageId: m2Id,
        },
        forkId,
        assistantMessages: [
          {
            modality: 'text',
            id: newAssistantId,
            content: 'm2-regenerated',
            model: 'anthropic/claude-3.5-sonnet',
            cost: 0.001,
            inputTokens: 10,
            outputTokens: 10,
            isEstimated: false,
          },
        ],
      });

      const [forkAfter] = await db
        .select({ tipMessageId: conversationForks.tipMessageId })
        .from(conversationForks)
        .where(eq(conversationForks.id, forkId));
      expect(forkAfter?.tipMessageId).toBe(newAssistantId);
    });

    it('does not update fork tip when forkId is omitted', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const forkId = crypto.randomUUID();
      await db.insert(conversationForks).values({
        id: forkId,
        conversationId: setup.conversation.id,
        name: 'Main',
        tipMessageId: null,
      });

      const userMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();

      await saveChatTurn(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        userMessageId,
        userContent: 'Message without forkId',
        assistantMessageId,
        assistantContent: 'AI response',
        model: 'openai/gpt-4o-mini',
        totalCost: 0.001,
        inputTokens: 50,
        outputTokens: 30,
        parentMessageId: null,
        // forkId intentionally omitted
      });

      const [fork] = await db
        .select()
        .from(conversationForks)
        .where(eq(conversationForks.id, forkId));
      expect(fork!.tipMessageId).toBeNull();
    });
  });
});

describe('saveUserOnlyMessage', () => {
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

  it('inserts a single encrypted user message with no cost', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const messageId = crypto.randomUUID();

    const result = await saveUserOnlyMessage(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      messageId,
      content: 'Hello from user only',
      parentMessageId: null,
    });

    // Message exists with correct fields
    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
    if (!msg) throw new Error('Message not found');
    expect(msg.senderType).toBe('user');
    expect(msg.senderId).toBe(setup.user.id);
    expect(msg.epochNumber).toBe(1);
    expect(msg.wrappedContentKey).toBeInstanceOf(Uint8Array);

    const ci = await getTextContentItem(db, messageId);
    expect(ci.cost).toBeNull();

    const decrypted = decryptMessageText(
      setup.epochPrivateKey,
      msg.wrappedContentKey,
      ci.encryptedBlob!
    );
    expect(decrypted).toBe('Hello from user only');

    expect(result.sequenceNumber).toBeDefined();
    expect(result.epochNumber).toBe(1);
  });

  it('assigns a single sequence number (increments by 1)', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const msg1Id = crypto.randomUUID();
    const result1 = await saveUserOnlyMessage(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      messageId: msg1Id,
      content: 'First user-only message',
      parentMessageId: null,
    });

    expect(result1.sequenceNumber).toBe(1);

    const result2 = await saveUserOnlyMessage(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      messageId: crypto.randomUUID(),
      content: 'Second user-only message',
      parentMessageId: msg1Id,
    });

    expect(result2.sequenceNumber).toBe(2);

    // nextSequence should be 3
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, setup.conversation.id));
    if (!conv) throw new Error('Conversation not found');
    expect(conv.nextSequence).toBe(3);
  });

  it('does not create any billing records', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    await saveUserOnlyMessage(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      messageId: crypto.randomUUID(),
      content: 'Free message',
      parentMessageId: null,
    });

    // No usage records
    const records = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.userId, setup.user.id));
    expect(records).toHaveLength(0);

    // No LLM completions
    const completions = await db
      .select()
      .from(llmCompletions)
      .where(eq(llmCompletions.usageRecordId, setup.user.id));
    expect(completions).toHaveLength(0);

    // Wallet balance unchanged
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, setup.wallet.id));
    if (!wallet) throw new Error('Wallet not found');
    expect(wallet.balance).toBe('10.00000000');
  });

  it('throws when conversation does not exist', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    await expect(
      saveUserOnlyMessage(db, {
        conversationId: crypto.randomUUID(),
        userId: setup.user.id,
        senderId: setup.user.id,
        messageId: crypto.randomUUID(),
        content: 'Should fail',
        parentMessageId: null,
      })
    ).rejects.toThrow('Conversation not found');
  });

  it('interleaves correctly with saveChatTurn sequences', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    // User-only message gets sequence 1
    const msg1Id = crypto.randomUUID();
    const result1 = await saveUserOnlyMessage(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      messageId: msg1Id,
      content: 'User-only first',
      parentMessageId: null,
    });
    expect(result1.sequenceNumber).toBe(1);

    // Chat turn gets sequences 2, 3
    const turn2AiId = crypto.randomUUID();
    const result2 = await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      userMessageId: crypto.randomUUID(),
      userContent: 'User message with AI',
      assistantMessageId: turn2AiId,
      assistantContent: 'AI response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.001,
      inputTokens: 50,
      outputTokens: 30,
      parentMessageId: msg1Id,
    });
    expect(result2.userSequence).toBe(2);
    expect(result2.aiSequence).toBe(3);

    // Another user-only message gets sequence 4
    const result3 = await saveUserOnlyMessage(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      messageId: crypto.randomUUID(),
      content: 'User-only after AI',
      parentMessageId: turn2AiId,
    });
    expect(result3.sequenceNumber).toBe(4);
  });

  it('rolls back on duplicate message ID', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const messageId = crypto.randomUUID();

    await saveUserOnlyMessage(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      messageId,
      content: 'First attempt',
      parentMessageId: null,
    });

    await expect(
      saveUserOnlyMessage(db, {
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        messageId, // duplicate
        content: 'Duplicate attempt',
        parentMessageId: null,
      })
    ).rejects.toThrow();

    // nextSequence should be 2 (only first message counted)
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, setup.conversation.id));
    if (!conv) throw new Error('Conversation not found');
    expect(conv.nextSequence).toBe(2);
  });

  it('saveChatTurn persists senderId separately from billing userId', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    // Create a second user to act as the actual sender
    const senderKeyPair = generateKeyPair();
    const senderData = userFactory.build({ publicKey: senderKeyPair.publicKey });
    const [sender] = await db.insert(users).values(senderData).returning();
    if (!sender) throw new Error('Failed to create sender user');
    createdUserIds.push(sender.id);

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

    await saveChatTurn(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id, // billing target (owner)
      senderId: sender.id, // actual sender (member)
      userMessageId,
      userContent: 'Hello from member',
      assistantMessageId,
      assistantContent: 'AI response',
      model: 'openai/gpt-4o-mini',
      totalCost: 0.001,
      inputTokens: 50,
      outputTokens: 25,
      parentMessageId: null,
    });

    // User message senderId should be the actual sender, not the billing user
    const [userMsg] = await db.select().from(messages).where(eq(messages.id, userMessageId));
    if (!userMsg) throw new Error('User message not found');
    expect(userMsg.senderId).toBe(sender.id);
    expect(userMsg.senderId).not.toBe(setup.user.id);

    // Billing user (owner) is recorded on usage_records, not on messages.
    // AI message senderType confirms it's AI-authored.
    const [aiMsg] = await db.select().from(messages).where(eq(messages.id, assistantMessageId));
    if (!aiMsg) throw new Error('AI message not found');
    expect(aiMsg.senderType).toBe('ai');
  });

  it('saveUserOnlyMessage persists senderId separately from userId', async () => {
    const setup = await createTestSetup(db);
    createdUserIds.push(setup.user.id);

    const senderKeyPair = generateKeyPair();
    const senderData = userFactory.build({ publicKey: senderKeyPair.publicKey });
    const [sender] = await db.insert(users).values(senderData).returning();
    if (!sender) throw new Error('Failed to create sender user');
    createdUserIds.push(sender.id);

    const messageId = crypto.randomUUID();

    await saveUserOnlyMessage(db, {
      conversationId: setup.conversation.id,
      userId: setup.user.id, // billing target (unused for user-only, but kept for consistency)
      senderId: sender.id, // actual sender
      messageId,
      content: 'Hello from member (no AI)',
      parentMessageId: null,
    });

    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
    if (!msg) throw new Error('Message not found');
    expect(msg.senderId).toBe(sender.id);
    expect(msg.senderId).not.toBe(setup.user.id);
  });

  it('persists a media assistant message with content_items and media_generations billing', async () => {
    const setup = await createTestSetup(db, '10.00000000');
    createdUserIds.push(setup.user.id);

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();
    const storageKey = `media/${setup.conversation.id}/${assistantMsgId}/${contentItemId}.enc`;

    const result = await saveChatTurn(db, {
      userMessageId: userMsgId,
      userContent: 'Generate an image of a cat',
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      parentMessageId: null,
      assistantMessages: [
        {
          modality: 'image',
          id: assistantMsgId,
          contentItems: [
            {
              id: contentItemId,
              contentType: 'image',
              position: 0,
              storageKey,
              mimeType: 'image/png',
              sizeBytes: 1_000_000,
              width: 1024,
              height: 1024,
              modelName: 'google/imagen-4',
              cost: '0.04600000',
              isSmartModel: false,
            },
          ],
          model: 'google/imagen-4',
          cost: 0.046,
          mediaType: 'image',
          imageCount: 1,
        },
      ],
    });

    expect(result.assistantResults).toHaveLength(1);
    expect(result.assistantResults[0]!.model).toBe('google/imagen-4');

    // Verify content_items row exists with media fields
    const items = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.messageId, assistantMsgId));
    expect(items).toHaveLength(1);
    expect(items[0]!.contentType).toBe('image');
    expect(items[0]!.storageKey).toBe(storageKey);
    expect(items[0]!.mimeType).toBe('image/png');
    expect(items[0]!.encryptedBlob).toBeNull();

    // Verify media_generations billing detail row exists
    const [usageRow] = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, result.assistantResults[0]!.usageRecordId));
    expect(usageRow!.type).toBe('media_generation');

    const [genRow] = await db
      .select()
      .from(mediaGenerations)
      .where(eq(mediaGenerations.usageRecordId, result.assistantResults[0]!.usageRecordId));
    expect(genRow).toBeDefined();
    expect(genRow!.model).toBe('google/imagen-4');
    expect(genRow!.mediaType).toBe('image');
    expect(genRow!.imageCount).toBe(1);
  });

  it('persists a mix of text and media assistant messages in one saveChatTurn', async () => {
    const setup = await createTestSetup(db, '10.00000000');
    createdUserIds.push(setup.user.id);

    const userMsgId = crypto.randomUUID();
    const textMsgId = crypto.randomUUID();
    const imageMsgId = crypto.randomUUID();
    const imageItemId = crypto.randomUUID();

    const result = await saveChatTurn(db, {
      userMessageId: userMsgId,
      userContent: 'Multi-model prompt',
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      parentMessageId: null,
      assistantMessages: [
        {
          modality: 'text',
          id: textMsgId,
          content: 'Text response',
          model: 'anthropic/claude-sonnet-4.6',
          cost: 0.001,
          inputTokens: 100,
          outputTokens: 50,
          isEstimated: false,
        },
        {
          modality: 'image',
          id: imageMsgId,
          contentItems: [
            {
              id: imageItemId,
              contentType: 'image',
              position: 0,
              storageKey: `media/${setup.conversation.id}/${imageMsgId}/${imageItemId}.enc`,
              mimeType: 'image/png',
              sizeBytes: 2_000_000,
              width: 512,
              height: 512,
              modelName: 'google/imagen-4',
              cost: '0.04600000',
              isSmartModel: false,
            },
          ],
          model: 'google/imagen-4',
          cost: 0.046,
          mediaType: 'image',
          imageCount: 1,
        },
      ],
    });

    expect(result.assistantResults).toHaveLength(2);

    // First is text → llm_completions
    const [textUsage] = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, result.assistantResults[0]!.usageRecordId));
    expect(textUsage!.type).toBe('llm_completion');

    // Second is media → media_generations
    const [mediaUsage] = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, result.assistantResults[1]!.usageRecordId));
    expect(mediaUsage!.type).toBe('media_generation');
  });

  it('persists Smart Model assistant with separate usage_records for classifier and inference', async () => {
    const setup = await createTestSetup(db, '10.00000000');
    createdUserIds.push(setup.user.id);

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();

    const result = await saveChatTurn(db, {
      userMessageId: userMsgId,
      userContent: 'Smart Model prompt',
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      parentMessageId: null,
      assistantMessages: [
        {
          modality: 'text',
          id: assistantMsgId,
          content: 'Resolved response',
          // Resolved (downstream) model id, NOT 'smart-model'
          model: 'anthropic/claude-sonnet-4.6',
          cost: 0.003, // main inference dollars
          inputTokens: 100,
          outputTokens: 50,
          isSmartModel: true,
          preInferenceBillings: [
            {
              stageId: 'smart-model',
              modelId: 'cheap/c',
              costDollars: 0.0005,
              inputTokens: 1400,
              outputTokens: 20,
              isEstimated: false,
            },
          ],
          isEstimated: false,
        },
      ],
    });

    // Two usage_records for the same source_id
    const usageRows = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.sourceId, assistantMsgId));
    expect(usageRows).toHaveLength(2);
    const sortedByCost = usageRows.toSorted(
      (a, b) => Number.parseFloat(a.cost) - Number.parseFloat(b.cost)
    );
    expect(sortedByCost[0]!.cost).toBe('0.00050000'); // classifier
    expect(sortedByCost[1]!.cost).toBe('0.00300000'); // main inference

    // Both rows are llm_completion type with their respective models
    const sortedCompletions = await db
      .select()
      .from(llmCompletions)
      .where(
        inArray(
          llmCompletions.usageRecordId,
          usageRows.map((r) => r.id)
        )
      );
    const completionModels = sortedCompletions
      .map((c) => c.model)
      .toSorted((a, b) => a.localeCompare(b));
    expect(completionModels).toEqual(['anthropic/claude-sonnet-4.6', 'cheap/c']);

    // content_items.cost == main + stages (denormalized total)
    const contentItem = await getTextContentItem(db, assistantMsgId);
    expect(contentItem.cost).toBe('0.00350000');
    expect(contentItem.modelName).toBe('anthropic/claude-sonnet-4.6');
    expect(contentItem.isSmartModel).toBe(true);

    // assistantResults.cost reflects the displayed total
    expect(result.assistantResults[0]!.cost).toBe('0.00350000');
  });

  it('persists Smart Model assistant with no preInferenceBillings array correctly', async () => {
    // Defensive — if a slot is flagged isSmartModel but produces no stage billings,
    // we still persist a content item with is_smart_model = true and a single usage_records row.
    const setup = await createTestSetup(db, '10.00000000');
    createdUserIds.push(setup.user.id);

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();

    await saveChatTurn(db, {
      userMessageId: userMsgId,
      userContent: 'Smart Model prompt',
      conversationId: setup.conversation.id,
      userId: setup.user.id,
      senderId: setup.user.id,
      parentMessageId: null,
      assistantMessages: [
        {
          modality: 'text',
          id: assistantMsgId,
          content: 'Resolved response',
          model: 'anthropic/claude-sonnet-4.6',
          cost: 0.003,
          inputTokens: 100,
          outputTokens: 50,
          isSmartModel: true,
          isEstimated: false,
        },
      ],
    });

    const usageRows = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.sourceId, assistantMsgId));
    expect(usageRows).toHaveLength(1);

    const contentItem = await getTextContentItem(db, assistantMsgId);
    expect(contentItem.isSmartModel).toBe(true);
    expect(contentItem.cost).toBe('0.00300000');
  });
});
