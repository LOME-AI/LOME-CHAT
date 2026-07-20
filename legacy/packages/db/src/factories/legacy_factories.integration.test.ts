import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import {
  beginMessageEnvelope,
  openMessageEnvelope,
  encryptTextWithContentKey,
  decryptTextWithContentKey,
  generateKeyPair,
  type WrappedContentKey,
} from '@hushbox/crypto';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import {
  users,
  conversations,
  messages,
  contentItems,
  usageRecords,
  mediaGenerations,
} from '../schema/index';
import { projects } from '../schema/legacy_projects';
import { userFactory } from './legacy_user';
import { projectFactory } from './legacy_project';
import { conversationFactory } from './legacy_conversation';
import { messageFactory } from './legacy_message';
import {
  contentItemFactory,
  imageContentItemFactory,
  aiTextContentItemFactory,
} from './legacy_content-item';
import { usageRecordFactory } from './legacy_usage-record';
import { mediaGenerationFactory } from './legacy_media-generation';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

function readConstraint(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('constraint' in value)) return undefined;
  const c = (value as { constraint?: unknown }).constraint;
  return typeof c === 'string' ? c : undefined;
}

function readCause(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('cause' in value)) return undefined;
  return (value as { cause?: unknown }).cause;
}

/**
 * Walks `error.cause` chain to find the underlying Postgres error and returns
 * its `constraint` name (or undefined if not a constraint violation).
 */
function findConstraintName(error: unknown): string | undefined {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    const constraint = readConstraint(current);
    if (constraint !== undefined) return constraint;
    current = readCause(current);
  }
  return undefined;
}

async function captureInsertError<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected insert to reject, but it succeeded');
}

/**
 * Generates a unique R2-style storage key for tests. Avoids the module-level
 * `crypto.randomUUID()` collision in `imageContentItemFactory.params`.
 */
function uniqueStorageKey(): string {
  return `media/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}.enc`;
}

