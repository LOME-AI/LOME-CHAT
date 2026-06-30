import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  conversations,
  messages,
  epochs,
  epochMembers,
  conversationMembers,
  type Database,
} from '@hushbox/db';
import {
  userFactory,
  conversationFactory,
  messageFactory,
  epochFactory,
} from '@hushbox/db/factories';
import { createFirstEpoch, generateKeyPair } from '@hushbox/crypto';
import {
  listConversations,
  getConversationForMember,
  createOrGetConversation,
  updateConversation,
  deleteConversation,
} from './conversations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

/** Encode a string to Uint8Array for test titles/content. */
function toBytes(string_: string): Uint8Array {
  return new TextEncoder().encode(string_);
}

describe('conversations service', () => {
  let db: Database;
  const createdUserIds: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterEach(async () => {
    // Clean up member rows first (avoids CHECK constraint violation when user deletion
    // triggers SET NULL on conversationMembers.userId for cross-user memberships)
    for (const userId of createdUserIds) {
      await db.delete(conversationMembers).where(eq(conversationMembers.userId, userId));
    }
    for (const userId of createdUserIds) {
      await db.delete(conversations).where(eq(conversations.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    createdUserIds.length = 0;
  });

  async function createTestUser(): Promise<typeof users.$inferSelect> {
    const accountKeyPair = generateKeyPair();
    const userData = userFactory.build({ publicKey: accountKeyPair.publicKey });
    const [user] = await db.insert(users).values(userData).returning();
    if (!user) throw new Error('Failed to create test user');
    createdUserIds.push(user.id);
    return user;
  }

  /**
   * Creates a conversation with epoch infrastructure directly in the DB
   * (bypasses createOrGetConversation for tests that don't test creation).
   */
  async function createTestConversationWithEpoch(
    userId: string,
    title?: Uint8Array
  ): Promise<{ conversationId: string; epochId: string }> {
    const convData = conversationFactory.build({
      userId,
      ...(title !== undefined && { title }),
    });
    const [conv] = await db.insert(conversations).values(convData).returning();
    if (!conv) throw new Error('Failed to create test conversation');

    const epochData = epochFactory.build({
      conversationId: conv.id,
      epochNumber: 1,
    });
    const [epoch] = await db.insert(epochs).values(epochData).returning();
    if (!epoch) throw new Error('Failed to create test epoch');

    // Owner must have a conversationMembers row (listConversations/getConversation JOIN on it)
    await db.insert(conversationMembers).values({
      conversationId: conv.id,
      userId,
      privilege: 'owner',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
      invitedByUserId: null,
    });

    return { conversationId: conv.id, epochId: epoch.id };
  }

  interface CreateTestMessageOptions {
    conversationId: string;
    sequenceNumber: number;
    senderType?: 'user' | 'ai';
    epochNumber?: number;
    userId?: string;
  }

  async function createTestMessage(options: CreateTestMessageOptions): Promise<{ id: string }> {
    const {
      conversationId,
      sequenceNumber,
      senderType = 'user',
      epochNumber = 1,
      userId,
    } = options;
    const msgData = messageFactory.build({
      conversationId,
      senderType,
      senderId: senderType === 'ai' ? null : (userId ?? null),
      sequenceNumber,
      epochNumber,
      ...(senderType === 'ai' ? { modelName: 'test-model' } : {}),
    });
    const [msg] = await db.insert(messages).values(msgData).returning();
    if (!msg) throw new Error('Failed to create test message');
    return msg;
  }

  describe('listConversations', () => {
    it('returns conversations for a user', async () => {
      const user = await createTestUser();
      await createTestConversationWithEpoch(user.id, toBytes('Conv 1'));
      await createTestConversationWithEpoch(user.id, toBytes('Conv 2'));

      const { rows } = await listConversations(db, user.id);

      expect(rows).toHaveLength(2);
    });

    it('returns empty array when user has no conversations', async () => {
      const user = await createTestUser();

      const { rows } = await listConversations(db, user.id);

      expect(rows).toEqual([]);
    });

    it('does not return conversations from other users', async () => {
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      await createTestConversationWithEpoch(user1.id, toBytes('User 1 Conv'));
      await createTestConversationWithEpoch(user2.id, toBytes('User 2 Conv'));

      const { rows } = await listConversations(db, user1.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.conversation.title).toEqual(toBytes('User 1 Conv'));
    });

    it('returns conversations where user is a member (not owner)', async () => {
      const alice = await createTestUser();
      const charlie = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(
        alice.id,
        toBytes('Alice Conv')
      );

      await db.insert(conversationMembers).values({
        conversationId,
        userId: charlie.id,
        privilege: 'write',
        visibleFromEpoch: 1,
      });

      const { rows } = await listConversations(db, charlie.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.conversation.title).toEqual(toBytes('Alice Conv'));
    });

    it('does not return conversations where user has left', async () => {
      const alice = await createTestUser();
      const charlie = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(
        alice.id,
        toBytes('Left Conv')
      );

      await db.insert(conversationMembers).values({
        conversationId,
        userId: charlie.id,
        privilege: 'write',
        visibleFromEpoch: 1,
        leftAt: new Date(),
      });

      const { rows } = await listConversations(db, charlie.id);

      expect(rows).toHaveLength(0);
    });

    it('returns both owned and shared conversations', async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      await createTestConversationWithEpoch(alice.id, toBytes('Alice Owned'));
      const { conversationId: bobConv } = await createTestConversationWithEpoch(
        bob.id,
        toBytes('Bob Owned')
      );

      await db.insert(conversationMembers).values({
        conversationId: bobConv,
        userId: alice.id,
        privilege: 'write',
        visibleFromEpoch: 1,
      });

      const { rows } = await listConversations(db, alice.id);

      expect(rows).toHaveLength(2);
      const titles = rows.map((r) => new TextDecoder().decode(r.conversation.title));
      expect(titles).toContain('Alice Owned');
      expect(titles).toContain('Bob Owned');
    });

    it('returns conversations ordered by updatedAt descending', async () => {
      const user = await createTestUser();
      const { conversationId: conv1Id } = await createTestConversationWithEpoch(
        user.id,
        toBytes('Older')
      );
      const { conversationId: conv2Id } = await createTestConversationWithEpoch(
        user.id,
        toBytes('Newer')
      );

      await db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(inArray(conversations.id, [conv1Id]));

      const { rows } = await listConversations(db, user.id);

      expect(rows[0]?.conversation.id).toBe(conv1Id);
      expect(rows[1]?.conversation.id).toBe(conv2Id);
    });

    it('returns acceptedAt as non-null for auto-accepted owner members', async () => {
      const user = await createTestUser();
      await createTestConversationWithEpoch(user.id, toBytes('My Conv'));

      const { rows } = await listConversations(db, user.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.acceptedAt).toBeInstanceOf(Date);
      expect(rows[0]?.invitedByUsername).toBeNull();
    });

    it('returns acceptedAt as null for unaccepted members', async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(
        alice.id,
        toBytes('Alice Conv')
      );

      await db.insert(conversationMembers).values({
        conversationId,
        userId: bob.id,
        privilege: 'write',
        visibleFromEpoch: 1,
        acceptedAt: null,
        invitedByUserId: alice.id,
      });

      const { rows } = await listConversations(db, bob.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.acceptedAt).toBeNull();
      expect(rows[0]?.invitedByUsername).toBe(alice.username);
    });

    it('returns invitedByUsername as null when inviter user is deleted', async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(
        alice.id,
        toBytes('Alice Conv')
      );

      await db.insert(conversationMembers).values({
        conversationId,
        userId: bob.id,
        privilege: 'write',
        visibleFromEpoch: 1,
        acceptedAt: null,
        invitedByUserId: alice.id,
      });

      // Delete Alice — FK SET NULL should clear invitedByUserId
      // First remove Alice's membership to avoid FK issues
      await db
        .delete(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, alice.id)
          )
        );
      // Transfer ownership so we can delete Alice
      await db
        .update(conversations)
        .set({ userId: bob.id })
        .where(eq(conversations.id, conversationId));
      await db.delete(users).where(eq(users.id, alice.id));
      // Remove from cleanup list since already deleted
      createdUserIds.splice(createdUserIds.indexOf(alice.id), 1);

      const { rows } = await listConversations(db, bob.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.invitedByUsername).toBeNull();
    });

    it('returns muted as false by default', async () => {
      const user = await createTestUser();
      await createTestConversationWithEpoch(user.id, toBytes('My Conv'));

      const { rows } = await listConversations(db, user.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.muted).toBe(false);
    });

    it('returns muted as true when member has muted the conversation', async () => {
      const user = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(
        user.id,
        toBytes('Muted Conv')
      );

      await db
        .update(conversationMembers)
        .set({ muted: true })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, user.id)
          )
        );

      const { rows } = await listConversations(db, user.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.muted).toBe(true);
    });
  });

  describe('listConversations pagination', () => {
    it('returns first page with nextCursor when more results exist', async () => {
      const user = await createTestUser();
      // Create 3 conversations with distinct updatedAt
      for (let index = 0; index < 3; index++) {
        const { conversationId } = await createTestConversationWithEpoch(
          user.id,
          toBytes(`Conv ${String(index)}`)
        );
        await db
          .update(conversations)
          .set({ updatedAt: new Date(Date.now() + index * 1000) })
          .where(eq(conversations.id, conversationId));
      }

      const result = await listConversations(db, user.id, { limit: 2 });

      expect(result.rows).toHaveLength(2);
      expect(result.nextCursor).not.toBeNull();
    });

    it('returns nextCursor as null on last page', async () => {
      const user = await createTestUser();
      await createTestConversationWithEpoch(user.id, toBytes('Only Conv'));

      const result = await listConversations(db, user.id, { limit: 10 });

      expect(result.rows).toHaveLength(1);
      expect(result.nextCursor).toBeNull();
    });

    it('cursor correctly paginates without duplicates or gaps', async () => {
      const user = await createTestUser();
      for (let index = 0; index < 5; index++) {
        const { conversationId } = await createTestConversationWithEpoch(
          user.id,
          toBytes(`Conv ${String(index)}`)
        );
        await db
          .update(conversations)
          .set({ updatedAt: new Date(Date.now() + index * 1000) })
          .where(eq(conversations.id, conversationId));
      }

      const page1 = await listConversations(db, user.id, { limit: 2 });
      expect(page1.rows).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listConversations(db, user.id, {
        limit: 2,
        cursor: page1.nextCursor!,
      });
      expect(page2.rows).toHaveLength(2);
      expect(page2.nextCursor).not.toBeNull();

      const page3 = await listConversations(db, user.id, {
        limit: 2,
        cursor: page2.nextCursor!,
      });
      expect(page3.rows).toHaveLength(1);
      expect(page3.nextCursor).toBeNull();

      // All 5 conversations should be present across all pages, no duplicates
      const allIds = [
        ...page1.rows.map((r) => r.conversation.id),
        ...page2.rows.map((r) => r.conversation.id),
        ...page3.rows.map((r) => r.conversation.id),
      ];
      expect(new Set(allIds).size).toBe(5);
    });

    it('defaults to all results when no options provided', async () => {
      const user = await createTestUser();
      for (let index = 0; index < 3; index++) {
        await createTestConversationWithEpoch(user.id, toBytes(`Conv ${String(index)}`));
      }

      const result = await listConversations(db, user.id);

      expect(result.rows).toHaveLength(3);
      expect(result.nextCursor).toBeNull();
    });

    it('returns pinned as false by default', async () => {
      const user = await createTestUser();
      await createTestConversationWithEpoch(user.id, toBytes('My Conv'));

      const result = await listConversations(db, user.id);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.pinned).toBe(false);
    });

    it('returns pinned as true when member has pinned the conversation', async () => {
      const user = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(
        user.id,
        toBytes('Pinned Conv')
      );

      await db
        .update(conversationMembers)
        .set({ pinned: true })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, user.id)
          )
        );

      const result = await listConversations(db, user.id);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.pinned).toBe(true);
    });
  });

  describe('getConversationForMember (unified)', () => {
    it('returns conversation with messages filtered by visibleFromEpoch without userId', async () => {
      const alice = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(alice.id, toBytes('Group'));

      await createTestMessage({
        conversationId,
        sequenceNumber: 1,
        senderType: 'user',
        epochNumber: 1,
        userId: alice.id,
      });
      await createTestMessage({
        conversationId,
        sequenceNumber: 2,
        senderType: 'ai',
        epochNumber: 1,
      });
      await createTestMessage({
        conversationId,
        sequenceNumber: 3,
        senderType: 'user',
        epochNumber: 2,
        userId: alice.id,
      });
      await createTestMessage({
        conversationId,
        sequenceNumber: 4,
        senderType: 'ai',
        epochNumber: 3,
      });
      await createTestMessage({
        conversationId,
        sequenceNumber: 5,
        senderType: 'user',
        epochNumber: 3,
        userId: alice.id,
      });

      const result = await getConversationForMember(db, conversationId, 3);

      expect(result).not.toBeNull();
      expect(result?.conversation.title).toEqual(toBytes('Group'));
      expect(result?.messages).toHaveLength(2);
      expect(result?.messages[0]?.sequenceNumber).toBe(4);
      expect(result?.messages[1]?.sequenceNumber).toBe(5);
    });

    it('returns null for non-existent conversation without userId', async () => {
      const result = await getConversationForMember(db, 'non-existent-id', 1);

      expect(result).toBeNull();
    });

    it('returns all messages when visibleFromEpoch is 1 without userId', async () => {
      const user = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(user.id);

      await createTestMessage({
        conversationId,
        sequenceNumber: 1,
        senderType: 'user',
        epochNumber: 1,
        userId: user.id,
      });
      await createTestMessage({
        conversationId,
        sequenceNumber: 2,
        senderType: 'ai',
        epochNumber: 2,
      });
      await createTestMessage({
        conversationId,
        sequenceNumber: 3,
        senderType: 'user',
        epochNumber: 3,
        userId: user.id,
      });

      const result = await getConversationForMember(db, conversationId, 1);

      expect(result).not.toBeNull();
      expect(result?.messages).toHaveLength(3);
    });

    it('returns acceptedAt as current date and invitedByUsername as null without userId (link guest)', async () => {
      const user = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(
        user.id,
        toBytes('Link Guest Conv')
      );

      const beforeCall = new Date();
      const result = await getConversationForMember(db, conversationId, 1);

      expect(result).not.toBeNull();
      expect(result?.acceptedAt).toBeInstanceOf(Date);
      expect(result!.acceptedAt!.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(result?.invitedByUsername).toBeNull();
    });

    it('returns acceptedAt and invitedByUsername from membership with userId', async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(
        alice.id,
        toBytes('Shared Conv')
      );

      await db.insert(conversationMembers).values({
        conversationId,
        userId: bob.id,
        privilege: 'write',
        visibleFromEpoch: 1,
        acceptedAt: new Date('2025-01-01'),
        invitedByUserId: alice.id,
      });

      const result = await getConversationForMember(db, conversationId, 1, bob.id);

      expect(result).not.toBeNull();
      expect(result?.acceptedAt).toEqual(new Date('2025-01-01'));
      expect(result?.invitedByUsername).toBe(alice.username);
    });

    it('returns acceptedAt as null for unaccepted member with userId', async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(
        alice.id,
        toBytes('Pending Conv')
      );

      await db.insert(conversationMembers).values({
        conversationId,
        userId: bob.id,
        privilege: 'write',
        visibleFromEpoch: 1,
        acceptedAt: null,
        invitedByUserId: alice.id,
      });

      const result = await getConversationForMember(db, conversationId, 1, bob.id);

      expect(result).not.toBeNull();
      expect(result?.acceptedAt).toBeNull();
      expect(result?.invitedByUsername).toBe(alice.username);
    });

    it('returns null for non-existent conversation with userId', async () => {
      const user = await createTestUser();

      const result = await getConversationForMember(db, 'non-existent-id', 1, user.id);

      expect(result).toBeNull();
    });

    it('filters messages by visibleFromEpoch with userId', async () => {
      const alice = await createTestUser();
      const charlie = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(alice.id);

      await db.insert(conversationMembers).values({
        conversationId,
        userId: charlie.id,
        privilege: 'write',
        visibleFromEpoch: 3,
        acceptedAt: new Date(),
      });

      await createTestMessage({
        conversationId,
        sequenceNumber: 1,
        senderType: 'user',
        epochNumber: 1,
        userId: alice.id,
      });
      await createTestMessage({
        conversationId,
        sequenceNumber: 2,
        senderType: 'ai',
        epochNumber: 1,
      });
      await createTestMessage({
        conversationId,
        sequenceNumber: 3,
        senderType: 'user',
        epochNumber: 2,
        userId: alice.id,
      });
      await createTestMessage({
        conversationId,
        sequenceNumber: 4,
        senderType: 'ai',
        epochNumber: 3,
      });
      await createTestMessage({
        conversationId,
        sequenceNumber: 5,
        senderType: 'user',
        epochNumber: 3,
        userId: alice.id,
      });

      // Should only see messages from epoch >= 3
      const result = await getConversationForMember(db, conversationId, 3, charlie.id);

      expect(result).not.toBeNull();
      expect(result?.messages).toHaveLength(2);
      expect(result?.messages[0]?.sequenceNumber).toBe(4);
      expect(result?.messages[1]?.sequenceNumber).toBe(5);
    });

    it('returns conversation with messages for owner with userId', async () => {
      const user = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(user.id, toBytes('My Conv'));
      await createTestMessage({
        conversationId,
        sequenceNumber: 1,
        senderType: 'user',
        epochNumber: 1,
        userId: user.id,
      });
      await createTestMessage({ conversationId, sequenceNumber: 2, senderType: 'ai' });

      const result = await getConversationForMember(db, conversationId, 1, user.id);

      expect(result).not.toBeNull();
      expect(result?.conversation.title).toEqual(toBytes('My Conv'));
      expect(result?.messages).toHaveLength(2);
      expect(result?.acceptedAt).toBeInstanceOf(Date);
      expect(result?.invitedByUsername).toBeNull();
    });

    it('returns invitedByUsername as null when userId has no membership (non-member)', async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(
        alice.id,
        toBytes('Private Conv')
      );

      // Bob is not a member — with userId but no membership row, should still return conversation
      // (membership check is done by middleware, not this function)
      const result = await getConversationForMember(db, conversationId, 1, bob.id);

      expect(result).not.toBeNull();
      expect(result?.acceptedAt).toBeNull();
      expect(result?.invitedByUsername).toBeNull();
    });
  });

  describe('createOrGetConversation', () => {
    it('creates conversation with epoch infrastructure in a single transaction', async () => {
      const user = await createTestUser();
      const conversationId = crypto.randomUUID();
      const encTitle = toBytes('New Conversation');

      const accountKeyPair = generateKeyPair();
      const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
      const memberWrap = epochResult.memberWraps[0];
      if (!memberWrap) throw new Error('Expected member wrap');

      const result = await createOrGetConversation(db, user.id, {
        id: conversationId,
        title: encTitle,
        epochPublicKey: epochResult.epochPublicKey,
        confirmationHash: epochResult.confirmationHash,
        memberWrap: memberWrap.wrap,
        userPublicKey: accountKeyPair.publicKey,
      });

      expect(result).not.toBeNull();
      expect(result?.isNew).toBe(true);
      expect(result?.conversation.id).toBe(conversationId);
      expect(result?.conversation.title).toEqual(encTitle);
      expect(result?.conversation.userId).toBe(user.id);
      expect(result?.conversation.currentEpoch).toBe(1);
      expect(result?.conversation.titleEpochNumber).toBe(1);
      expect(result?.conversation.nextSequence).toBe(1);
    });

    it('creates epoch row with correct data', async () => {
      const user = await createTestUser();
      const conversationId = crypto.randomUUID();

      const accountKeyPair = generateKeyPair();
      const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
      const memberWrap = epochResult.memberWraps[0];
      if (!memberWrap) throw new Error('Expected member wrap');

      const result = await createOrGetConversation(db, user.id, {
        id: conversationId,
        title: toBytes('Test'),
        epochPublicKey: epochResult.epochPublicKey,
        confirmationHash: epochResult.confirmationHash,
        memberWrap: memberWrap.wrap,
        userPublicKey: accountKeyPair.publicKey,
      });
      expect(result?.isNew).toBe(true);

      const [epoch] = await db
        .select()
        .from(epochs)
        .where(eq(epochs.conversationId, conversationId));
      expect(epoch).toBeDefined();
      expect(epoch?.epochNumber).toBe(1);
      expect(epoch?.epochPublicKey).toEqual(epochResult.epochPublicKey);
      expect(epoch?.confirmationHash).toEqual(epochResult.confirmationHash);
      expect(epoch?.chainLink).toBeNull();
    });

    it('creates epoch member row with correct data', async () => {
      const user = await createTestUser();
      const conversationId = crypto.randomUUID();

      const accountKeyPair = generateKeyPair();
      const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
      const memberWrap = epochResult.memberWraps[0];
      if (!memberWrap) throw new Error('Expected member wrap');

      const result = await createOrGetConversation(db, user.id, {
        id: conversationId,
        title: toBytes('Test'),
        epochPublicKey: epochResult.epochPublicKey,
        confirmationHash: epochResult.confirmationHash,
        memberWrap: memberWrap.wrap,
        userPublicKey: accountKeyPair.publicKey,
      });
      expect(result?.isNew).toBe(true);

      const [epoch] = await db
        .select()
        .from(epochs)
        .where(eq(epochs.conversationId, conversationId));
      if (!epoch) throw new Error('Epoch not found');

      const [member] = await db
        .select()
        .from(epochMembers)
        .where(eq(epochMembers.epochId, epoch.id));
      expect(member).toBeDefined();
      expect(member?.memberPublicKey).toEqual(accountKeyPair.publicKey);
      expect(member?.wrap).toEqual(memberWrap.wrap);
      expect(member?.visibleFromEpoch).toBe(1);
    });

    it('creates conversation member row with correct data', async () => {
      const user = await createTestUser();
      const conversationId = crypto.randomUUID();

      const accountKeyPair = generateKeyPair();
      const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
      const memberWrap = epochResult.memberWraps[0];
      if (!memberWrap) throw new Error('Expected member wrap');

      const result = await createOrGetConversation(db, user.id, {
        id: conversationId,
        title: toBytes('Test'),
        epochPublicKey: epochResult.epochPublicKey,
        confirmationHash: epochResult.confirmationHash,
        memberWrap: memberWrap.wrap,
        userPublicKey: accountKeyPair.publicKey,
      });
      expect(result?.isNew).toBe(true);

      const [convMember] = await db
        .select()
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, conversationId));
      expect(convMember).toBeDefined();
      expect(convMember?.userId).toBe(user.id);
      expect(convMember?.privilege).toBe('owner');
      expect(convMember?.visibleFromEpoch).toBe(1);
      expect(convMember?.leftAt).toBeNull();
      // Creator is auto-accepted, not invited by anyone
      expect(convMember?.acceptedAt).toBeInstanceOf(Date);
      expect(convMember?.invitedByUserId).toBeNull();
    });

    it('returns existing conversation for same user and same ID (idempotent)', async () => {
      const user = await createTestUser();
      const conversationId = crypto.randomUUID();
      const encTitle = toBytes('First Title');

      const accountKeyPair = generateKeyPair();
      const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
      const memberWrap = epochResult.memberWraps[0];
      if (!memberWrap) throw new Error('Expected member wrap');

      const params = {
        id: conversationId,
        title: encTitle,
        epochPublicKey: epochResult.epochPublicKey,
        confirmationHash: epochResult.confirmationHash,
        memberWrap: memberWrap.wrap,
        userPublicKey: accountKeyPair.publicKey,
      };

      const firstResult = await createOrGetConversation(db, user.id, params);
      expect(firstResult?.isNew).toBe(true);

      const secondResult = await createOrGetConversation(db, user.id, {
        ...params,
        title: toBytes('Different Title'), // Should be ignored
      });

      expect(secondResult).not.toBeNull();
      expect(secondResult?.isNew).toBe(false);
      expect(secondResult?.conversation.id).toBe(conversationId);
      expect(secondResult?.conversation.title).toEqual(encTitle); // Original title preserved
    });

    it('returns null for existing ID owned by different user', async () => {
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const conversationId = crypto.randomUUID();

      const accountKeyPair = generateKeyPair();
      const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
      const memberWrap = epochResult.memberWraps[0];
      if (!memberWrap) throw new Error('Expected member wrap');

      const params = {
        id: conversationId,
        title: toBytes('User1 Conv'),
        epochPublicKey: epochResult.epochPublicKey,
        confirmationHash: epochResult.confirmationHash,
        memberWrap: memberWrap.wrap,
        userPublicKey: accountKeyPair.publicKey,
      };

      const firstResult = await createOrGetConversation(db, user1.id, params);
      expect(firstResult?.isNew).toBe(true);

      // User 2 tries to use same ID - should get null (ownership mismatch)
      const secondResult = await createOrGetConversation(db, user2.id, params);
      expect(secondResult).toBeNull();
    });

    it('creates conversation without title using empty bytes', async () => {
      const user = await createTestUser();
      const conversationId = crypto.randomUUID();

      const accountKeyPair = generateKeyPair();
      const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
      const memberWrap = epochResult.memberWraps[0];
      if (!memberWrap) throw new Error('Expected member wrap');

      const result = await createOrGetConversation(db, user.id, {
        id: conversationId,
        epochPublicKey: epochResult.epochPublicKey,
        confirmationHash: epochResult.confirmationHash,
        memberWrap: memberWrap.wrap,
        userPublicKey: accountKeyPair.publicKey,
      });

      expect(result?.conversation.title).toEqual(new Uint8Array(0));
    });

    it('returns all messages when returning existing conversation', async () => {
      const user = await createTestUser();
      const conversationId = crypto.randomUUID();

      const accountKeyPair = generateKeyPair();
      const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
      const memberWrap = epochResult.memberWraps[0];
      if (!memberWrap) throw new Error('Expected member wrap');

      const params = {
        id: conversationId,
        title: toBytes('Test Conv'),
        epochPublicKey: epochResult.epochPublicKey,
        confirmationHash: epochResult.confirmationHash,
        memberWrap: memberWrap.wrap,
        userPublicKey: accountKeyPair.publicKey,
      };

      const firstResult = await createOrGetConversation(db, user.id, params);
      expect(firstResult?.isNew).toBe(true);

      await createTestMessage({
        conversationId,
        sequenceNumber: 1,
        senderType: 'user',
        epochNumber: 1,
        userId: user.id,
      });
      await createTestMessage({ conversationId, sequenceNumber: 2, senderType: 'ai' });

      const secondResult = await createOrGetConversation(db, user.id, params);

      expect(secondResult).not.toBeNull();
      expect(secondResult?.isNew).toBe(false);
      const msgs = secondResult?.messages;
      expect(msgs).toHaveLength(2);
      // Messages should be ordered by sequenceNumber
      expect(msgs?.[0]?.sequenceNumber).toBe(1);
      expect(msgs?.[1]?.sequenceNumber).toBe(2);
    });

    it('handles concurrent creation of same conversation ID', async () => {
      const user = await createTestUser();
      const conversationId = crypto.randomUUID();

      const accountKeyPair = generateKeyPair();
      const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
      const memberWrap = epochResult.memberWraps[0];
      if (!memberWrap) throw new Error('Expected member wrap');

      const params = {
        id: conversationId,
        title: toBytes('Concurrent'),
        epochPublicKey: epochResult.epochPublicKey,
        confirmationHash: epochResult.confirmationHash,
        memberWrap: memberWrap.wrap,
        userPublicKey: accountKeyPair.publicKey,
      };

      // Simulate two concurrent requests (race condition)
      const [result1, result2] = await Promise.all([
        createOrGetConversation(db, user.id, params),
        createOrGetConversation(db, user.id, params),
      ]);

      // Both should succeed - one creates, one returns existing
      if (!result1 || !result2) {
        throw new Error('Expected both results to be defined');
      }
      expect(result1.conversation.id).toBe(conversationId);
      expect(result2.conversation.id).toBe(conversationId);

      const newCount = [result1.isNew, result2.isNew].filter(Boolean).length;
      expect(newCount).toBe(1);

      // Only one epoch should exist (no duplicates)
      const epochRows = await db
        .select()
        .from(epochs)
        .where(eq(epochs.conversationId, conversationId));
      expect(epochRows).toHaveLength(1);
    });

    it('does not create duplicate epoch members on idempotent retry', async () => {
      const user = await createTestUser();
      const conversationId = crypto.randomUUID();

      const accountKeyPair = generateKeyPair();
      const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
      const memberWrap = epochResult.memberWraps[0];
      if (!memberWrap) throw new Error('Expected member wrap');

      const params = {
        id: conversationId,
        title: toBytes('Test'),
        epochPublicKey: epochResult.epochPublicKey,
        confirmationHash: epochResult.confirmationHash,
        memberWrap: memberWrap.wrap,
        userPublicKey: accountKeyPair.publicKey,
      };

      await createOrGetConversation(db, user.id, params);
      await createOrGetConversation(db, user.id, params);

      // Only one epoch member should exist
      const [epoch] = await db
        .select()
        .from(epochs)
        .where(eq(epochs.conversationId, conversationId));
      if (!epoch) throw new Error('Epoch not found');
      const members = await db
        .select()
        .from(epochMembers)
        .where(eq(epochMembers.epochId, epoch.id));
      expect(members).toHaveLength(1);

      // Only one conversation member should exist
      const convMembers = await db
        .select()
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, conversationId));
      expect(convMembers).toHaveLength(1);
    });
  });

  describe('updateConversation', () => {
    it('updates conversation title', async () => {
      const user = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(
        user.id,
        toBytes('Old Title')
      );

      const result = await updateConversation(db, conversationId, user.id, {
        title: toBytes('New Title'),
        titleEpochNumber: 1,
      });

      expect(result).not.toBeNull();
      expect(result?.title).toEqual(toBytes('New Title'));
    });

    it('returns null for non-existent conversation', async () => {
      const user = await createTestUser();

      const result = await updateConversation(db, 'non-existent-id', user.id, {
        title: toBytes('Title'),
        titleEpochNumber: 1,
      });

      expect(result).toBeNull();
    });

    it('returns null when user does not own conversation', async () => {
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(
        user1.id,
        toBytes('User 1 Conv')
      );

      const result = await updateConversation(db, conversationId, user2.id, {
        title: toBytes('Hijacked'),
        titleEpochNumber: 1,
      });

      expect(result).toBeNull();
    });

    it('updates updatedAt timestamp', async () => {
      const user = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(user.id);

      const [original] = await db
        .select({ updatedAt: conversations.updatedAt })
        .from(conversations)
        .where(inArray(conversations.id, [conversationId]));

      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = await updateConversation(db, conversationId, user.id, {
        title: toBytes('Updated'),
        titleEpochNumber: 1,
      });

      if (!original) throw new Error('Original conversation not found');
      expect(result?.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
    });
  });

  describe('deleteConversation', () => {
    it('deletes conversation and returns true', async () => {
      const user = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(user.id);

      const result = await deleteConversation(db, conversationId, user.id);

      expect(result).toBe(true);
    });

    it('returns false for non-existent conversation', async () => {
      const user = await createTestUser();

      const result = await deleteConversation(db, 'non-existent-id', user.id);

      expect(result).toBe(false);
    });

    it('returns false when user does not own conversation', async () => {
      const user1 = await createTestUser();
      const user2 = await createTestUser();
      const { conversationId } = await createTestConversationWithEpoch(user1.id);

      const result = await deleteConversation(db, conversationId, user2.id);

      expect(result).toBe(false);
    });

    it('cascades delete to messages, epochs, epoch members, and conversation members', async () => {
      const user = await createTestUser();
      const conversationId = crypto.randomUUID();

      // Create via createOrGetConversation so epoch infrastructure exists
      const accountKeyPair = generateKeyPair();
      const epochResult = createFirstEpoch([accountKeyPair.publicKey]);
      const memberWrap = epochResult.memberWraps[0];
      if (!memberWrap) throw new Error('Expected member wrap');

      await createOrGetConversation(db, user.id, {
        id: conversationId,
        title: toBytes('To Delete'),
        epochPublicKey: epochResult.epochPublicKey,
        confirmationHash: epochResult.confirmationHash,
        memberWrap: memberWrap.wrap,
        userPublicKey: accountKeyPair.publicKey,
      });

      await createTestMessage({
        conversationId,
        sequenceNumber: 1,
        senderType: 'user',
        epochNumber: 1,
        userId: user.id,
      });

      await deleteConversation(db, conversationId, user.id);

      const remainingMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId));
      expect(remainingMessages).toHaveLength(0);

      const remainingEpochs = await db
        .select()
        .from(epochs)
        .where(eq(epochs.conversationId, conversationId));
      expect(remainingEpochs).toHaveLength(0);

      const remainingConvMembers = await db
        .select()
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, conversationId));
      expect(remainingConvMembers).toHaveLength(0);
    });
  });
});
