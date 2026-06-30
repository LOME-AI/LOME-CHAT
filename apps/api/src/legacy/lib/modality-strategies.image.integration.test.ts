import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { contentItems, mediaGenerations, messages, usageRecords } from '@hushbox/db';
import { saveChatTurn } from '../services/chat/message-persistence.js';
import { CANNED_IMAGE, CANNED_IMAGE_WIDTH, CANNED_IMAGE_HEIGHT } from '../services/ai/mock.js';
import {
  cleanupMediaTest,
  cleanupTestUserData,
  encryptAndUploadMedia,
  fetchAndDecryptMedia,
  setupMediaStrategyTest,
  type MediaStrategyTestContext,
} from '../services/chat/media-strategy-test-helpers.js';

const IMAGE_MODEL = 'google/imagen-4';
const IMAGE_MIME = 'image/jpeg';
const IMAGE_WIDTH = CANNED_IMAGE_WIDTH;
const IMAGE_HEIGHT = CANNED_IMAGE_HEIGHT;
const IMAGE_COST_DOLLARS = 0.046;
const IMAGE_COST_STRING = '0.04600000';

describe('image strategy integration (real DB + real MinIO)', () => {
  const contexts: MediaStrategyTestContext[] = [];

  afterEach(async () => {
    for (const ctx of contexts) {
      await cleanupMediaTest(ctx);
      await cleanupTestUserData(ctx.db, ctx.setup.user.id);
    }
    contexts.length = 0;
  });

  it('persists messages + content_items + media_generations rows linked to a real R2 object', async () => {
    const ctx = await setupMediaStrategyTest();
    contexts.push(ctx);

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();

    const upload = await encryptAndUploadMedia({
      ctx,
      cannedBytes: CANNED_IMAGE,
      conversationId: ctx.setup.conversation.id,
      messageId: assistantMsgId,
      contentItemId,
      mimeType: IMAGE_MIME,
    });

    await saveChatTurn(ctx.db, {
      userMessageId: userMsgId,
      userContent: 'Generate an image',
      conversationId: ctx.setup.conversation.id,
      userId: ctx.setup.user.id,
      senderId: ctx.setup.user.id,
      parentMessageId: null,
      assistantMessages: [
        {
          modality: 'image',
          id: assistantMsgId,
          wrappedContentKey: upload.wrappedContentKey,
          contentItems: [
            {
              id: contentItemId,
              contentType: 'image',
              position: 0,
              storageKey: upload.storageKey,
              mimeType: IMAGE_MIME,
              sizeBytes: upload.ciphertext.byteLength,
              width: IMAGE_WIDTH,
              height: IMAGE_HEIGHT,
              modelName: IMAGE_MODEL,
              cost: IMAGE_COST_STRING,
              isSmartModel: false,
            },
          ],
          model: IMAGE_MODEL,
          cost: IMAGE_COST_DOLLARS,
          mediaType: 'image',
          imageCount: 1,
        },
      ],
    });

    const [msgRow] = await ctx.db.select().from(messages).where(eq(messages.id, assistantMsgId));
    expect(msgRow).toBeDefined();
    expect(msgRow!.wrappedContentKey).toBeDefined();
    expect([...msgRow!.wrappedContentKey]).toEqual([...upload.wrappedContentKey]);

    const items = await ctx.db
      .select()
      .from(contentItems)
      .where(eq(contentItems.messageId, assistantMsgId));
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.contentType).toBe('image');
    expect(item.storageKey).toBe(upload.storageKey);
    expect(item.mimeType).toBe(IMAGE_MIME);
    expect(item.sizeBytes).toBe(upload.ciphertext.byteLength);
    expect(item.width).toBe(IMAGE_WIDTH);
    expect(item.height).toBe(IMAGE_HEIGHT);
    expect(item.modelName).toBe(IMAGE_MODEL);
    expect(item.encryptedBlob).toBeNull();

    const [usageRow] = await ctx.db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.sourceId, assistantMsgId));
    expect(usageRow).toBeDefined();
    expect(usageRow!.type).toBe('media_generation');

    const [genRow] = await ctx.db
      .select()
      .from(mediaGenerations)
      .where(eq(mediaGenerations.usageRecordId, usageRow!.id));
    expect(genRow).toBeDefined();
    expect(genRow!.model).toBe(IMAGE_MODEL);
    expect(genRow!.mediaType).toBe('image');
    expect(genRow!.imageCount).toBe(1);
  });

  it('mintDownloadUrl + fetch + decrypt round-trips to original CANNED_IMAGE bytes', async () => {
    const ctx = await setupMediaStrategyTest();
    contexts.push(ctx);

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();

    const upload = await encryptAndUploadMedia({
      ctx,
      cannedBytes: CANNED_IMAGE,
      conversationId: ctx.setup.conversation.id,
      messageId: assistantMsgId,
      contentItemId,
      mimeType: IMAGE_MIME,
    });

    await saveChatTurn(ctx.db, {
      userMessageId: userMsgId,
      userContent: 'image',
      conversationId: ctx.setup.conversation.id,
      userId: ctx.setup.user.id,
      senderId: ctx.setup.user.id,
      parentMessageId: null,
      assistantMessages: [
        {
          modality: 'image',
          id: assistantMsgId,
          wrappedContentKey: upload.wrappedContentKey,
          contentItems: [
            {
              id: contentItemId,
              contentType: 'image',
              position: 0,
              storageKey: upload.storageKey,
              mimeType: IMAGE_MIME,
              sizeBytes: upload.ciphertext.byteLength,
              width: IMAGE_WIDTH,
              height: IMAGE_HEIGHT,
              modelName: IMAGE_MODEL,
              cost: IMAGE_COST_STRING,
              isSmartModel: false,
            },
          ],
          model: IMAGE_MODEL,
          cost: IMAGE_COST_DOLLARS,
          mediaType: 'image',
          imageCount: 1,
        },
      ],
    });

    const [item] = await ctx.db
      .select({ key: contentItems.storageKey })
      .from(contentItems)
      .where(eq(contentItems.messageId, assistantMsgId));
    expect(item!.key).toBe(upload.storageKey);

    const decrypted = await fetchAndDecryptMedia({
      storage: ctx.storage,
      storageKey: item!.key!,
      contentKey: upload.contentKey,
    });
    expect([...decrypted]).toEqual([...CANNED_IMAGE]);
  });

  it('content_items.size_bytes records the ciphertext length, not plaintext length', async () => {
    const ctx = await setupMediaStrategyTest();
    contexts.push(ctx);

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();

    const upload = await encryptAndUploadMedia({
      ctx,
      cannedBytes: CANNED_IMAGE,
      conversationId: ctx.setup.conversation.id,
      messageId: assistantMsgId,
      contentItemId,
      mimeType: IMAGE_MIME,
    });

    // Sanity: ciphertext is strictly larger than plaintext (envelope+nonce+MAC overhead).
    expect(upload.ciphertext.byteLength).toBeGreaterThan(CANNED_IMAGE.byteLength);

    await saveChatTurn(ctx.db, {
      userMessageId: userMsgId,
      userContent: 'image',
      conversationId: ctx.setup.conversation.id,
      userId: ctx.setup.user.id,
      senderId: ctx.setup.user.id,
      parentMessageId: null,
      assistantMessages: [
        {
          modality: 'image',
          id: assistantMsgId,
          wrappedContentKey: upload.wrappedContentKey,
          contentItems: [
            {
              id: contentItemId,
              contentType: 'image',
              position: 0,
              storageKey: upload.storageKey,
              mimeType: IMAGE_MIME,
              sizeBytes: upload.ciphertext.byteLength,
              width: IMAGE_WIDTH,
              height: IMAGE_HEIGHT,
              modelName: IMAGE_MODEL,
              cost: IMAGE_COST_STRING,
              isSmartModel: false,
            },
          ],
          model: IMAGE_MODEL,
          cost: IMAGE_COST_DOLLARS,
          mediaType: 'image',
          imageCount: 1,
        },
      ],
    });

    const [item] = await ctx.db
      .select({ size: contentItems.sizeBytes })
      .from(contentItems)
      .where(eq(contentItems.messageId, assistantMsgId));
    expect(item!.size).toBe(upload.ciphertext.byteLength);
    expect(item!.size).not.toBe(CANNED_IMAGE.byteLength);
  });
});
