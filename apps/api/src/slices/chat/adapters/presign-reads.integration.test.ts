import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversations,
  createDb,
  epochs,
  messages,
  users,
} from '@hushbox/db';
import { findContentItemForPresign } from './presign-reads.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for chat presign read tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([9, 9, 9]);

const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

async function seedConversation(): Promise<{ userId: string; conversationId: string }> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userRows = await db
    .insert(users)
    .values({
      email: `${username}@chat-presign.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: crypto.getRandomValues(new Uint8Array(32)),
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
  await db.insert(epochs).values({
    conversationId,
    epochNumber: 0,
    epochPublicKey: crypto.getRandomValues(new Uint8Array(32)),
    confirmationHash: BYTES,
  });
  return { userId, conversationId };
}

async function seedMessage(conversationId: string): Promise<string> {
  const messageRows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'assistant',
      wrappedContentKey: BYTES,
      epochNumber: 0,
      sequenceNumber: 1,
    })
    .returning({ id: messages.id });
  const messageId = messageRows[0]?.id;
  if (messageId === undefined) throw new Error('message seed failed');
  return messageId;
}

async function seedContentItem(
  messageId: string,
  overrides: { contentType?: 'text' | 'image'; storageKey?: string | null } = {}
): Promise<string> {
  const isText = overrides.contentType === 'text';
  const rows = await db
    .insert(contentItems)
    .values({
      messageId,
      contentType: overrides.contentType ?? 'image',
      position: 0,
      storageKey: isText
        ? null
        : (overrides.storageKey ?? `media/${crypto.randomUUID()}/x/${crypto.randomUUID()}`),
      encryptedBlob: isText ? BYTES : null,
      mimeType: isText ? null : 'image/png',
      sizeBytes: isText ? null : 3,
    })
    .returning({ id: contentItems.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('content item seed failed');
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

describe('findContentItemForPresign', () => {
  it('resolves a media content item to its conversation, epoch number, and storage key', async () => {
    const { conversationId } = await seedConversation();
    const messageId = await seedMessage(conversationId);
    const storageKey = `media/${conversationId}/m/${crypto.randomUUID()}`;
    const contentItemId = await seedContentItem(messageId, { contentType: 'image', storageKey });

    const result = await findContentItemForPresign(db, contentItemId);

    expect(result._unsafeUnwrap()).toEqual({
      contentItemId,
      conversationId,
      epochNumber: 0,
      contentType: 'image',
      storageKey,
    });
  });

  it('returns null for a content item that does not exist', async () => {
    const result = await findContentItemForPresign(db, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('maps a store query failure to an unavailable error', async () => {
    const result = await findContentItemForPresign(db, 'not-a-uuid');
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('carries a null storage key and text type through for a non-media item', async () => {
    const { conversationId } = await seedConversation();
    const messageId = await seedMessage(conversationId);
    const contentItemId = await seedContentItem(messageId, {
      contentType: 'text',
      storageKey: null,
    });

    const result = await findContentItemForPresign(db, contentItemId);

    expect(result._unsafeUnwrap()).toEqual({
      contentItemId,
      conversationId,
      epochNumber: 0,
      contentType: 'text',
      storageKey: null,
    });
  });
});
