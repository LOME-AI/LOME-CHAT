import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { contentItems, mediaGenerations, messages, usageRecords } from '@hushbox/db';
import { FEATURE_FLAGS } from '@hushbox/shared';
import { saveChatTurn } from '../services/chat/message-persistence.js';
import { createMockAIClient } from '../services/ai/mock.js';
import {
  cleanupMediaTest,
  cleanupTestUserData,
  encryptAndUploadMedia,
  fetchAndDecryptMedia,
  setupMediaStrategyTest,
  type MediaStrategyTestContext,
} from '../services/chat/media-strategy-test-helpers.js';
import type { InferenceEvent } from '../services/ai/types.js';

const AUDIO_MODEL = 'openai/tts-1';
const AUDIO_MIME = 'audio/mpeg';
const AUDIO_DURATION_MS = 3000;
const AUDIO_COST_DOLLARS = 0.045; // 3 seconds × $0.015/sec from MOCK_MODELS audio entry
const AUDIO_COST_STRING = '0.04500000';

interface AudioMockBytes {
  bytes: Uint8Array;
  mimeType: string;
  durationMs: number;
}

/**
 * Drive the MockAIClient through a single audio request and capture its
 * `media-done` payload. This avoids depending on a private CANNED_WAV
 * constant and keeps the integration test self-contained — when the audio
 * mock changes (e.g. larger WAV, longer duration), the test picks up the
 * new bytes automatically. Mirrors the spirit of how
 * `modality-strategies.image.integration.test.ts` uses CANNED_PNG, but for
 * a media kind whose canned bytes aren't exported.
 */
async function captureAudioFromMock(): Promise<AudioMockBytes> {
  const client = createMockAIClient();
  const stream = client.stream({
    modality: 'audio',
    model: AUDIO_MODEL,
    prompt: 'Hello, this is a test',
    format: 'wav',
  });
  let bytes: Uint8Array | undefined;
  let mimeType: string | undefined;
  let durationMs: number | undefined;
  for await (const event of stream as AsyncIterable<InferenceEvent>) {
    if (event.kind === 'media-done') {
      bytes = event.bytes;
      mimeType = event.mimeType;
      durationMs = event.durationMs;
    }
  }
  if (!bytes || !mimeType || durationMs === undefined) {
    throw new Error('MockAIClient audio stream did not emit a complete media-done event');
  }
  return { bytes, mimeType, durationMs };
}