describe('factory integration', () => {
  let db: Database;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdMessageIds: string[] = [];
  const createdProjectIds: string[] = [];
  const createdUsageRecordIds: string[] = [];

  beforeAll(() => {
    db = createDb({
      connectionString: DATABASE_URL,
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
  });

  afterAll(async () => {
    if (createdMessageIds.length > 0) {
      await db.delete(messages).where(inArray(messages.id, createdMessageIds));
    }
    if (createdConversationIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
    }
    if (createdProjectIds.length > 0) {
      await db.delete(projects).where(inArray(projects.id, createdProjectIds));
    }
    if (createdUsageRecordIds.length > 0) {
      await db.delete(usageRecords).where(inArray(usageRecords.id, createdUsageRecordIds));
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
  });

  it('inserts factory-built records with proper relationships', async () => {
    const [user] = await db.insert(users).values(userFactory.build()).returning();
    if (user === undefined) {
      throw new Error('User insert failed - no record returned');
    }
    createdUserIds.push(user.id);

    const [conv] = await db
      .insert(conversations)
      .values(conversationFactory.build({ userId: user.id }))
      .returning();
    if (conv === undefined) {
      throw new Error('Conversation insert failed - no record returned');
    }
    createdConversationIds.push(conv.id);

    const [msg] = await db
      .insert(messages)
      .values(messageFactory.build({ conversationId: conv.id, senderId: user.id }))
      .returning();
    if (msg === undefined) {
      throw new Error('Message insert failed - no record returned');
    }
    createdMessageIds.push(msg.id);

    const [proj] = await db
      .insert(projects)
      .values(projectFactory.build({ userId: user.id }))
      .returning();
    if (proj === undefined) {
      throw new Error('Project insert failed - no record returned');
    }
    createdProjectIds.push(proj.id);

    expect(conv.userId).toBe(user.id);
    expect(msg.conversationId).toBe(conv.id);
    expect(proj.userId).toBe(user.id);
  });

  it('fails to insert with non-existent FK (safety net)', async () => {
    const conv = conversationFactory.build();
    await expect(db.insert(conversations).values(conv)).rejects.toThrow();
  });

  it('round-trips a contentItemFactory text row against a real messages FK', async () => {
    const [user] = await db.insert(users).values(userFactory.build()).returning();
    if (user === undefined) throw new Error('User insert failed');
    createdUserIds.push(user.id);

    const [conv] = await db
      .insert(conversations)
      .values(conversationFactory.build({ userId: user.id }))
      .returning();
    if (conv === undefined) throw new Error('Conversation insert failed');
    createdConversationIds.push(conv.id);

    const [msg] = await db
      .insert(messages)
      .values(messageFactory.build({ conversationId: conv.id, senderId: user.id }))
      .returning();
    if (msg === undefined) throw new Error('Message insert failed');
    createdMessageIds.push(msg.id);

    const built = contentItemFactory.build({ messageId: msg.id });
    const [inserted] = await db.insert(contentItems).values(built).returning();
    if (inserted === undefined) throw new Error('Content item insert failed');

    const [readBack] = await db.select().from(contentItems).where(eq(contentItems.id, inserted.id));
    if (readBack === undefined) throw new Error('Content item read failed');

    expect(readBack.id).toBe(built.id);
    expect(readBack.messageId).toBe(msg.id);
    expect(readBack.contentType).toBe('text');
    expect(readBack.encryptedBlob).toBeInstanceOf(Uint8Array);
    expect(readBack.encryptedBlob).toEqual(built.encryptedBlob);
    expect(readBack.storageKey).toBeNull();
    expect(readBack.position).toBe(0);
  });

  it('round-trips a mediaGenerationFactory row against a real usage_records FK', async () => {
    const [user] = await db.insert(users).values(userFactory.build()).returning();
    if (user === undefined) throw new Error('User insert failed');
    createdUserIds.push(user.id);

    const [usage] = await db
      .insert(usageRecords)
      .values(usageRecordFactory.build({ userId: user.id, type: 'image_generation' }))
      .returning();
    if (usage === undefined) throw new Error('Usage record insert failed');
    createdUsageRecordIds.push(usage.id);

    const built = mediaGenerationFactory.build({
      usageRecordId: usage.id,
      mediaType: 'image',
    });
    const [inserted] = await db.insert(mediaGenerations).values(built).returning();
    if (inserted === undefined) throw new Error('Media generation insert failed');

    const [readBack] = await db
      .select()
      .from(mediaGenerations)
      .where(eq(mediaGenerations.id, inserted.id));
    if (readBack === undefined) throw new Error('Media generation read failed');

    expect(readBack.id).toBe(built.id);
    expect(readBack.usageRecordId).toBe(usage.id);
    expect(readBack.mediaType).toBe('image');
    expect(readBack.imageCount).toBe(1);
    expect(readBack.durationMs).toBeNull();
    expect(readBack.resolution).toBeNull();
  });

  describe('content_items_type_consistency CHECK constraint', () => {
    let messageId: string;

    beforeAll(async () => {
      const [user] = await db.insert(users).values(userFactory.build()).returning();
      if (user === undefined) throw new Error('User insert failed');
      createdUserIds.push(user.id);

      const [conv] = await db
        .insert(conversations)
        .values(conversationFactory.build({ userId: user.id }))
        .returning();
      if (conv === undefined) throw new Error('Conversation insert failed');
      createdConversationIds.push(conv.id);

      const [msg] = await db
        .insert(messages)
        .values(messageFactory.build({ conversationId: conv.id, senderId: user.id }))
        .returning();
      if (msg === undefined) throw new Error('Message insert failed');
      createdMessageIds.push(msg.id);
      messageId = msg.id;
    });

    it('rejects text content with a storage_key set', async () => {
      const bad = contentItemFactory.build({
        messageId,
        contentType: 'text',
        storageKey: uniqueStorageKey(),
      });
      const error = await captureInsertError(db.insert(contentItems).values(bad));
      expect(findConstraintName(error)).toBe('content_items_type_consistency');
    });

    it('rejects image content with an encrypted_blob set', async () => {
      const bad = imageContentItemFactory.build({
        messageId,
        storageKey: uniqueStorageKey(),
        encryptedBlob: new Uint8Array([1, 2, 3]),
      });
      const error = await captureInsertError(db.insert(contentItems).values(bad));
      expect(findConstraintName(error)).toBe('content_items_type_consistency');
    });

    it('rejects image content missing storage_key, mime_type, or size_bytes', async () => {
      const bad = imageContentItemFactory.build({
        messageId,
        storageKey: null,
        mimeType: null,
        sizeBytes: null,
      });
      const error = await captureInsertError(db.insert(contentItems).values(bad));
      expect(findConstraintName(error)).toBe('content_items_type_consistency');
    });
  });

  describe('content_items_storage_key_idx partial unique index', () => {
    let messageId: string;

    beforeAll(async () => {
      const [user] = await db.insert(users).values(userFactory.build()).returning();
      if (user === undefined) throw new Error('User insert failed');
      createdUserIds.push(user.id);

      const [conv] = await db
        .insert(conversations)
        .values(conversationFactory.build({ userId: user.id }))
        .returning();
      if (conv === undefined) throw new Error('Conversation insert failed');
      createdConversationIds.push(conv.id);

      const [msg] = await db
        .insert(messages)
        .values(messageFactory.build({ conversationId: conv.id, senderId: user.id }))
        .returning();
      if (msg === undefined) throw new Error('Message insert failed');
      createdMessageIds.push(msg.id);
      messageId = msg.id;
    });

    it('rejects two rows sharing the same non-NULL storage_key', async () => {
      const sharedKey = `media/${crypto.randomUUID()}/duplicate.enc`;
      const first = imageContentItemFactory.build({ messageId, storageKey: sharedKey });
      await db.insert(contentItems).values(first);

      const second = imageContentItemFactory.build({ messageId, storageKey: sharedKey });
      const error = await captureInsertError(db.insert(contentItems).values(second));
      expect(findConstraintName(error)).toBe('content_items_storage_key_idx');
    });

    it('allows multiple text rows with NULL storage_key to coexist', async () => {
      const first = contentItemFactory.build({ messageId, position: 10 });
      const second = contentItemFactory.build({ messageId, position: 11 });
      const third = contentItemFactory.build({ messageId, position: 12 });

      await db.insert(contentItems).values(first);
      await db.insert(contentItems).values(second);
      await db.insert(contentItems).values(third);

      const rows = await db
        .select()
        .from(contentItems)
        .where(eq(contentItems.messageId, messageId));

      const nullStorageRows = rows.filter((r) => r.storageKey === null);
      expect(nullStorageRows.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('round-trips a multi-content-item message via wrap-once envelope encryption', async () => {
    // Set up the user, conversation, and a fresh keypair that simulates the conversation epoch.
    const [user] = await db.insert(users).values(userFactory.build()).returning();
    if (user === undefined) throw new Error('User insert failed');
    createdUserIds.push(user.id);

    const [conv] = await db
      .insert(conversations)
      .values(conversationFactory.build({ userId: user.id }))
      .returning();
    if (conv === undefined) throw new Error('Conversation insert failed');
    createdConversationIds.push(conv.id);

    const epochKeyPair = generateKeyPair();

    // One envelope per message: produces both the wrappedContentKey (stored on the
    // messages row) and the contentKey (used to encrypt every content_item blob).
    const { contentKey, wrappedContentKey } = beginMessageEnvelope(epochKeyPair.publicKey);

    const [msg] = await db
      .insert(messages)
      .values(
        messageFactory.build({
          conversationId: conv.id,
          senderId: user.id,
          wrappedContentKey,
        })
      )
      .returning();
    if (msg === undefined) throw new Error('Message insert failed');
    createdMessageIds.push(msg.id);

    // 1 text + 2 image content_items, all encrypted with the same contentKey.
    const textPlaintext = 'Look at these two images:';
    const textBlob = encryptTextWithContentKey(contentKey, textPlaintext);

    const textItem = aiTextContentItemFactory.build({
      messageId: msg.id,
      position: 0,
      encryptedBlob: textBlob,
    });
    const imageOne = imageContentItemFactory.build({
      messageId: msg.id,
      position: 1,
      storageKey: uniqueStorageKey(),
    });
    const imageTwo = imageContentItemFactory.build({
      messageId: msg.id,
      position: 2,
      storageKey: uniqueStorageKey(),
    });

    await db.insert(contentItems).values([textItem, imageOne, imageTwo]);

    // Rendering query: LEFT JOIN messages with content_items, ordered by position.
    const joined = await db
      .select({
        messageId: messages.id,
        wrappedContentKey: messages.wrappedContentKey,
        contentItemId: contentItems.id,
        contentType: contentItems.contentType,
        position: contentItems.position,
        encryptedBlob: contentItems.encryptedBlob,
        storageKey: contentItems.storageKey,
      })
      .from(messages)
      .leftJoin(contentItems, eq(contentItems.messageId, messages.id))
      .where(eq(messages.id, msg.id))
      .orderBy(asc(contentItems.position));

    expect(joined).toHaveLength(3);
    expect(joined.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(joined.map((r) => r.contentType)).toEqual(['text', 'image', 'image']);
    expect(joined.map((r) => r.contentItemId)).toEqual([textItem.id, imageOne.id, imageTwo.id]);

    // Single openMessageEnvelope call recovers the contentKey for every item.
    const firstRow = joined[0];
    if (firstRow === undefined) throw new Error('No joined row');

    const recoveredContentKey = openMessageEnvelope(
      epochKeyPair.privateKey,
      firstRow.wrappedContentKey as WrappedContentKey
    );

    // Decrypt the text item using the recovered key. Image blobs are NULL in DB
    // (their bytes live in R2), so we only decrypt the text item to confirm the
    // recovered key matches the one that produced its ciphertext.
    if (firstRow.encryptedBlob === null) throw new Error('text encryptedBlob missing');
    const decrypted = decryptTextWithContentKey(recoveredContentKey, firstRow.encryptedBlob);
    expect(decrypted).toBe(textPlaintext);

    expect(joined[1]?.encryptedBlob).toBeNull();
    expect(joined[1]?.storageKey).toBe(imageOne.storageKey);
    expect(joined[2]?.encryptedBlob).toBeNull();
    expect(joined[2]?.storageKey).toBe(imageTwo.storageKey);
  });
});
