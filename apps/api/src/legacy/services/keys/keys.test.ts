import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  conversations,
  epochs,
  epochMembers,
  conversationMembers,
  type Database,
} from '@hushbox/db';
import { userFactory, epochFactory, epochMemberFactory } from '@hushbox/db/factories';
import {
  generateKeyPair,
  createFirstEpoch,
  performEpochRotation,
  unwrapEpochKey,
  traverseChainLink,
  verifyEpochKeyConfirmation,
} from '@hushbox/crypto';
import { createOrGetConversation } from '../conversations/index.js';
import {
  getKeyChain,
  getMemberKeys,
  verifyMembership,
  submitRotation,
  StaleEpochError,
  WrapSetMismatchError,
  toRotationParams,
} from './keys.js';

/** Narrows nullable to T — throws in tests if value is unexpectedly absent. */
function defined<T>(value: T | undefined | null, label = 'value'): T {
  if (value == null) throw new Error(`Expected ${label} to be defined`);
  return value;
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

describe('keys service', () => {
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

  async function createTestUser(): Promise<typeof users.$inferSelect> {
    const accountKeyPair = generateKeyPair();
    const userData = userFactory.build({ publicKey: accountKeyPair.publicKey });
    const [user] = await db.insert(users).values(userData).returning();
    if (!user) throw new Error('Failed to create test user');
    createdUserIds.push(user.id);
    return user;
  }

  async function createConversationWithEpoch(
    userId: string,
    userPublicKey: Uint8Array
  ): Promise<{ conversationId: string; epochPublicKey: Uint8Array; confirmationHash: Uint8Array }> {
    const conversationId = crypto.randomUUID();
    const epochResult = createFirstEpoch([userPublicKey]);
    const memberWrap = epochResult.memberWraps[0];
    if (!memberWrap) throw new Error('Expected member wrap');

    const result = await createOrGetConversation(db, userId, {
      id: conversationId,
      epochPublicKey: epochResult.epochPublicKey,
      confirmationHash: epochResult.confirmationHash,
      memberWrap: memberWrap.wrap,
      userPublicKey,
    });
    if (!result) throw new Error('Failed to create conversation');

    return {
      conversationId,
      epochPublicKey: epochResult.epochPublicKey,
      confirmationHash: epochResult.confirmationHash,
    };
  }

  describe('getKeyChain', () => {
    it('returns wraps and empty chainLinks for single-epoch conversation', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const result = await getKeyChain(db, conversationId, user.publicKey);

      expect(result).not.toBeNull();
      const r = defined(result);
      expect(r.wraps).toHaveLength(1);
      const w0 = defined(r.wraps[0]);
      expect(w0.epochNumber).toBe(1);
      expect(w0.visibleFromEpoch).toBe(1);
      expect(w0.wrap).toBeInstanceOf(Uint8Array);
      expect(r.chainLinks).toEqual([]);
    });

    it('returns null for non-member (unknown public key)', async () => {
      const user = await createTestUser();
      await createConversationWithEpoch(user.id, user.publicKey);
      const unknownKey = generateKeyPair().publicKey;

      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);
      const result = await getKeyChain(db, conversationId, unknownKey);

      expect(result).toBeNull();
    });

    it('returns currentEpoch matching the conversation', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const result = await getKeyChain(db, conversationId, user.publicKey);

      expect(result).not.toBeNull();
      expect(defined(result).currentEpoch).toBe(1);
    });

    it('returns chain links when a second epoch exists with a chainLink', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const chainLinkBytes = new Uint8Array(64).fill(42);
      const epoch2Data = epochFactory.build({
        conversationId,
        epochNumber: 2,
        chainLink: chainLinkBytes,
      });
      const [epoch2] = await db.insert(epochs).values(epoch2Data).returning();
      if (!epoch2) throw new Error('Failed to create epoch 2');

      const wrapBytes = new Uint8Array(48).fill(99);
      await db.insert(epochMembers).values(
        epochMemberFactory.build({
          epochId: epoch2.id,
          memberPublicKey: user.publicKey,
          wrap: wrapBytes,
          visibleFromEpoch: 1,
        })
      );

      await db
        .update(conversations)
        .set({ currentEpoch: 2 })
        .where(eq(conversations.id, conversationId));

      const result = await getKeyChain(db, conversationId, user.publicKey);

      expect(result).not.toBeNull();
      const r = defined(result);
      expect(r.wraps).toHaveLength(2);
      expect(r.chainLinks).toHaveLength(1);
      const cl0 = defined(r.chainLinks[0]);
      expect(cl0.epochNumber).toBe(2);
      expect(cl0.chainLink).toEqual(chainLinkBytes);
      expect(r.currentEpoch).toBe(2);
    });

    it('filters chain links by visibleFromEpoch', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const chainLink2 = new Uint8Array(64).fill(2);
      const chainLink3 = new Uint8Array(64).fill(3);
      const chainLink4 = new Uint8Array(64).fill(4);

      const epoch2Data = epochFactory.build({
        conversationId,
        epochNumber: 2,
        chainLink: chainLink2,
      });
      const [epoch2] = await db.insert(epochs).values(epoch2Data).returning();
      if (!epoch2) throw new Error('Failed to create epoch 2');

      const epoch3Data = epochFactory.build({
        conversationId,
        epochNumber: 3,
        chainLink: chainLink3,
      });
      const [epoch3] = await db.insert(epochs).values(epoch3Data).returning();
      if (!epoch3) throw new Error('Failed to create epoch 3');

      const epoch4Data = epochFactory.build({
        conversationId,
        epochNumber: 4,
        chainLink: chainLink4,
      });
      const [epoch4] = await db.insert(epochs).values(epoch4Data).returning();
      if (!epoch4) throw new Error('Failed to create epoch 4');

      // Member joined at epoch 3 — visibleFromEpoch = 3
      // Only add wraps for epochs 3 and 4 (member wasn't in epochs 1, 2)
      await db.insert(epochMembers).values(
        epochMemberFactory.build({
          epochId: epoch3.id,
          memberPublicKey: user.publicKey,
          wrap: new Uint8Array(48).fill(33),
          visibleFromEpoch: 3,
        })
      );
      await db.insert(epochMembers).values(
        epochMemberFactory.build({
          epochId: epoch4.id,
          memberPublicKey: user.publicKey,
          wrap: new Uint8Array(48).fill(44),
          visibleFromEpoch: 3,
        })
      );

      // Delete the original epoch 1 wrap for this user (simulate: member was added later)
      const [epoch1] = await db
        .select()
        .from(epochs)
        .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, 1)));
      if (!epoch1) throw new Error('Epoch 1 not found');
      await db.delete(epochMembers).where(eq(epochMembers.epochId, epoch1.id));

      await db
        .update(conversations)
        .set({ currentEpoch: 4 })
        .where(eq(conversations.id, conversationId));

      const result = await getKeyChain(db, conversationId, user.publicKey);

      expect(result).not.toBeNull();
      const r = defined(result);
      // Should only see chain links for epochs > 3 (not >=)
      // Chain link at epoch 3 connects to epoch 2, which is before visibleFromEpoch=3
      expect(r.chainLinks).toHaveLength(1);
      expect(defined(r.chainLinks[0]).epochNumber).toBe(4);
      const epochNumbers = r.chainLinks.map((cl) => cl.epochNumber);
      expect(epochNumbers).not.toContain(2);
      expect(epochNumbers).not.toContain(3);
    });

    it('returns all chain links when visibleFromEpoch is 1', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const chainLink2 = new Uint8Array(64).fill(22);
      const epoch2Data = epochFactory.build({
        conversationId,
        epochNumber: 2,
        chainLink: chainLink2,
      });
      const [epoch2] = await db.insert(epochs).values(epoch2Data).returning();
      if (!epoch2) throw new Error('Failed to create epoch 2');

      // Add wrap for epoch 2 with visibleFromEpoch = 1 (full history access)
      await db.insert(epochMembers).values(
        epochMemberFactory.build({
          epochId: epoch2.id,
          memberPublicKey: user.publicKey,
          wrap: new Uint8Array(48).fill(22),
          visibleFromEpoch: 1,
        })
      );

      await db
        .update(conversations)
        .set({ currentEpoch: 2 })
        .where(eq(conversations.id, conversationId));

      const result = await getKeyChain(db, conversationId, user.publicKey);

      expect(result).not.toBeNull();
      const r = defined(result);
      expect(r.chainLinks).toHaveLength(1);
      expect(defined(r.chainLinks[0]).epochNumber).toBe(2);
      expect(r.wraps).toHaveLength(2);
    });

    it('handles member with single wrap correctly for visibleFromEpoch filtering', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const chainLink2 = new Uint8Array(64).fill(20);
      const chainLink3 = new Uint8Array(64).fill(30);

      const epoch2Data = epochFactory.build({
        conversationId,
        epochNumber: 2,
        chainLink: chainLink2,
      });
      const [epoch2] = await db.insert(epochs).values(epoch2Data).returning();
      if (!epoch2) throw new Error('Failed to create epoch 2');

      const epoch3Data = epochFactory.build({
        conversationId,
        epochNumber: 3,
        chainLink: chainLink3,
      });
      const [epoch3] = await db.insert(epochs).values(epoch3Data).returning();
      if (!epoch3) throw new Error('Failed to create epoch 3');

      // Member has only one wrap at epoch 3 with visibleFromEpoch=3
      await db.insert(epochMembers).values(
        epochMemberFactory.build({
          epochId: epoch3.id,
          memberPublicKey: user.publicKey,
          wrap: new Uint8Array(48).fill(33),
          visibleFromEpoch: 3,
        })
      );

      const [epoch1] = await db
        .select()
        .from(epochs)
        .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, 1)));
      if (!epoch1) throw new Error('Epoch 1 not found');
      await db.delete(epochMembers).where(eq(epochMembers.epochId, epoch1.id));

      await db
        .update(conversations)
        .set({ currentEpoch: 3 })
        .where(eq(conversations.id, conversationId));

      const result = await getKeyChain(db, conversationId, user.publicKey);

      expect(result).not.toBeNull();
      const r = defined(result);
      expect(r.wraps).toHaveLength(1);
      expect(defined(r.wraps[0]).visibleFromEpoch).toBe(3);
      // No chain links returned — epoch 3's chain link connects to epoch 2 (before visibleFromEpoch=3)
      expect(r.chainLinks).toHaveLength(0);
    });

    it('wraps are ordered by epochNumber ASC', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      // Add epochs 2 and 3 in reverse order
      const epoch3Data = epochFactory.build({ conversationId, epochNumber: 3 });
      const [epoch3] = await db.insert(epochs).values(epoch3Data).returning();
      if (!epoch3) throw new Error('Failed to create epoch 3');

      const epoch2Data = epochFactory.build({ conversationId, epochNumber: 2 });
      const [epoch2] = await db.insert(epochs).values(epoch2Data).returning();
      if (!epoch2) throw new Error('Failed to create epoch 2');

      // Add wraps for epoch 3 first, then 2
      await db.insert(epochMembers).values(
        epochMemberFactory.build({
          epochId: epoch3.id,
          memberPublicKey: user.publicKey,
          wrap: new Uint8Array(48).fill(3),
          visibleFromEpoch: 1,
        })
      );
      await db.insert(epochMembers).values(
        epochMemberFactory.build({
          epochId: epoch2.id,
          memberPublicKey: user.publicKey,
          wrap: new Uint8Array(48).fill(2),
          visibleFromEpoch: 1,
        })
      );

      const result = await getKeyChain(db, conversationId, user.publicKey);

      expect(result).not.toBeNull();
      const r = defined(result);
      expect(r.wraps).toHaveLength(3);
      expect(defined(r.wraps[0]).epochNumber).toBe(1);
      expect(defined(r.wraps[1]).epochNumber).toBe(2);
      expect(defined(r.wraps[2]).epochNumber).toBe(3);
    });
  });

  describe('getMemberKeys', () => {
    it('returns owner public key for a conversation', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const result = await getMemberKeys(db, conversationId);

      expect(result).toHaveLength(1);
      const r0 = defined(result[0]);
      expect(r0.userId).toBe(user.id);
      expect(r0.publicKey).toEqual(user.publicKey);
      expect(r0.privilege).toBe('owner');
    });

    it('returns empty array for conversation with no active user members', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      // Set leftAt on the member to simulate leaving
      await db
        .update(conversationMembers)
        .set({ leftAt: new Date() })
        .where(eq(conversationMembers.conversationId, conversationId));

      const result = await getMemberKeys(db, conversationId);

      expect(result).toEqual([]);
    });
  });

  describe('verifyMembership', () => {
    it('returns member row for active member', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const result = await verifyMembership(db, conversationId, user.id);

      expect(result).not.toBeNull();
      const r = defined(result);
      expect(r.userId).toBe(user.id);
      expect(r.conversationId).toBe(conversationId);
      expect(r.privilege).toBe('owner');
      expect(r.leftAt).toBeNull();
    });

    it('returns null for non-member userId', async () => {
      const user = await createTestUser();
      const otherUser = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const result = await verifyMembership(db, conversationId, otherUser.id);

      expect(result).toBeNull();
    });

    it('returns null after member has left', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      await db
        .update(conversationMembers)
        .set({ leftAt: new Date() })
        .where(eq(conversationMembers.conversationId, conversationId));

      const result = await verifyMembership(db, conversationId, user.id);

      expect(result).toBeNull();
    });
  });

  describe('submitRotation', () => {
    it('rotates epoch successfully', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const rotationResult = createFirstEpoch([user.publicKey]);
      const encryptedTitle = new Uint8Array([1, 2, 3, 4, 5]);
      const chainLinkBytes = new Uint8Array(64).fill(77);

      const result = await submitRotation(db, {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: rotationResult.epochPublicKey,
        confirmationHash: rotationResult.confirmationHash,
        chainLink: chainLinkBytes,
        memberWraps: [
          {
            memberPublicKey: user.publicKey,
            wrap: defined(rotationResult.memberWraps[0]).wrap,
          },
        ],
        encryptedTitle,
      });

      expect(result.newEpochNumber).toBe(2);
      expect(result.newEpochId).toBeDefined();
      expect(typeof result.newEpochId).toBe('string');

      const [conv] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      const c = defined(conv);
      expect(c.currentEpoch).toBe(2);

      const [newEpoch] = await db
        .select()
        .from(epochs)
        .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, 2)));
      expect(newEpoch).toBeDefined();
      const ne = defined(newEpoch);
      expect(ne.chainLink).toEqual(chainLinkBytes);
      expect(ne.epochPublicKey).toEqual(rotationResult.epochPublicKey);

      const newMembers = await db
        .select()
        .from(epochMembers)
        .where(eq(epochMembers.epochId, ne.id));
      expect(newMembers).toHaveLength(1);
      expect(defined(newMembers[0]).memberPublicKey).toEqual(user.publicKey);
    });

    it('throws StaleEpochError when expectedEpoch does not match', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const rotationResult = createFirstEpoch([user.publicKey]);

      await expect(
        submitRotation(db, {
          conversationId,
          expectedEpoch: 5,
          epochPublicKey: rotationResult.epochPublicKey,
          confirmationHash: rotationResult.confirmationHash,
          chainLink: new Uint8Array(64).fill(1),
          memberWraps: [
            {
              memberPublicKey: user.publicKey,
              wrap: defined(rotationResult.memberWraps[0]).wrap,
            },
          ],
          encryptedTitle: new Uint8Array([10, 20, 30]),
        })
      ).rejects.toThrow(StaleEpochError);

      const [conv] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(defined(conv).currentEpoch).toBe(1);
    });

    it('deletes old epoch member wraps after rotation', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const [epoch1] = await db
        .select()
        .from(epochs)
        .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, 1)));
      if (!epoch1) throw new Error('Epoch 1 not found');

      const membersBefore = await db
        .select()
        .from(epochMembers)
        .where(eq(epochMembers.epochId, epoch1.id));
      expect(membersBefore).toHaveLength(1);

      const rotationResult = createFirstEpoch([user.publicKey]);

      await submitRotation(db, {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: rotationResult.epochPublicKey,
        confirmationHash: rotationResult.confirmationHash,
        chainLink: new Uint8Array(64).fill(88),
        memberWraps: [
          {
            memberPublicKey: user.publicKey,
            wrap: defined(rotationResult.memberWraps[0]).wrap,
          },
        ],
        encryptedTitle: new Uint8Array([5, 6, 7]),
      });

      const membersAfter = await db
        .select()
        .from(epochMembers)
        .where(eq(epochMembers.epochId, epoch1.id));
      expect(membersAfter).toHaveLength(0);
    });

    it('uses authoritative visibleFromEpoch from conversationMembers for epoch members', async () => {
      const owner = await createTestUser();
      const memberUser = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(owner.id, owner.publicKey);

      // Add second user as member with visibleFromEpoch=1 (full history)
      await db.insert(conversationMembers).values({
        conversationId,
        userId: memberUser.id,
        privilege: 'write',
        visibleFromEpoch: 1,
      });

      const [epoch1] = await db
        .select()
        .from(epochs)
        .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, 1)));
      if (!epoch1) throw new Error('Epoch 1 not found');

      await db.insert(epochMembers).values(
        epochMemberFactory.build({
          epochId: epoch1.id,
          memberPublicKey: memberUser.publicKey,
          wrap: new Uint8Array(48).fill(11),
          visibleFromEpoch: 1,
        })
      );

      const rotationResult = createFirstEpoch([owner.publicKey, memberUser.publicKey]);

      await submitRotation(db, {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: rotationResult.epochPublicKey,
        confirmationHash: rotationResult.confirmationHash,
        chainLink: new Uint8Array(64).fill(33),
        memberWraps: [
          {
            memberPublicKey: owner.publicKey,
            wrap: defined(rotationResult.memberWraps[0]).wrap,
          },
          {
            memberPublicKey: memberUser.publicKey,
            wrap: defined(rotationResult.memberWraps[1]).wrap,
          },
        ],
        encryptedTitle: new Uint8Array([1, 2, 3]),
      });

      // Verify new epoch members have visibleFromEpoch from conversationMembers (authoritative)
      const [newEpoch] = await db
        .select()
        .from(epochs)
        .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, 2)));
      const ne = defined(newEpoch);

      const newMembers = await db
        .select()
        .from(epochMembers)
        .where(eq(epochMembers.epochId, ne.id));

      expect(newMembers).toHaveLength(2);
      for (const member of newMembers) {
        expect(member.visibleFromEpoch).toBe(1);
      }
    });

    it('updates title and titleEpochNumber', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const rotationResult = createFirstEpoch([user.publicKey]);
      const newTitle = new Uint8Array([100, 200, 150, 50]);

      await submitRotation(db, {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: rotationResult.epochPublicKey,
        confirmationHash: rotationResult.confirmationHash,
        chainLink: new Uint8Array(64).fill(55),
        memberWraps: [
          {
            memberPublicKey: user.publicKey,
            wrap: defined(rotationResult.memberWraps[0]).wrap,
          },
        ],
        encryptedTitle: newTitle,
      });

      const [conv] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      const c = defined(conv);
      expect(c.title).toEqual(newTitle);
      expect(c.titleEpochNumber).toBe(2);
    });

    it('throws WrapSetMismatchError when memberWraps has extra keys not in active members', async () => {
      const user = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(user.id, user.publicKey);

      const unknownKey = generateKeyPair().publicKey;
      const rotationResult = createFirstEpoch([user.publicKey, unknownKey]);

      await expect(
        submitRotation(db, {
          conversationId,
          expectedEpoch: 1,
          epochPublicKey: rotationResult.epochPublicKey,
          confirmationHash: rotationResult.confirmationHash,
          chainLink: new Uint8Array(64).fill(1),
          memberWraps: [
            {
              memberPublicKey: user.publicKey,
              wrap: defined(rotationResult.memberWraps[0]).wrap,
            },
            {
              memberPublicKey: unknownKey,
              wrap: defined(rotationResult.memberWraps[1]).wrap,
            },
          ],
          encryptedTitle: new Uint8Array([1, 2, 3]),
        })
      ).rejects.toThrow(WrapSetMismatchError);
    });

    it('throws WrapSetMismatchError when memberWraps is missing keys for active members', async () => {
      const owner = await createTestUser();
      const memberUser = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(owner.id, owner.publicKey);

      await db.insert(conversationMembers).values({
        conversationId,
        userId: memberUser.id,
        privilege: 'write',
        visibleFromEpoch: 1,
      });

      // Only provide wrap for owner, omitting memberUser
      const rotationResult = createFirstEpoch([owner.publicKey]);

      await expect(
        submitRotation(db, {
          conversationId,
          expectedEpoch: 1,
          epochPublicKey: rotationResult.epochPublicKey,
          confirmationHash: rotationResult.confirmationHash,
          chainLink: new Uint8Array(64).fill(2),
          memberWraps: [
            {
              memberPublicKey: owner.publicKey,
              wrap: defined(rotationResult.memberWraps[0]).wrap,
            },
          ],
          encryptedTitle: new Uint8Array([4, 5, 6]),
        })
      ).rejects.toThrow(WrapSetMismatchError);
    });

    it('succeeds when memberWraps exactly matches active members', async () => {
      const owner = await createTestUser();
      const memberUser = await createTestUser();
      const { conversationId } = await createConversationWithEpoch(owner.id, owner.publicKey);

      await db.insert(conversationMembers).values({
        conversationId,
        userId: memberUser.id,
        privilege: 'write',
        visibleFromEpoch: 1,
      });

      const rotationResult = createFirstEpoch([owner.publicKey, memberUser.publicKey]);

      const result = await submitRotation(db, {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: rotationResult.epochPublicKey,
        confirmationHash: rotationResult.confirmationHash,
        chainLink: new Uint8Array(64).fill(3),
        memberWraps: [
          {
            memberPublicKey: owner.publicKey,
            wrap: defined(rotationResult.memberWraps[0]).wrap,
          },
          {
            memberPublicKey: memberUser.publicKey,
            wrap: defined(rotationResult.memberWraps[1]).wrap,
          },
        ],
        encryptedTitle: new Uint8Array([7, 8, 9]),
      });

      expect(result.newEpochNumber).toBe(2);
    });
  });

  describe('key recovery after rotation (add member without history)', () => {
    it('returns key chain that allows real crypto chain link traversal to recover epoch 1 key', async () => {
      const ownerAccount = generateKeyPair();
      const owner = await createTestUser();
      // Override public key to match our generated key pair
      await db
        .update(users)
        .set({ publicKey: ownerAccount.publicKey })
        .where(eq(users.id, owner.id));

      const conversationId = crypto.randomUUID();
      const epoch1 = createFirstEpoch([ownerAccount.publicKey]);
      const memberWrap = defined(epoch1.memberWraps[0], 'epoch1 member wrap');

      const createResult = await createOrGetConversation(db, owner.id, {
        id: conversationId,
        epochPublicKey: epoch1.epochPublicKey,
        confirmationHash: epoch1.confirmationHash,
        memberWrap: memberWrap.wrap,
        userPublicKey: ownerAccount.publicKey,
      });
      if (!createResult) throw new Error('Failed to create conversation');

      // Perform REAL rotation to epoch 2 (simulates "add member without history")
      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [ownerAccount.publicKey]);
      const encryptedTitle = new Uint8Array([1, 2, 3]);

      await submitRotation(db, {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: epoch2.epochPublicKey,
        confirmationHash: epoch2.confirmationHash,
        chainLink: epoch2.chainLink,
        memberWraps: [
          {
            memberPublicKey: ownerAccount.publicKey,
            wrap: defined(epoch2.memberWraps[0], 'epoch2 member wrap').wrap,
          },
        ],
        encryptedTitle,
      });

      // Fetch key chain as the owner would after page refresh
      const keyChain = await getKeyChain(db, conversationId, ownerAccount.publicKey);
      expect(keyChain).not.toBeNull();
      const kc = defined(keyChain, 'key chain');

      // Only epoch 2 wrap should exist (epoch 1 wraps deleted during rotation)
      expect(kc.wraps).toHaveLength(1);
      expect(defined(kc.wraps[0]).epochNumber).toBe(2);

      expect(kc.chainLinks).toHaveLength(1);
      const chainLink = defined(kc.chainLinks[0]);
      expect(chainLink.epochNumber).toBe(2);

      // Verify real crypto: unwrap epoch 2 key from wrap
      const epoch2PrivateKey = unwrapEpochKey(ownerAccount.privateKey, defined(kc.wraps[0]).wrap);
      expect(
        verifyEpochKeyConfirmation(epoch2PrivateKey, defined(kc.wraps[0]).confirmationHash)
      ).toBe(true);

      // Verify real crypto: traverse chain link to recover epoch 1 key
      const epoch1PrivateKey = traverseChainLink(epoch2PrivateKey, chainLink.chainLink);
      expect(epoch1PrivateKey).toEqual(epoch1.epochPrivateKey);

      // Verify epoch 1 key confirmation hash (from epoch 1 row, not the chain link)
      const [epoch1Row] = await db
        .select({ confirmationHash: epochs.confirmationHash })
        .from(epochs)
        .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, 1)));
      expect(
        verifyEpochKeyConfirmation(epoch1PrivateKey, defined(epoch1Row).confirmationHash)
      ).toBe(true);
    });

    it('returns key chain that allows multi-rotation chain traversal', async () => {
      const ownerAccount = generateKeyPair();
      const owner = await createTestUser();
      await db
        .update(users)
        .set({ publicKey: ownerAccount.publicKey })
        .where(eq(users.id, owner.id));

      const conversationId = crypto.randomUUID();
      const epoch1 = createFirstEpoch([ownerAccount.publicKey]);
      const memberWrap = defined(epoch1.memberWraps[0], 'epoch1 member wrap');

      const createResult = await createOrGetConversation(db, owner.id, {
        id: conversationId,
        epochPublicKey: epoch1.epochPublicKey,
        confirmationHash: epoch1.confirmationHash,
        memberWrap: memberWrap.wrap,
        userPublicKey: ownerAccount.publicKey,
      });
      if (!createResult) throw new Error('Failed to create conversation');

      // Rotate twice: epoch 1 → 2 → 3
      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [ownerAccount.publicKey]);
      await submitRotation(db, {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: epoch2.epochPublicKey,
        confirmationHash: epoch2.confirmationHash,
        chainLink: epoch2.chainLink,
        memberWraps: [
          {
            memberPublicKey: ownerAccount.publicKey,
            wrap: defined(epoch2.memberWraps[0]).wrap,
          },
        ],
        encryptedTitle: new Uint8Array([1, 2, 3]),
      });

      const epoch3 = performEpochRotation(epoch2.epochPrivateKey, [ownerAccount.publicKey]);
      await submitRotation(db, {
        conversationId,
        expectedEpoch: 2,
        epochPublicKey: epoch3.epochPublicKey,
        confirmationHash: epoch3.confirmationHash,
        chainLink: epoch3.chainLink,
        memberWraps: [
          {
            memberPublicKey: ownerAccount.publicKey,
            wrap: defined(epoch3.memberWraps[0]).wrap,
          },
        ],
        encryptedTitle: new Uint8Array([4, 5, 6]),
      });

      const keyChain = await getKeyChain(db, conversationId, ownerAccount.publicKey);
      const kc = defined(keyChain, 'key chain');

      expect(kc.wraps).toHaveLength(1);
      expect(defined(kc.wraps[0]).epochNumber).toBe(3);

      expect(kc.chainLinks).toHaveLength(2);

      // Unwrap epoch 3 → traverse to 2 → traverse to 1
      const epoch3PrivateKey = unwrapEpochKey(ownerAccount.privateKey, defined(kc.wraps[0]).wrap);
      expect(epoch3PrivateKey).toEqual(epoch3.epochPrivateKey);

      const cl3 = defined(kc.chainLinks.find((cl) => cl.epochNumber === 3));
      const epoch2PrivateKey = traverseChainLink(epoch3PrivateKey, cl3.chainLink);
      expect(epoch2PrivateKey).toEqual(epoch2.epochPrivateKey);

      const cl2 = defined(kc.chainLinks.find((cl) => cl.epochNumber === 2));
      const epoch1PrivateKey = traverseChainLink(epoch2PrivateKey, cl2.chainLink);
      expect(epoch1PrivateKey).toEqual(epoch1.epochPrivateKey);
    });
  });

  describe('toRotationParams', () => {
    it('converts base64 strings to Uint8Arrays', () => {
      const result = toRotationParams('conv-1', {
        expectedEpoch: 3,
        epochPublicKey: 'AQID',
        confirmationHash: 'BAUG',
        chainLink: 'BwgJ',
        memberWraps: [
          {
            memberPublicKey: 'CgsM',
            wrap: 'DQ4P',
          },
        ],
        encryptedTitle: 'EBAS',
      });

      expect(result.conversationId).toBe('conv-1');
      expect(result.expectedEpoch).toBe(3);
      expect(result.epochPublicKey).toBeInstanceOf(Uint8Array);
      expect(result.confirmationHash).toBeInstanceOf(Uint8Array);
      expect(result.chainLink).toBeInstanceOf(Uint8Array);
      expect(result.encryptedTitle).toBeInstanceOf(Uint8Array);
      expect(result.memberWraps).toHaveLength(1);
      expect(result.memberWraps[0]!.memberPublicKey).toBeInstanceOf(Uint8Array);
      expect(result.memberWraps[0]!.wrap).toBeInstanceOf(Uint8Array);
    });
  });
});
