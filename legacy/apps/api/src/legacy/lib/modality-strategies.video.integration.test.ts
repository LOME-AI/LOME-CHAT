import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { contentItems, mediaGenerations, messages, usageRecords } from '@hushbox/db';
import { saveChatTurn } from '../services/chat/message-persistence.js';
import { CANNED_VIDEO, CANNED_VIDEO_DURATION_MS } from '../services/ai/mock.js';
import {
  cleanupMediaTest,
  cleanupTestUserData,
  encryptAndUploadMedia,
  fetchAndDecryptMedia,
  setupMediaStrategyTest,
  type MediaStrategyTestContext,
} from '../services/chat/media-strategy-test-helpers.js';

const VIDEO_MODEL = 'google/veo-3.1-fast-generate-001';
const VIDEO_MIME = 'video/mp4';
const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;
// Aligned with the canned MP4 duration so DB rows reflect what the runtime
// mock actually advertises for browser-decodable bytes.
const VIDEO_DURATION_MS = CANNED_VIDEO_DURATION_MS;
const VIDEO_RESOLUTION = '720p';
const VIDEO_COST_DOLLARS = 0.1;
const VIDEO_COST_STRING = '0.10000000';

describe('video strategy integration (real DB + real MinIO)', () => {
  const contexts: MediaStrategyTestContext[] = [];

  afterEach(async () => {
    for (const ctx of contexts) {
      await cleanupMediaTest(ctx);
      await cleanupTestUserData(ctx.db, ctx.setup.user.id);
    }
    contexts.length = 0;
  });

  it('persists messages + content_items + media_generations rows for video', async () => {
    const ctx = await setupMediaStrategyTest();
    contexts.push(ctx);

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();

    const upload = await encryptAndUploadMedia({
      ctx,
      cannedBytes: CANNED_VIDEO,
      conversationId: ctx.setup.conversation.id,
      messageId: assistantMsgId,
      contentItemId,
      mimeType: VIDEO_MIME,
    });

    await saveChatTurn(ctx.db, {
      userMessageId: userMsgId,
      userContent: 'Generate a short video',
      conversationId: ctx.setup.conversation.id,
      userId: ctx.setup.user.id,
      senderId: ctx.setup.user.id,
      parentMessageId: null,
      assistantMessages: [
        {
          modality: 'video',
          id: assistantMsgId,
          wrappedContentKey: upload.wrappedContentKey,
          contentItems: [
            {
              id: contentItemId,
              contentType: 'video',
              position: 0,
              storageKey: upload.storageKey,
              mimeType: VIDEO_MIME,
              sizeBytes: upload.ciphertext.byteLength,
              width: VIDEO_WIDTH,
              height: VIDEO_HEIGHT,
              durationMs: VIDEO_DURATION_MS,
              modelName: VIDEO_MODEL,
              cost: VIDEO_COST_STRING,
              isSmartModel: false,
            },
          ],
          model: VIDEO_MODEL,
          cost: VIDEO_COST_DOLLARS,
          mediaType: 'video',
          durationMs: VIDEO_DURATION_MS,
          resolution: VIDEO_RESOLUTION,
        },
      ],
    });

    const [msgRow] = await ctx.db.select().from(messages).where(eq(messages.id, assistantMsgId));
    expect(msgRow).toBeDefined();
    expect([...msgRow!.wrappedContentKey]).toEqual([...upload.wrappedContentKey]);

    const items = await ctx.db
      .select()
      .from(contentItems)
      .where(eq(contentItems.messageId, assistantMsgId));
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.contentType).toBe('video');
    expect(item.storageKey).toBe(upload.storageKey);
    expect(item.mimeType).toBe(VIDEO_MIME);
    expect(item.sizeBytes).toBe(upload.ciphertext.byteLength);
    expect(item.width).toBe(VIDEO_WIDTH);
    expect(item.height).toBe(VIDEO_HEIGHT);
    expect(item.durationMs).toBe(VIDEO_DURATION_MS);
    expect(item.modelName).toBe(VIDEO_MODEL);
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
    expect(genRow!.model).toBe(VIDEO_MODEL);
    expect(genRow!.mediaType).toBe('video');
    expect(genRow!.durationMs).toBe(VIDEO_DURATION_MS);
    expect(genRow!.resolution).toBe(VIDEO_RESOLUTION);
  });

  it('mintDownloadUrl + fetch + decrypt round-trips to original CANNED_VIDEO bytes', async () => {
    const ctx = await setupMediaStrategyTest();
    contexts.push(ctx);

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();

    const upload = await encryptAndUploadMedia({
      ctx,
      cannedBytes: CANNED_VIDEO,
      conversationId: ctx.setup.conversation.id,
      messageId: assistantMsgId,
      contentItemId,
      mimeType: VIDEO_MIME,
    });

    await saveChatTurn(ctx.db, {
      userMessageId: userMsgId,
      userContent: 'video',
      conversationId: ctx.setup.conversation.id,
      userId: ctx.setup.user.id,
      senderId: ctx.setup.user.id,
      parentMessageId: null,
      assistantMessages: [
        {
          modality: 'video',
          id: assistantMsgId,
          wrappedContentKey: upload.wrappedContentKey,
          contentItems: [
            {
              id: contentItemId,
              contentType: 'video',
              position: 0,
              storageKey: upload.storageKey,
              mimeType: VIDEO_MIME,
              sizeBytes: upload.ciphertext.byteLength,
              width: VIDEO_WIDTH,
              height: VIDEO_HEIGHT,
              durationMs: VIDEO_DURATION_MS,
              modelName: VIDEO_MODEL,
              cost: VIDEO_COST_STRING,
              isSmartModel: false,
            },
          ],
          model: VIDEO_MODEL,
          cost: VIDEO_COST_DOLLARS,
          mediaType: 'video',
          durationMs: VIDEO_DURATION_MS,
          resolution: VIDEO_RESOLUTION,
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
    expect([...decrypted]).toEqual([...CANNED_VIDEO]);
  });

  it('content_items.size_bytes records the ciphertext length for video', async () => {
    const ctx = await setupMediaStrategyTest();
    contexts.push(ctx);

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();

    const upload = await encryptAndUploadMedia({
      ctx,
      cannedBytes: CANNED_VIDEO,
      conversationId: ctx.setup.conversation.id,
      messageId: assistantMsgId,
      contentItemId,
      mimeType: VIDEO_MIME,
    });

    expect(upload.ciphertext.byteLength).toBeGreaterThan(CANNED_VIDEO.byteLength);

    await saveChatTurn(ctx.db, {
      userMessageId: userMsgId,
      userContent: 'video',
      conversationId: ctx.setup.conversation.id,
      userId: ctx.setup.user.id,
      senderId: ctx.setup.user.id,
      parentMessageId: null,
      assistantMessages: [
        {
          modality: 'video',
          id: assistantMsgId,
          wrappedContentKey: upload.wrappedContentKey,
          contentItems: [
            {
              id: contentItemId,
              contentType: 'video',
              position: 0,
              storageKey: upload.storageKey,
              mimeType: VIDEO_MIME,
              sizeBytes: upload.ciphertext.byteLength,
              width: VIDEO_WIDTH,
              height: VIDEO_HEIGHT,
              durationMs: VIDEO_DURATION_MS,
              modelName: VIDEO_MODEL,
              cost: VIDEO_COST_STRING,
              isSmartModel: false,
            },
          ],
          model: VIDEO_MODEL,
          cost: VIDEO_COST_DOLLARS,
          mediaType: 'video',
          durationMs: VIDEO_DURATION_MS,
          resolution: VIDEO_RESOLUTION,
        },
      ],
    });

    const [item] = await ctx.db
      .select({ size: contentItems.sizeBytes })
      .from(contentItems)
      .where(eq(contentItems.messageId, assistantMsgId));
    expect(item!.size).toBe(upload.ciphertext.byteLength);
    expect(item!.size).not.toBe(CANNED_VIDEO.byteLength);
  });
});