describe('audio strategy integration (real DB + real MinIO)', () => {
  const contexts: MediaStrategyTestContext[] = [];

  // Audio is dead-coded behind FEATURE_FLAGS.AUDIO_ENABLED in production
  // (until the AI Gateway ships speech models). The integration suite still
  // exercises the persistence pipeline end-to-end, so we flip the flag on for
  // the duration of the suite and restore the original value after — guarding
  // against the suite silently passing only when the project default happens
  // to be `true`. Mirrors the pattern at chat.test.ts:3225-3236.
  let originalAudioEnabled: boolean;
  beforeAll(() => {
    originalAudioEnabled = FEATURE_FLAGS.AUDIO_ENABLED;
    FEATURE_FLAGS.AUDIO_ENABLED = true;
  });
  afterAll(() => {
    FEATURE_FLAGS.AUDIO_ENABLED = originalAudioEnabled;
  });

  afterEach(async () => {
    for (const ctx of contexts) {
      await cleanupMediaTest(ctx);
      await cleanupTestUserData(ctx.db, ctx.setup.user.id);
    }
    contexts.length = 0;
  });

  it('persists messages + content_items + media_generations rows for audio', async () => {
    const ctx = await setupMediaStrategyTest();
    contexts.push(ctx);

    const { bytes: cannedAudio, durationMs } = await captureAudioFromMock();
    expect(durationMs).toBe(AUDIO_DURATION_MS);

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();

    const upload = await encryptAndUploadMedia({
      ctx,
      cannedBytes: cannedAudio,
      conversationId: ctx.setup.conversation.id,
      messageId: assistantMsgId,
      contentItemId,
      mimeType: AUDIO_MIME,
    });

    await saveChatTurn(ctx.db, {
      userMessageId: userMsgId,
      userContent: 'Read this aloud',
      conversationId: ctx.setup.conversation.id,
      userId: ctx.setup.user.id,
      senderId: ctx.setup.user.id,
      parentMessageId: null,
      assistantMessages: [
        {
          modality: 'audio',
          id: assistantMsgId,
          wrappedContentKey: upload.wrappedContentKey,
          contentItems: [
            {
              id: contentItemId,
              contentType: 'audio',
              position: 0,
              storageKey: upload.storageKey,
              mimeType: AUDIO_MIME,
              sizeBytes: upload.ciphertext.byteLength,
              durationMs: AUDIO_DURATION_MS,
              modelName: AUDIO_MODEL,
              cost: AUDIO_COST_STRING,
              isSmartModel: false,
            },
          ],
          model: AUDIO_MODEL,
          cost: AUDIO_COST_DOLLARS,
          mediaType: 'audio',
          durationMs: AUDIO_DURATION_MS,
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
    expect(item.contentType).toBe('audio');
    expect(item.storageKey).toBe(upload.storageKey);
    expect(item.mimeType).toBe(AUDIO_MIME);
    expect(item.sizeBytes).toBe(upload.ciphertext.byteLength);
    expect(item.durationMs).toBe(AUDIO_DURATION_MS);
    expect(item.modelName).toBe(AUDIO_MODEL);
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
    expect(genRow!.model).toBe(AUDIO_MODEL);
    expect(genRow!.mediaType).toBe('audio');
    expect(genRow!.durationMs).toBe(AUDIO_DURATION_MS);
  });

  it('mintDownloadUrl + fetch + decrypt round-trips to the original audio bytes', async () => {
    const ctx = await setupMediaStrategyTest();
    contexts.push(ctx);

    const { bytes: cannedAudio } = await captureAudioFromMock();

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();

    const upload = await encryptAndUploadMedia({
      ctx,
      cannedBytes: cannedAudio,
      conversationId: ctx.setup.conversation.id,
      messageId: assistantMsgId,
      contentItemId,
      mimeType: AUDIO_MIME,
    });

    await saveChatTurn(ctx.db, {
      userMessageId: userMsgId,
      userContent: 'audio',
      conversationId: ctx.setup.conversation.id,
      userId: ctx.setup.user.id,
      senderId: ctx.setup.user.id,
      parentMessageId: null,
      assistantMessages: [
        {
          modality: 'audio',
          id: assistantMsgId,
          wrappedContentKey: upload.wrappedContentKey,
          contentItems: [
            {
              id: contentItemId,
              contentType: 'audio',
              position: 0,
              storageKey: upload.storageKey,
              mimeType: AUDIO_MIME,
              sizeBytes: upload.ciphertext.byteLength,
              durationMs: AUDIO_DURATION_MS,
              modelName: AUDIO_MODEL,
              cost: AUDIO_COST_STRING,
              isSmartModel: false,
            },
          ],
          model: AUDIO_MODEL,
          cost: AUDIO_COST_DOLLARS,
          mediaType: 'audio',
          durationMs: AUDIO_DURATION_MS,
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
    expect([...decrypted]).toEqual([...cannedAudio]);
  });

  it('content_items.size_bytes records the ciphertext length, not plaintext length', async () => {
    const ctx = await setupMediaStrategyTest();
    contexts.push(ctx);

    const { bytes: cannedAudio } = await captureAudioFromMock();

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();

    const upload = await encryptAndUploadMedia({
      ctx,
      cannedBytes: cannedAudio,
      conversationId: ctx.setup.conversation.id,
      messageId: assistantMsgId,
      contentItemId,
      mimeType: AUDIO_MIME,
    });

    // Sanity: ciphertext > plaintext (envelope+nonce+MAC overhead).
    expect(upload.ciphertext.byteLength).toBeGreaterThan(cannedAudio.byteLength);

    await saveChatTurn(ctx.db, {
      userMessageId: userMsgId,
      userContent: 'audio',
      conversationId: ctx.setup.conversation.id,
      userId: ctx.setup.user.id,
      senderId: ctx.setup.user.id,
      parentMessageId: null,
      assistantMessages: [
        {
          modality: 'audio',
          id: assistantMsgId,
          wrappedContentKey: upload.wrappedContentKey,
          contentItems: [
            {
              id: contentItemId,
              contentType: 'audio',
              position: 0,
              storageKey: upload.storageKey,
              mimeType: AUDIO_MIME,
              sizeBytes: upload.ciphertext.byteLength,
              durationMs: AUDIO_DURATION_MS,
              modelName: AUDIO_MODEL,
              cost: AUDIO_COST_STRING,
              isSmartModel: false,
            },
          ],
          model: AUDIO_MODEL,
          cost: AUDIO_COST_DOLLARS,
          mediaType: 'audio',
          durationMs: AUDIO_DURATION_MS,
        },
      ],
    });

    const [item] = await ctx.db
      .select({ size: contentItems.sizeBytes })
      .from(contentItems)
      .where(eq(contentItems.messageId, assistantMsgId));
    expect(item!.size).toBe(upload.ciphertext.byteLength);
    expect(item!.size).not.toBe(cannedAudio.byteLength);
  });
});
