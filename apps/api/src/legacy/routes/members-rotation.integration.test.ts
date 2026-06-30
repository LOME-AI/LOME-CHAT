import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, and, isNull } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  conversations,
  epochs,
  epochMembers,
  conversationMembers,
  sharedLinks,
  messages,
  contentItems,
  type Database,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import {
  generateKeyPair,
  createFirstEpoch,
  performEpochRotation,
  encryptTextForEpoch,
  unwrapEpochKey,
  traverseChainLink,
  decryptTextFromEpoch,
  beginMessageEnvelope,
  openMessageEnvelope,
  encryptTextWithContentKey,
  decryptTextWithContentKey,
  type WrappedContentKey,
} from '@hushbox/crypto';
import {
  createOrGetConversation,
  getConversationForMember,
} from '../services/conversations/index.js';
import { getKeyChain, submitRotation, StaleEpochError } from '../services/keys/keys.js';
import { createLink, revokeLink } from '../services/links/links.js';

function defined<T>(value: T | undefined | null, label = 'value'): T {
  if (value == null) throw new Error(`Expected ${label} to be defined`);
  return value;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (const [index, value] of a.entries()) {
    if (value !== b[index]) return false;
  }
  return true;
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

describe('member rotation integration', () => {
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

  async function createTestUser(): Promise<
    typeof users.$inferSelect & {
      accountKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
    }
  > {
    const accountKeyPair = generateKeyPair();
    const userData = userFactory.build({ publicKey: accountKeyPair.publicKey });
    const [user] = await db.insert(users).values(userData).returning();
    if (!user) throw new Error('Failed to create test user');
    createdUserIds.push(user.id);
    return { ...user, accountKeyPair };
  }

  async function createConversationWithEpoch(
    userId: string,
    userPublicKey: Uint8Array
  ): Promise<{
    conversationId: string;
    epochResult: ReturnType<typeof createFirstEpoch>;
  }> {
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

    return { conversationId, epochResult };
  }

  async function getEpochId(conversationId: string, epochNumber: number): Promise<string> {
    const [epoch] = await db
      .select({ id: epochs.id })
      .from(epochs)
      .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
    return defined(epoch, `epoch ${String(epochNumber)}`).id;
  }

  it('add-without-history triggers rotation', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    const epoch1PrivateKey = epoch1Result.epochPrivateKey; // gitleaks:allow
    const rotation = performEpochRotation(epoch1PrivateKey, [owner.publicKey, memberB.publicKey]);

    const ownerWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, owner.publicKey))
    );
    const memberBWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, memberB.publicKey))
    );

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 2,
      acceptedAt: new Date(),
    });

    const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, 'Test Title');

    const result = await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
        {
          memberPublicKey: memberB.publicKey,
          wrap: memberBWrap.wrap,
        },
      ],
      encryptedTitle,
    });

    expect(result.newEpochNumber).toBe(2);

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(defined(conv).currentEpoch).toBe(2);

    const [memberRow] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id)
        )
      );
    expect(defined(memberRow).visibleFromEpoch).toBe(2);

    const epoch2Id = await getEpochId(conversationId, 2);
    const newWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id));
    expect(newWraps).toHaveLength(2);

    const epoch1Id = await getEpochId(conversationId, 1);
    const oldWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch1Id));
    expect(oldWraps).toHaveLength(0);

    expect(defined(conv).title).toEqual(encryptedTitle);
  });

  it('remove member triggers rotation', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    const epoch1Id = await getEpochId(conversationId, 1);
    const memberBWrap1 = createFirstEpoch([memberB.publicKey]).memberWraps[0];
    await db.insert(epochMembers).values({
      epochId: epoch1Id,
      memberPublicKey: memberB.publicKey,
      wrap: defined(memberBWrap1).wrap,
      visibleFromEpoch: 1,
    });

    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const ownerWrap = defined(rotation.memberWraps[0]);

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id),
          isNull(conversationMembers.leftAt)
        )
      );

    const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, 'Title');

    const result = await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
      ],
      encryptedTitle,
    });

    expect(result.newEpochNumber).toBe(2);

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(defined(conv).currentEpoch).toBe(2);

    const [leftMember] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id)
        )
      );
    expect(defined(leftMember).leftAt).not.toBeNull();

    const epoch2Id = await getEpochId(conversationId, 2);
    const newWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id));
    expect(newWraps).toHaveLength(1);
    expect(defined(newWraps[0]).memberPublicKey).toEqual(owner.publicKey);
  });

  it('non-owner leave triggers rotation', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    const epoch1Id = await getEpochId(conversationId, 1);
    const memberBWrap1 = createFirstEpoch([memberB.publicKey]).memberWraps[0];
    await db.insert(epochMembers).values({
      epochId: epoch1Id,
      memberPublicKey: memberB.publicKey,
      wrap: defined(memberBWrap1).wrap,
      visibleFromEpoch: 1,
    });

    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const ownerWrap = defined(rotation.memberWraps[0]);

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id),
          isNull(conversationMembers.leftAt)
        )
      );

    const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, 'Title');

    const result = await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
      ],
      encryptedTitle,
    });

    expect(result.newEpochNumber).toBe(2);

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(defined(conv).currentEpoch).toBe(2);

    const [leftMember] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id)
        )
      );
    expect(defined(leftMember).leftAt).not.toBeNull();

    const epoch2Id = await getEpochId(conversationId, 2);
    const newWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id));
    expect(newWraps).toHaveLength(1);
    expect(defined(newWraps[0]).memberPublicKey).toEqual(owner.publicKey);
  });

  it('owner leave deletes conversation (no rotation)', async () => {
    const owner = await createTestUser();
    const { conversationId } = await createConversationWithEpoch(owner.id, owner.publicKey);

    await db.delete(conversations).where(eq(conversations.id, conversationId));

    const rows = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(rows).toHaveLength(0);

    const epochRows = await db
      .select()
      .from(epochs)
      .where(eq(epochs.conversationId, conversationId));
    expect(epochRows).toHaveLength(0);
  });

  it('new member with history sees all messages, without history sees only new epoch', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const memberC = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    const env1a = beginMessageEnvelope(epoch1Result.epochPublicKey);
    const blob1a = encryptTextWithContentKey(env1a.contentKey, 'epoch 1 message');
    const msg1aId = crypto.randomUUID();
    await db.insert(messages).values({
      id: msg1aId,
      conversationId,
      wrappedContentKey: env1a.wrappedContentKey,
      senderType: 'user',
      senderId: owner.id,
      epochNumber: 1,
      sequenceNumber: 1,
    });
    await db.insert(contentItems).values({
      messageId: msg1aId,
      contentType: 'text',
      position: 0,
      encryptedBlob: blob1a,
      isSmartModel: false,
    });

    const rotation12 = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const ownerWrap2 = defined(rotation12.memberWraps[0]);
    const encryptedTitle2 = encryptTextForEpoch(rotation12.epochPublicKey, 'Title');

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation12.epochPublicKey,
      confirmationHash: rotation12.confirmationHash,
      chainLink: rotation12.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap2.wrap,
        },
      ],
      encryptedTitle: encryptedTitle2,
    });

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 2,
      acceptedAt: new Date(),
    });

    const epoch2Id = await getEpochId(conversationId, 2);
    const memberBEpochData = createFirstEpoch([memberB.publicKey]);
    await db.insert(epochMembers).values({
      epochId: epoch2Id,
      memberPublicKey: memberB.publicKey,
      wrap: defined(memberBEpochData.memberWraps[0]).wrap,
      visibleFromEpoch: 2,
    });

    const env2a = beginMessageEnvelope(rotation12.epochPublicKey);
    const blob2a = encryptTextWithContentKey(env2a.contentKey, 'epoch 2 message');
    const msg2aId = crypto.randomUUID();
    await db.insert(messages).values({
      id: msg2aId,
      conversationId,
      wrappedContentKey: env2a.wrappedContentKey,
      senderType: 'user',
      senderId: owner.id,
      epochNumber: 2,
      sequenceNumber: 2,
    });
    await db.insert(contentItems).values({
      messageId: msg2aId,
      contentType: 'text',
      position: 0,
      encryptedBlob: blob2a,
      isSmartModel: false,
    });

    const memberBKeyChain = await getKeyChain(db, conversationId, memberB.publicKey);
    expect(defined(memberBKeyChain).wraps).toHaveLength(1);
    expect(defined(defined(memberBKeyChain).wraps[0]).epochNumber).toBe(2);

    const memberBConversation = await getConversationForMember(db, conversationId, 2, memberB.id);
    expect(defined(memberBConversation).messages).toHaveLength(1);
    expect(defined(defined(memberBConversation).messages[0]).epochNumber).toBe(2);

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberC.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    const memberCEpochData = createFirstEpoch([memberC.publicKey]);
    await db.insert(epochMembers).values({
      epochId: epoch2Id,
      memberPublicKey: memberC.publicKey,
      wrap: defined(memberCEpochData.memberWraps[0]).wrap,
      visibleFromEpoch: 1,
    });

    const memberCKeyChain = await getKeyChain(db, conversationId, memberC.publicKey);
    const kcC = defined(memberCKeyChain);
    expect(kcC.wraps).toHaveLength(1);
    expect(kcC.chainLinks).toHaveLength(1);
    expect(defined(kcC.chainLinks[0]).epochNumber).toBe(2);

    const epoch2PrivateKey = unwrapEpochKey(owner.accountKeyPair.privateKey, ownerWrap2.wrap);
    const epoch1PrivateKey = traverseChainLink(
      epoch2PrivateKey,
      defined(kcC.chainLinks[0]).chainLink
    );

    const msgRow1 = defined(
      defined(await getConversationForMember(db, conversationId, 1, memberC.id)).messages[0]
    );
    const ck1 = openMessageEnvelope(
      epoch1PrivateKey,
      msgRow1.wrappedContentKey as WrappedContentKey
    );
    const msg1 = decryptTextWithContentKey(ck1, defined(msgRow1.contentItems[0]).encryptedBlob!);
    expect(msg1).toBe('epoch 1 message');
  });

  it('concurrent rotation: first-write-wins', async () => {
    const owner = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    const rotationA = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const rotationB = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);

    const encryptedTitleA = encryptTextForEpoch(rotationA.epochPublicKey, 'Title A');
    const encryptedTitleB = encryptTextForEpoch(rotationB.epochPublicKey, 'Title B');

    const results = await Promise.allSettled([
      submitRotation(db, {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: rotationA.epochPublicKey,
        confirmationHash: rotationA.confirmationHash,
        chainLink: rotationA.chainLink,
        memberWraps: [
          {
            memberPublicKey: owner.publicKey,
            wrap: defined(rotationA.memberWraps[0]).wrap,
          },
        ],
        encryptedTitle: encryptedTitleA,
      }),
      submitRotation(db, {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: rotationB.epochPublicKey,
        confirmationHash: rotationB.confirmationHash,
        chainLink: rotationB.chainLink,
        memberWraps: [
          {
            memberPublicKey: owner.publicKey,
            wrap: defined(rotationB.memberWraps[0]).wrap,
          },
        ],
        encryptedTitle: encryptedTitleB,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(StaleEpochError);

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(defined(conv).currentEpoch).toBe(2);
  });

  it('link revocation triggers rotation', async () => {
    const owner = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    const linkKeyPair = generateKeyPair();
    const epoch1Id = await getEpochId(conversationId, 1);
    const linkWrapData = createFirstEpoch([linkKeyPair.publicKey]);
    const linkWrap = defined(linkWrapData.memberWraps[0]);

    const { linkId } = await createLink(db, {
      conversationId,
      linkPublicKey: linkKeyPair.publicKey,
      memberWrap: linkWrap.wrap,
      privilege: 'read',
      visibleFromEpoch: 1,
      currentEpochId: epoch1Id,
    });

    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const ownerWrap = defined(rotation.memberWraps[0]);
    const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, 'Title');

    const revokeResult = await revokeLink(db, linkId, conversationId, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
      ],
      encryptedTitle,
    });

    expect(revokeResult.revoked).toBe(true);
    expect(revokeResult.memberId).not.toBeNull();

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(defined(conv).currentEpoch).toBe(2);

    const [link] = await db.select().from(sharedLinks).where(eq(sharedLinks.id, linkId));
    expect(defined(link).revokedAt).not.toBeNull();

    const [linkMember] = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.linkId, linkId));
    expect(defined(linkMember).leftAt).not.toBeNull();

    const epoch2Id = await getEpochId(conversationId, 2);
    const newWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id));
    expect(newWraps).toHaveLength(1);
    expect(defined(newWraps[0]).memberPublicKey).toEqual(owner.publicKey);
  });

  it('rotation with mixed user + link members preserves both', async () => {
    const owner = await createTestUser();
    const userB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    await db.insert(conversationMembers).values({
      conversationId,
      userId: userB.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });
    const epoch1Id = await getEpochId(conversationId, 1);
    const userBWrapData = createFirstEpoch([userB.publicKey]);
    await db.insert(epochMembers).values({
      epochId: epoch1Id,
      memberPublicKey: userB.publicKey,
      wrap: defined(userBWrapData.memberWraps[0]).wrap,
      visibleFromEpoch: 1,
    });

    const linkKeyPair = generateKeyPair();
    const linkWrapData = createFirstEpoch([linkKeyPair.publicKey]);
    const linkWrap = defined(linkWrapData.memberWraps[0]);

    await createLink(db, {
      conversationId,
      linkPublicKey: linkKeyPair.publicKey,
      memberWrap: linkWrap.wrap,
      privilege: 'read',
      visibleFromEpoch: 1,
      currentEpochId: epoch1Id,
    });

    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [
      owner.publicKey,
      linkKeyPair.publicKey,
    ]);
    const ownerWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, owner.publicKey))
    );
    const linkMemberWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, linkKeyPair.publicKey))
    );

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userB.id),
          isNull(conversationMembers.leftAt)
        )
      );

    const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, 'Title');

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
        {
          memberPublicKey: linkKeyPair.publicKey,
          wrap: linkMemberWrap.wrap,
        },
      ],
      encryptedTitle,
    });

    const epoch2Id = await getEpochId(conversationId, 2);
    const newWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id));
    expect(newWraps).toHaveLength(2);

    const publicKeys = newWraps.map((w) => w.memberPublicKey);
    expect(publicKeys.some((k) => bytesEqual(k, owner.publicKey))).toBe(true);
    expect(publicKeys.some((k) => bytesEqual(k, linkKeyPair.publicKey))).toBe(true);
    expect(publicKeys.some((k) => bytesEqual(k, userB.publicKey))).toBe(false);
  });

  it('three sequential rotations with chain link traversal', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const memberC = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    const envE1 = beginMessageEnvelope(epoch1Result.epochPublicKey);
    const blobE1 = encryptTextWithContentKey(envE1.contentKey, 'msg epoch 1');
    const msgE1Id = crypto.randomUUID();
    await db.insert(messages).values({
      id: msgE1Id,
      conversationId,
      wrappedContentKey: envE1.wrappedContentKey,
      senderType: 'user',
      senderId: owner.id,
      epochNumber: 1,
      sequenceNumber: 1,
    });
    await db.insert(contentItems).values({
      messageId: msgE1Id,
      contentType: 'text',
      position: 0,
      encryptedBlob: blobE1,
      isSmartModel: false,
    });

    const rotation12 = performEpochRotation(epoch1Result.epochPrivateKey, [
      owner.publicKey,
      memberB.publicKey,
    ]);
    const ownerWrap2 = defined(
      rotation12.memberWraps.find((w) => bytesEqual(w.memberPublicKey, owner.publicKey))
    );
    const memberBWrap2 = defined(
      rotation12.memberWraps.find((w) => bytesEqual(w.memberPublicKey, memberB.publicKey))
    );

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 2,
      acceptedAt: new Date(),
    });

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation12.epochPublicKey,
      confirmationHash: rotation12.confirmationHash,
      chainLink: rotation12.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap2.wrap,
        },
        {
          memberPublicKey: memberB.publicKey,
          wrap: memberBWrap2.wrap,
        },
      ],
      encryptedTitle: encryptTextForEpoch(rotation12.epochPublicKey, 'Title 2'),
    });

    const envE2 = beginMessageEnvelope(rotation12.epochPublicKey);
    const blobE2 = encryptTextWithContentKey(envE2.contentKey, 'msg epoch 2');
    const msgE2Id = crypto.randomUUID();
    await db.insert(messages).values({
      id: msgE2Id,
      conversationId,
      wrappedContentKey: envE2.wrappedContentKey,
      senderType: 'user',
      senderId: owner.id,
      epochNumber: 2,
      sequenceNumber: 2,
    });
    await db.insert(contentItems).values({
      messageId: msgE2Id,
      contentType: 'text',
      position: 0,
      encryptedBlob: blobE2,
      isSmartModel: false,
    });

    const rotation23 = performEpochRotation(rotation12.epochPrivateKey, [owner.publicKey]);
    const ownerWrap3 = defined(rotation23.memberWraps[0]);

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id),
          isNull(conversationMembers.leftAt)
        )
      );

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 2,
      epochPublicKey: rotation23.epochPublicKey,
      confirmationHash: rotation23.confirmationHash,
      chainLink: rotation23.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap3.wrap,
        },
      ],
      encryptedTitle: encryptTextForEpoch(rotation23.epochPublicKey, 'Title 3'),
    });

    const envE3 = beginMessageEnvelope(rotation23.epochPublicKey);
    const blobE3 = encryptTextWithContentKey(envE3.contentKey, 'msg epoch 3');
    const msgE3Id = crypto.randomUUID();
    await db.insert(messages).values({
      id: msgE3Id,
      conversationId,
      wrappedContentKey: envE3.wrappedContentKey,
      senderType: 'user',
      senderId: owner.id,
      epochNumber: 3,
      sequenceNumber: 3,
    });
    await db.insert(contentItems).values({
      messageId: msgE3Id,
      contentType: 'text',
      position: 0,
      encryptedBlob: blobE3,
      isSmartModel: false,
    });

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberC.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    const epoch3Id = await getEpochId(conversationId, 3);
    const memberCWrapData = createFirstEpoch([memberC.publicKey]);
    await db.insert(epochMembers).values({
      epochId: epoch3Id,
      memberPublicKey: memberC.publicKey,
      wrap: defined(memberCWrapData.memberWraps[0]).wrap,
      visibleFromEpoch: 1,
    });

    const memberCKeyChain = await getKeyChain(db, conversationId, memberC.publicKey);
    const kc = defined(memberCKeyChain);
    expect(kc.wraps).toHaveLength(1);
    expect(defined(kc.wraps[0]).epochNumber).toBe(3);
    expect(kc.chainLinks).toHaveLength(2);

    const epoch3PrivateKey = unwrapEpochKey(owner.accountKeyPair.privateKey, ownerWrap3.wrap);

    const chainLink3 = defined(kc.chainLinks.find((cl) => cl.epochNumber === 3));
    const epoch2PrivateKey = traverseChainLink(epoch3PrivateKey, chainLink3.chainLink);

    const chainLink2 = defined(kc.chainLinks.find((cl) => cl.epochNumber === 2));
    const epoch1PrivateKey = traverseChainLink(epoch2PrivateKey, chainLink2.chainLink);

    const memberCConversation = await getConversationForMember(db, conversationId, 1, memberC.id);
    const msgs = defined(memberCConversation).messages;
    expect(msgs).toHaveLength(3);

    const ckE1 = openMessageEnvelope(
      epoch1PrivateKey,
      defined(msgs[0]).wrappedContentKey as WrappedContentKey
    );
    expect(
      decryptTextWithContentKey(ckE1, defined(defined(msgs[0]).contentItems[0]).encryptedBlob!)
    ).toBe('msg epoch 1');
    const ckE2 = openMessageEnvelope(
      epoch2PrivateKey,
      defined(msgs[1]).wrappedContentKey as WrappedContentKey
    );
    expect(
      decryptTextWithContentKey(ckE2, defined(defined(msgs[1]).contentItems[0]).encryptedBlob!)
    ).toBe('msg epoch 2');
    const ckE3 = openMessageEnvelope(
      epoch3PrivateKey,
      defined(msgs[2]).wrappedContentKey as WrappedContentKey
    );
    expect(
      decryptTextWithContentKey(ckE3, defined(defined(msgs[2]).contentItems[0]).encryptedBlob!)
    ).toBe('msg epoch 3');
  });

  it('idempotent retry of add-without-history', async () => {
    const owner = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const ownerWrap = defined(rotation.memberWraps[0]);
    const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, 'Title');

    const result = await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
      ],
      encryptedTitle,
    });
    expect(result.newEpochNumber).toBe(2);

    await expect(
      submitRotation(db, {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: rotation.epochPublicKey,
        confirmationHash: rotation.confirmationHash,
        chainLink: rotation.chainLink,
        memberWraps: [
          {
            memberPublicKey: owner.publicKey,
            wrap: ownerWrap.wrap,
          },
        ],
        encryptedTitle,
      })
    ).rejects.toThrow(StaleEpochError);

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(defined(conv).currentEpoch).toBe(2);
  });

  // Test 11: "server overrides client visibleFromEpoch" — covered by
  // keys.test.ts "overrides client visibleFromEpoch with authoritative value from conversationMembers"

  it('new member can decrypt re-encrypted title', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [
      owner.publicKey,
      memberB.publicKey,
    ]);
    const ownerWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, owner.publicKey))
    );
    const memberBWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, memberB.publicKey))
    );

    const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, 'My Title');

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 2,
      acceptedAt: new Date(),
    });

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap.wrap,
        },
        {
          memberPublicKey: memberB.publicKey,
          wrap: memberBWrap.wrap,
        },
      ],
      encryptedTitle,
    });

    const epoch2PrivateKey = unwrapEpochKey(memberB.accountKeyPair.privateKey, memberBWrap.wrap);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    const title = decryptTextFromEpoch(epoch2PrivateKey, defined(conv).title);
    expect(title).toBe('My Title');
  });

  it('remove + re-add same user', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    const epoch1Id = await getEpochId(conversationId, 1);
    const memberBEpoch1Wrap = createFirstEpoch([memberB.publicKey]).memberWraps[0];
    await db.insert(epochMembers).values({
      epochId: epoch1Id,
      memberPublicKey: memberB.publicKey,
      wrap: defined(memberBEpoch1Wrap).wrap,
      visibleFromEpoch: 1,
    });

    const envBR = beginMessageEnvelope(epoch1Result.epochPublicKey);
    const blobBR = encryptTextWithContentKey(envBR.contentKey, 'before removal');
    const msgBRId = crypto.randomUUID();
    await db.insert(messages).values({
      id: msgBRId,
      conversationId,
      wrappedContentKey: envBR.wrappedContentKey,
      senderType: 'user',
      senderId: owner.id,
      epochNumber: 1,
      sequenceNumber: 1,
    });
    await db.insert(contentItems).values({
      messageId: msgBRId,
      contentType: 'text',
      position: 0,
      encryptedBlob: blobBR,
      isSmartModel: false,
    });

    const rotation12 = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const ownerWrap2 = defined(rotation12.memberWraps[0]);

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id),
          isNull(conversationMembers.leftAt)
        )
      );

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation12.epochPublicKey,
      confirmationHash: rotation12.confirmationHash,
      chainLink: rotation12.chainLink,
      memberWraps: [
        {
          memberPublicKey: owner.publicKey,
          wrap: ownerWrap2.wrap,
        },
      ],
      encryptedTitle: encryptTextForEpoch(rotation12.epochPublicKey, 'Title'),
    });

    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    const epoch2Id = await getEpochId(conversationId, 2);
    const memberBEpoch2Wrap = createFirstEpoch([memberB.publicKey]).memberWraps[0];
    await db.insert(epochMembers).values({
      epochId: epoch2Id,
      memberPublicKey: memberB.publicKey,
      wrap: defined(memberBEpoch2Wrap).wrap,
      visibleFromEpoch: 1,
    });

    const memberBRows = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, memberB.id)
        )
      );
    expect(memberBRows).toHaveLength(2);
    expect(memberBRows.filter((r) => r.leftAt !== null)).toHaveLength(1);
    expect(memberBRows.filter((r) => r.leftAt === null)).toHaveLength(1);

    const memberBKeyChain = await getKeyChain(db, conversationId, memberB.publicKey);
    const kc = defined(memberBKeyChain);
    expect(kc.wraps).toHaveLength(1);
    expect(defined(kc.wraps[0]).epochNumber).toBe(2);
    expect(kc.chainLinks).toHaveLength(1);
    expect(defined(kc.chainLinks[0]).epochNumber).toBe(2);

    const epoch2PrivateKey = unwrapEpochKey(owner.accountKeyPair.privateKey, ownerWrap2.wrap);
    const epoch1PrivateKey = traverseChainLink(
      epoch2PrivateKey,
      defined(kc.chainLinks[0]).chainLink
    );

    const memberBConversation = await getConversationForMember(db, conversationId, 1, memberB.id);
    const msgs = defined(memberBConversation).messages;
    expect(msgs).toHaveLength(1);
    const ckBR = openMessageEnvelope(
      epoch1PrivateKey,
      defined(msgs[0]).wrappedContentKey as WrappedContentKey
    );
    expect(
      decryptTextWithContentKey(ckBR, defined(defined(msgs[0]).contentItems[0]).encryptedBlob!)
    ).toBe('before removal');
  });

  it('no-history link guest creation succeeds with rotation (no WRAP_SET_MISMATCH)', async () => {
    const owner = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    const linkKeyPair = generateKeyPair();
    const epoch1Id = await getEpochId(conversationId, 1);

    // Perform rotation including both owner and new link guest
    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [
      owner.publicKey,
      linkKeyPair.publicKey,
    ]);
    const ownerWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, owner.publicKey))
    );
    const linkWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, linkKeyPair.publicKey))
    );
    const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, 'Title');

    // createLink with rotation — should NOT throw WrapSetMismatchError
    const result = await createLink(db, {
      conversationId,
      linkPublicKey: linkKeyPair.publicKey,
      memberWrap: linkWrap.wrap,
      privilege: 'read',
      visibleFromEpoch: 2,
      currentEpochId: epoch1Id,
      rotation: {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: rotation.epochPublicKey,
        confirmationHash: rotation.confirmationHash,
        chainLink: rotation.chainLink,
        memberWraps: [
          { memberPublicKey: owner.publicKey, wrap: ownerWrap.wrap },
          { memberPublicKey: linkKeyPair.publicKey, wrap: linkWrap.wrap },
        ],
        encryptedTitle,
      },
    });

    expect(result.linkId).toBeDefined();
    expect(result.memberId).toBeDefined();

    // Conversation should be at epoch 2
    const [conv] = await db
      .select({ currentEpoch: conversations.currentEpoch })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(defined(conv).currentEpoch).toBe(2);

    // epochMembers for epoch 2 should have wraps for both owner and link guest
    const epoch2Id = await getEpochId(conversationId, 2);
    const wraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id));
    expect(wraps).toHaveLength(2);
  });

  it('no-history auth user cannot derive previous epoch key via chain links', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    // Insert a message at epoch 1
    const envS1 = beginMessageEnvelope(epoch1Result.epochPublicKey);
    const blobS1 = encryptTextWithContentKey(envS1.contentKey, 'secret epoch 1 message');
    const msgS1Id = crypto.randomUUID();
    await db.insert(messages).values({
      id: msgS1Id,
      conversationId,
      epochNumber: 1,
      wrappedContentKey: envS1.wrappedContentKey,
      senderId: owner.id,
      senderType: 'user',
      sequenceNumber: 1,
    });
    await db.insert(contentItems).values({
      messageId: msgS1Id,
      contentType: 'text',
      position: 0,
      encryptedBlob: blobS1,
      isSmartModel: false,
    });

    // Add member B without history — rotation from epoch 1 → 2
    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 2,
      acceptedAt: new Date(),
    });

    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [
      owner.publicKey,
      memberB.publicKey,
    ]);
    const ownerWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, owner.publicKey))
    );
    const memberBWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, memberB.publicKey))
    );
    const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, 'Title');

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        { memberPublicKey: owner.publicKey, wrap: ownerWrap.wrap },
        { memberPublicKey: memberB.publicKey, wrap: memberBWrap.wrap },
      ],
      encryptedTitle,
    });

    // Key chain for member B: should have wrap for epoch 2, NO chain links
    const kc = defined(await getKeyChain(db, conversationId, memberB.publicKey));
    expect(kc.wraps).toHaveLength(1);
    expect(defined(kc.wraps[0]).visibleFromEpoch).toBe(2);
    expect(kc.chainLinks).toHaveLength(0);

    // Member B can unwrap epoch 2 key
    const epoch2Key = unwrapEpochKey(memberB.accountKeyPair.privateKey, defined(kc.wraps[0]).wrap);
    expect(epoch2Key).toBeDefined();

    // Member B's messages are filtered to epoch 2+
    const memberBConv = await getConversationForMember(db, conversationId, 2, memberB.id);
    expect(defined(memberBConv).messages).toHaveLength(0);
  });

  it('no-history link guest cannot derive previous epoch key via chain links', async () => {
    const owner = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    // Insert a message at epoch 1
    const epoch1Id = await getEpochId(conversationId, 1);
    const envSL1 = beginMessageEnvelope(epoch1Result.epochPublicKey);
    const blobSL1 = encryptTextWithContentKey(envSL1.contentKey, 'secret epoch 1 message');
    const msgSL1Id = crypto.randomUUID();
    await db.insert(messages).values({
      id: msgSL1Id,
      conversationId,
      epochNumber: 1,
      wrappedContentKey: envSL1.wrappedContentKey,
      senderId: owner.id,
      senderType: 'user',
      sequenceNumber: 1,
    });
    await db.insert(contentItems).values({
      messageId: msgSL1Id,
      contentType: 'text',
      position: 0,
      encryptedBlob: blobSL1,
      isSmartModel: false,
    });

    // Create link guest without history — rotation from epoch 1 → 2
    const linkKeyPair = generateKeyPair();
    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [
      owner.publicKey,
      linkKeyPair.publicKey,
    ]);
    const ownerWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, owner.publicKey))
    );
    const linkWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, linkKeyPair.publicKey))
    );
    const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, 'Title');

    await createLink(db, {
      conversationId,
      linkPublicKey: linkKeyPair.publicKey,
      memberWrap: linkWrap.wrap,
      privilege: 'read',
      visibleFromEpoch: 2,
      currentEpochId: epoch1Id,
      rotation: {
        conversationId,
        expectedEpoch: 1,
        epochPublicKey: rotation.epochPublicKey,
        confirmationHash: rotation.confirmationHash,
        chainLink: rotation.chainLink,
        memberWraps: [
          { memberPublicKey: owner.publicKey, wrap: ownerWrap.wrap },
          { memberPublicKey: linkKeyPair.publicKey, wrap: linkWrap.wrap },
        ],
        encryptedTitle,
      },
    });

    // Key chain for link guest: should have wrap for epoch 2, NO chain links
    const kc = defined(await getKeyChain(db, conversationId, linkKeyPair.publicKey));
    expect(kc.wraps).toHaveLength(1);
    expect(defined(kc.wraps[0]).visibleFromEpoch).toBe(2);
    expect(kc.chainLinks).toHaveLength(0);

    // Link guest can unwrap epoch 2 key
    const epoch2Key = unwrapEpochKey(linkKeyPair.privateKey, defined(kc.wraps[0]).wrap);
    expect(epoch2Key).toBeDefined();
  });

  it('with-history auth user can traverse chain links to epoch 1', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    // Insert message at epoch 1
    const envWH1 = beginMessageEnvelope(epoch1Result.epochPublicKey);
    const blobWH1 = encryptTextWithContentKey(envWH1.contentKey, 'epoch 1 message');
    const msgWH1Id = crypto.randomUUID();
    await db.insert(messages).values({
      id: msgWH1Id,
      conversationId,
      epochNumber: 1,
      wrappedContentKey: envWH1.wrappedContentKey,
      senderId: owner.id,
      senderType: 'user',
      sequenceNumber: 1,
    });
    await db.insert(contentItems).values({
      messageId: msgWH1Id,
      contentType: 'text',
      position: 0,
      encryptedBlob: blobWH1,
      isSmartModel: false,
    });

    // Rotation to epoch 2
    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [
      owner.publicKey,
      memberB.publicKey,
    ]);
    const ownerWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, owner.publicKey))
    );
    const memberBWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, memberB.publicKey))
    );
    const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, 'Title');

    // Add member B with history (visibleFromEpoch = 1)
    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        { memberPublicKey: owner.publicKey, wrap: ownerWrap.wrap },
        { memberPublicKey: memberB.publicKey, wrap: memberBWrap.wrap },
      ],
      encryptedTitle,
    });

    // Key chain: wrap at epoch 2, chain link at epoch 2 connecting to epoch 1
    const kc = defined(await getKeyChain(db, conversationId, memberB.publicKey));
    expect(kc.wraps).toHaveLength(1);
    expect(kc.chainLinks).toHaveLength(1);
    expect(defined(kc.chainLinks[0]).epochNumber).toBe(2);

    // Traverse: unwrap epoch 2 key, use chain link to derive epoch 1 key
    const epoch2Key = unwrapEpochKey(memberB.accountKeyPair.privateKey, defined(kc.wraps[0]).wrap);
    const epoch1Key = traverseChainLink(epoch2Key, defined(kc.chainLinks[0]).chainLink);

    // Decrypt epoch 1 message
    const memberBConv = await getConversationForMember(db, conversationId, 1, memberB.id);
    const msgs = defined(memberBConv).messages;
    expect(msgs).toHaveLength(1);
    const ckWH = openMessageEnvelope(
      epoch1Key,
      defined(msgs[0]).wrappedContentKey as WrappedContentKey
    );
    expect(
      decryptTextWithContentKey(ckWH, defined(defined(msgs[0]).contentItems[0]).encryptedBlob!)
    ).toBe('epoch 1 message');
  });

  it('with-history link guest can traverse chain links to epoch 1', async () => {
    const owner = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    // Insert message at epoch 1
    const epoch1Id = await getEpochId(conversationId, 1);
    const envLG1 = beginMessageEnvelope(epoch1Result.epochPublicKey);
    const blobLG1 = encryptTextWithContentKey(envLG1.contentKey, 'epoch 1 link message');
    const msgLG1Id = crypto.randomUUID();
    await db.insert(messages).values({
      id: msgLG1Id,
      conversationId,
      epochNumber: 1,
      wrappedContentKey: envLG1.wrappedContentKey,
      senderId: owner.id,
      senderType: 'user',
      sequenceNumber: 1,
    });
    await db.insert(contentItems).values({
      messageId: msgLG1Id,
      contentType: 'text',
      position: 0,
      encryptedBlob: blobLG1,
      isSmartModel: false,
    });

    // Create link guest with history (visibleFromEpoch = 1) — no rotation needed
    const linkKeyPair = generateKeyPair();
    const epoch1Wrap = createFirstEpoch([linkKeyPair.publicKey]);
    const linkWrap = defined(epoch1Wrap.memberWraps[0]);

    await createLink(db, {
      conversationId,
      linkPublicKey: linkKeyPair.publicKey,
      memberWrap: linkWrap.wrap,
      privilege: 'read',
      visibleFromEpoch: 1,
      currentEpochId: epoch1Id,
    });

    // Now rotate to epoch 2 (owner only + link)
    const rotation = performEpochRotation(epoch1Result.epochPrivateKey, [
      owner.publicKey,
      linkKeyPair.publicKey,
    ]);
    const ownerWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, owner.publicKey))
    );
    const linkRotationWrap = defined(
      rotation.memberWraps.find((w) => bytesEqual(w.memberPublicKey, linkKeyPair.publicKey))
    );
    const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, 'Title');

    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation.epochPublicKey,
      confirmationHash: rotation.confirmationHash,
      chainLink: rotation.chainLink,
      memberWraps: [
        { memberPublicKey: owner.publicKey, wrap: ownerWrap.wrap },
        { memberPublicKey: linkKeyPair.publicKey, wrap: linkRotationWrap.wrap },
      ],
      encryptedTitle,
    });

    // Key chain: wrap at epoch 2, chain link at epoch 2 connecting to epoch 1
    const kc = defined(await getKeyChain(db, conversationId, linkKeyPair.publicKey));
    expect(kc.wraps).toHaveLength(1);
    expect(kc.chainLinks).toHaveLength(1);
    expect(defined(kc.chainLinks[0]).epochNumber).toBe(2);

    // Traverse: unwrap epoch 2 key, use chain link to derive epoch 1 key
    const epoch2Key = unwrapEpochKey(linkKeyPair.privateKey, defined(kc.wraps[0]).wrap);
    const epoch1Key = traverseChainLink(epoch2Key, defined(kc.chainLinks[0]).chainLink);

    // Decrypt epoch 1 message
    const ckLG = openMessageEnvelope(epoch1Key, envLG1.wrappedContentKey);
    expect(decryptTextWithContentKey(ckLG, blobLG1)).toBe('epoch 1 link message');
  });

  it('no-history member with later rotations can access from join epoch but not before', async () => {
    const owner = await createTestUser();
    const memberB = await createTestUser();
    const { conversationId, epochResult: epoch1Result } = await createConversationWithEpoch(
      owner.id,
      owner.publicKey
    );

    // Message at epoch 1
    const envNH1 = beginMessageEnvelope(epoch1Result.epochPublicKey);
    const blobNH1 = encryptTextWithContentKey(envNH1.contentKey, 'epoch 1 secret');
    const msgNH1Id = crypto.randomUUID();
    await db.insert(messages).values({
      id: msgNH1Id,
      conversationId,
      epochNumber: 1,
      wrappedContentKey: envNH1.wrappedContentKey,
      senderId: owner.id,
      senderType: 'user',
      sequenceNumber: 1,
    });
    await db.insert(contentItems).values({
      messageId: msgNH1Id,
      contentType: 'text',
      position: 0,
      encryptedBlob: blobNH1,
      isSmartModel: false,
    });

    // Rotation epoch 1 → 2 (owner only)
    const rotation1to2 = performEpochRotation(epoch1Result.epochPrivateKey, [owner.publicKey]);
    const ownerWrap2 = defined(rotation1to2.memberWraps[0]);
    await submitRotation(db, {
      conversationId,
      expectedEpoch: 1,
      epochPublicKey: rotation1to2.epochPublicKey,
      confirmationHash: rotation1to2.confirmationHash,
      chainLink: rotation1to2.chainLink,
      memberWraps: [{ memberPublicKey: owner.publicKey, wrap: ownerWrap2.wrap }],
      encryptedTitle: encryptTextForEpoch(rotation1to2.epochPublicKey, 'T'),
    });

    // Add member B at epoch 3 (visibleFromEpoch = 3), rotation epoch 2 → 3
    await db.insert(conversationMembers).values({
      conversationId,
      userId: memberB.id,
      privilege: 'write',
      visibleFromEpoch: 3,
      acceptedAt: new Date(),
    });

    const epoch2Key = unwrapEpochKey(owner.accountKeyPair.privateKey, ownerWrap2.wrap);
    const rotation2to3 = performEpochRotation(epoch2Key, [owner.publicKey, memberB.publicKey]);
    const ownerWrap3 = defined(
      rotation2to3.memberWraps.find((w) => bytesEqual(w.memberPublicKey, owner.publicKey))
    );
    const memberBWrap3 = defined(
      rotation2to3.memberWraps.find((w) => bytesEqual(w.memberPublicKey, memberB.publicKey))
    );
    await submitRotation(db, {
      conversationId,
      expectedEpoch: 2,
      epochPublicKey: rotation2to3.epochPublicKey,
      confirmationHash: rotation2to3.confirmationHash,
      chainLink: rotation2to3.chainLink,
      memberWraps: [
        { memberPublicKey: owner.publicKey, wrap: ownerWrap3.wrap },
        { memberPublicKey: memberB.publicKey, wrap: memberBWrap3.wrap },
      ],
      encryptedTitle: encryptTextForEpoch(rotation2to3.epochPublicKey, 'T'),
    });

    // Message at epoch 3
    const envNH3 = beginMessageEnvelope(rotation2to3.epochPublicKey);
    const blobNH3 = encryptTextWithContentKey(envNH3.contentKey, 'epoch 3 visible');
    const msgNH3Id = crypto.randomUUID();
    await db.insert(messages).values({
      id: msgNH3Id,
      conversationId,
      epochNumber: 3,
      wrappedContentKey: envNH3.wrappedContentKey,
      senderId: owner.id,
      senderType: 'user',
      sequenceNumber: 2,
    });
    await db.insert(contentItems).values({
      messageId: msgNH3Id,
      contentType: 'text',
      position: 0,
      encryptedBlob: blobNH3,
      isSmartModel: false,
    });

    // Rotation epoch 3 → 4
    const epoch3Key = unwrapEpochKey(owner.accountKeyPair.privateKey, ownerWrap3.wrap);
    const rotation3to4 = performEpochRotation(epoch3Key, [owner.publicKey, memberB.publicKey]);
    const ownerWrap4 = defined(
      rotation3to4.memberWraps.find((w) => bytesEqual(w.memberPublicKey, owner.publicKey))
    );
    const memberBWrap4 = defined(
      rotation3to4.memberWraps.find((w) => bytesEqual(w.memberPublicKey, memberB.publicKey))
    );
    await submitRotation(db, {
      conversationId,
      expectedEpoch: 3,
      epochPublicKey: rotation3to4.epochPublicKey,
      confirmationHash: rotation3to4.confirmationHash,
      chainLink: rotation3to4.chainLink,
      memberWraps: [
        { memberPublicKey: owner.publicKey, wrap: ownerWrap4.wrap },
        { memberPublicKey: memberB.publicKey, wrap: memberBWrap4.wrap },
      ],
      encryptedTitle: encryptTextForEpoch(rotation3to4.epochPublicKey, 'T'),
    });

    // Rotation epoch 4 → 5
    const epoch4Key = unwrapEpochKey(owner.accountKeyPair.privateKey, ownerWrap4.wrap);
    const rotation4to5 = performEpochRotation(epoch4Key, [owner.publicKey, memberB.publicKey]);
    const ownerWrap5 = defined(
      rotation4to5.memberWraps.find((w) => bytesEqual(w.memberPublicKey, owner.publicKey))
    );
    const memberBWrap5 = defined(
      rotation4to5.memberWraps.find((w) => bytesEqual(w.memberPublicKey, memberB.publicKey))
    );
    await submitRotation(db, {
      conversationId,
      expectedEpoch: 4,
      epochPublicKey: rotation4to5.epochPublicKey,
      confirmationHash: rotation4to5.confirmationHash,
      chainLink: rotation4to5.chainLink,
      memberWraps: [
        { memberPublicKey: owner.publicKey, wrap: ownerWrap5.wrap },
        { memberPublicKey: memberB.publicKey, wrap: memberBWrap5.wrap },
      ],
      encryptedTitle: encryptTextForEpoch(rotation4to5.epochPublicKey, 'T'),
    });

    // Key chain for member B (visibleFromEpoch = 3):
    // wraps: 1 (epoch 5), chainLinks: 2 (epochs 4 and 5, NOT epoch 3)
    const kc = defined(await getKeyChain(db, conversationId, memberB.publicKey));
    expect(kc.wraps).toHaveLength(1);
    expect(kc.chainLinks).toHaveLength(2);
    const chainEpochs = kc.chainLinks.map((cl) => cl.epochNumber);
    expect(chainEpochs).toContain(4);
    expect(chainEpochs).toContain(5);
    expect(chainEpochs).not.toContain(3);

    // Traversal: epoch 5 → 4 → 3
    const epoch5Key = unwrapEpochKey(memberB.accountKeyPair.privateKey, defined(kc.wraps[0]).wrap);
    const cl5 = defined(kc.chainLinks.find((cl) => cl.epochNumber === 5));
    const derivedEpoch4Key = traverseChainLink(epoch5Key, cl5.chainLink);
    const cl4 = defined(kc.chainLinks.find((cl) => cl.epochNumber === 4));
    const derivedEpoch3Key = traverseChainLink(derivedEpoch4Key, cl4.chainLink);

    // Can decrypt epoch 3 message
    const ckNH3 = openMessageEnvelope(derivedEpoch3Key, envNH3.wrappedContentKey);
    expect(decryptTextWithContentKey(ckNH3, blobNH3)).toBe('epoch 3 visible');

    // Messages filtered to epoch 3+
    const memberBConv = await getConversationForMember(db, conversationId, 3, memberB.id);
    expect(defined(memberBConv).messages).toHaveLength(1);
  });
});
