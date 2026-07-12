import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  messages,
  sharedLinks,
  sharedMessages,
  users,
} from '@hushbox/db';
import {
  findMessageShare,
  isActiveConversationMember,
  isEpochMember,
  resolveEpochRowId,
} from './presign-reads.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for conversations presign read tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([5, 5, 5]);

const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

interface Graph {
  readonly userId: string;
  readonly userPublicKey: Uint8Array;
  readonly conversationId: string;
  readonly epochId: string;
}

async function seedGraph(): Promise<Graph> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const userRows = await db
    .insert(users)
    .values({
      email: `${username}@conv-presign.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: userPublicKey,
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
  const epochRows = await db
    .insert(epochs)
    .values({
      conversationId,
      epochNumber: 0,
      epochPublicKey: crypto.getRandomValues(new Uint8Array(32)),
      confirmationHash: BYTES,
    })
    .returning({ id: epochs.id });
  const epochId = epochRows[0]?.id;
  if (epochId === undefined) throw new Error('epoch seed failed');
  return { userId, userPublicKey, conversationId, epochId };
}

async function addUserMember(
  conversationId: string,
  userId: string,
  options: { left?: boolean } = {}
): Promise<void> {
  await db.insert(conversationMembers).values({
    conversationId,
    userId,
    visibleFromEpoch: 0,
    leftAt: options.left === true ? new Date() : null,
  });
}

async function addLink(
  conversationId: string,
  options: { revokedAt?: Date; expiresAt?: Date } = {}
): Promise<{ linkId: string; linkPublicKey: Uint8Array }> {
  const linkPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const rows = await db
    .insert(sharedLinks)
    .values({
      conversationId,
      linkPublicKey,
      revokedAt: options.revokedAt ?? null,
      expiresAt: options.expiresAt ?? null,
    })
    .returning({ id: sharedLinks.id });
  const linkId = rows[0]?.id;
  if (linkId === undefined) throw new Error('shared link seed failed');
  return { linkId, linkPublicKey };
}

async function addLinkMember(
  conversationId: string,
  linkId: string,
  options: { left?: boolean } = {}
): Promise<void> {
  await db.insert(conversationMembers).values({
    conversationId,
    linkId,
    visibleFromEpoch: 0,
    leftAt: options.left === true ? new Date() : null,
  });
}

async function addEpochKey(epochId: string, memberPublicKey: Uint8Array): Promise<void> {
  await db
    .insert(epochMembers)
    .values({ epochId, memberPublicKey, wrap: BYTES, visibleFromEpoch: 0 });
}

async function seedSharedMessage(
  graph: Graph,
  contentItemCount: number
): Promise<{ sharedMessageId: string; contentItemIds: string[] }> {
  const messageRows = await db
    .insert(messages)
    .values({
      conversationId: graph.conversationId,
      senderType: 'assistant',
      wrappedContentKey: BYTES,
      epochNumber: 0,
      sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
    })
    .returning({ id: messages.id });
  const messageId = messageRows[0]?.id;
  if (messageId === undefined) throw new Error('message seed failed');
  const contentItemIds: string[] = [];
  for (let position = 0; position < contentItemCount; position += 1) {
    const itemRows = await db
      .insert(contentItems)
      .values({
        messageId,
        contentType: 'image',
        position,
        storageKey: `media/${graph.conversationId}/m/${crypto.randomUUID()}`,
        mimeType: 'image/png',
        sizeBytes: 3,
      })
      .returning({ id: contentItems.id });
    const itemId = itemRows[0]?.id;
    if (itemId === undefined) throw new Error('content item seed failed');
    contentItemIds.push(itemId);
  }
  const shareRows = await db
    .insert(sharedMessages)
    .values({ messageId, createdBy: graph.userId, wrappedContentKey: BYTES })
    .returning({ id: sharedMessages.id });
  const sharedMessageId = shareRows[0]?.id;
  if (sharedMessageId === undefined) throw new Error('shared message seed failed');
  return { sharedMessageId, contentItemIds };
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

describe('resolveEpochRowId', () => {
  it('resolves an existing epoch number to its row id', async () => {
    const graph = await seedGraph();
    const result = await resolveEpochRowId(db, graph.conversationId, 0);
    expect(result._unsafeUnwrap()).toBe(graph.epochId);
  });

  it('returns null for an epoch number that does not exist', async () => {
    const graph = await seedGraph();
    const result = await resolveEpochRowId(db, graph.conversationId, 99);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('maps a store query failure to an unavailable error', async () => {
    const result = await resolveEpochRowId(db, 'not-a-uuid', 0);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('isActiveConversationMember', () => {
  it('is true for an active user member', async () => {
    const graph = await seedGraph();
    await addUserMember(graph.conversationId, graph.userId);
    const result = await isActiveConversationMember(db, graph.conversationId, {
      kind: 'user',
      userId: graph.userId,
    });
    expect(result._unsafeUnwrap()).toBe(true);
  });

  it('is false for a user with no membership row', async () => {
    const graph = await seedGraph();
    const result = await isActiveConversationMember(db, graph.conversationId, {
      kind: 'user',
      userId: graph.userId,
    });
    expect(result._unsafeUnwrap()).toBe(false);
  });

  it('is false for a user whose membership has been left', async () => {
    const graph = await seedGraph();
    await addUserMember(graph.conversationId, graph.userId, { left: true });
    const result = await isActiveConversationMember(db, graph.conversationId, {
      kind: 'user',
      userId: graph.userId,
    });
    expect(result._unsafeUnwrap()).toBe(false);
  });

  it('is true for an active link-guest member', async () => {
    const graph = await seedGraph();
    const { linkId } = await addLink(graph.conversationId);
    await addLinkMember(graph.conversationId, linkId);
    const result = await isActiveConversationMember(db, graph.conversationId, {
      kind: 'linkGuest',
      linkId,
    });
    expect(result._unsafeUnwrap()).toBe(true);
  });

  it('is false for a link guest whose membership has been left', async () => {
    const graph = await seedGraph();
    const { linkId } = await addLink(graph.conversationId);
    await addLinkMember(graph.conversationId, linkId, { left: true });
    const result = await isActiveConversationMember(db, graph.conversationId, {
      kind: 'linkGuest',
      linkId,
    });
    expect(result._unsafeUnwrap()).toBe(false);
  });
});

describe('isEpochMember', () => {
  it('is true for a user whose public key holds an epoch_members row', async () => {
    const graph = await seedGraph();
    await addEpochKey(graph.epochId, graph.userPublicKey);
    const result = await isEpochMember(db, graph.epochId, { kind: 'user', userId: graph.userId });
    expect(result._unsafeUnwrap()).toBe(true);
  });

  it('is false for a user whose public key holds no epoch_members row', async () => {
    const graph = await seedGraph();
    const result = await isEpochMember(db, graph.epochId, { kind: 'user', userId: graph.userId });
    expect(result._unsafeUnwrap()).toBe(false);
  });

  it('is false for a user id that resolves to no public key', async () => {
    const graph = await seedGraph();
    const result = await isEpochMember(db, graph.epochId, {
      kind: 'user',
      userId: crypto.randomUUID(),
    });
    expect(result._unsafeUnwrap()).toBe(false);
  });

  it('is true for a link guest whose link public key holds an epoch_members row', async () => {
    const graph = await seedGraph();
    const { linkId, linkPublicKey } = await addLink(graph.conversationId);
    await addEpochKey(graph.epochId, linkPublicKey);
    const result = await isEpochMember(db, graph.epochId, { kind: 'linkGuest', linkId });
    expect(result._unsafeUnwrap()).toBe(true);
  });

  it('is false for a link guest whose link public key holds no epoch_members row', async () => {
    const graph = await seedGraph();
    const { linkId } = await addLink(graph.conversationId);
    const result = await isEpochMember(db, graph.epochId, { kind: 'linkGuest', linkId });
    expect(result._unsafeUnwrap()).toBe(false);
  });

  it('is false for a link id that resolves to no public key', async () => {
    const graph = await seedGraph();
    const result = await isEpochMember(db, graph.epochId, {
      kind: 'linkGuest',
      linkId: crypto.randomUUID(),
    });
    expect(result._unsafeUnwrap()).toBe(false);
  });
});

describe('findMessageShare', () => {
  it('returns null revoke/expiry (standalone shares never expire) and the message content items', async () => {
    const graph = await seedGraph();
    const { sharedMessageId, contentItemIds } = await seedSharedMessage(graph, 2);

    const result = await findMessageShare(db, sharedMessageId);
    const share = result._unsafeUnwrap();

    expect(share).not.toBeNull();
    expect(share?.revokedAt).toBeNull();
    expect(share?.expiresAt).toBeNull();
    expect([...(share?.contentItemIds ?? [])].toSorted((a, b) => a.localeCompare(b))).toEqual(
      [...contentItemIds].toSorted((a, b) => a.localeCompare(b))
    );
  });

  it('scopes to exactly its own message content items, never a sibling standalone share', async () => {
    const graph = await seedGraph();
    const shareA = await seedSharedMessage(graph, 1);
    const shareB = await seedSharedMessage(graph, 1);

    // The shared_messages row id is exactly what the public read surfaces and
    // the presign route keys `:shareId` on — resolving it must return only that
    // message's items, so a sibling share's item id is not presignable through it.
    const result = await findMessageShare(db, shareA.sharedMessageId);
    const share = result._unsafeUnwrap();
    expect(share?.contentItemIds).toEqual(shareA.contentItemIds);
    for (const siblingItem of shareB.contentItemIds) {
      expect(share?.contentItemIds).not.toContain(siblingItem);
    }
  });

  it('returns null when the shared message id matches nothing', async () => {
    const result = await findMessageShare(db, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBeNull();
  });
});
