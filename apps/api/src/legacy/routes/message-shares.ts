import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, asc, isNull } from 'drizzle-orm';
import {
  ERROR_CODE_INTERNAL,
  ERROR_CODE_MESSAGE_NOT_FOUND,
  ERROR_CODE_SHARE_FORBIDDEN,
  ERROR_CODE_SHARE_NOT_FOUND,
  ERROR_CODE_STORAGE_READ_FAILED,
  ALLOWED_MEDIA_MIME_TYPES,
  contentTypeSchema,
  toBase64,
  fromBase64,
} from '@hushbox/shared';
import {
  sharedMessages,
  messages,
  contentItems,
  conversationMembers,
  type ContentItem,
} from '@hushbox/db';
import { requireAuth } from '../middleware/require-auth.js';
import { rateLimitByCaller, rateLimitByIp } from '../middleware/rate-limit.js';
import { getUser } from '../lib/get-user.js';
import { createErrorResponse } from '../lib/error-response.js';
import type { AppEnv } from '../types.js';
import type { MediaStorage } from '../services/storage/types.js';
import type { PublicShareContentItem } from '@hushbox/shared';

const MEDIA_CONTENT_TYPES = new Set(['image', 'audio', 'video']);

const createShareSchema = z.object({
  messageId: z.string(),
  /**
   * Base64-encoded wrap of the message's content key under a fresh `shareSecret`
   * derived key. The `shareSecret` lives only in the URL fragment client-side.
   */
  wrappedShareKey: z.string(),
});

/** Authenticated route — POST /share (mounted at /api/messages). */
export const messageSharesRoute = new Hono<AppEnv>().post(
  '/share',
  requireAuth(),
  rateLimitByCaller('shareCreateUserRateLimit'),
  zValidator('json', createShareSchema),
  async (c) => {
    const user = getUser(c);
    const db = c.get('db');
    const { messageId, wrappedShareKey: wrappedShareKeyBase64 } = c.req.valid('json');

    // 1. Verify the message exists (cheap pre-check so we can return 404 vs 403).
    const message = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!message) {
      return c.json(createErrorResponse(ERROR_CODE_MESSAGE_NOT_FOUND), 404);
    }

    // 2. Atomic membership check + insert inside one transaction. We use a
    //    `SELECT ... FOR SHARE` to lock the membership row for the duration of
    //    the transaction so a concurrent removal blocks until we commit, and
    //    a concurrent removal that committed first leaves us with no row.
    //    This closes the previous check-then-act race where a user could be
    //    removed between the membership lookup and the insert.
    const wrappedShareKeyBytes = fromBase64(wrappedShareKeyBase64);
    const conversationId = message.conversationId;
    const result = await db.transaction(async (tx) => {
      const [activeMembership] = await tx
        .select({ id: conversationMembers.id })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, user.id),
            isNull(conversationMembers.leftAt)
          )
        )
        .for('share')
        .limit(1);

      if (!activeMembership) return { kind: 'forbidden' as const };

      const [row] = await tx
        .insert(sharedMessages)
        .values({ messageId, wrappedContentKey: wrappedShareKeyBytes })
        .returning();

      return row ? { kind: 'ok' as const, shareId: row.id } : { kind: 'internal' as const };
    });

    if (result.kind === 'forbidden') {
      return c.json(createErrorResponse(ERROR_CODE_SHARE_FORBIDDEN, { messageId }), 403);
    }
    if (result.kind === 'internal') {
      return c.json(createErrorResponse(ERROR_CODE_INTERNAL), 500);
    }

    return c.json({ shareId: result.shareId }, 201);
  }
);

/**
 * Serializes a stored content item for the public share response.
 * Strips `model_name`, `cost`, `is_smart_model`, and the internal `storage_key` —
 * share recipients see content, not generation metadata. For media items, mints
 * a short-lived presigned GET URL so the client can fetch + decrypt the bytes.
 */
async function serializePublicShareContentItem(
  item: ContentItem,
  mediaStorage: MediaStorage
): Promise<PublicShareContentItem> {
  // DB CHECK constraint enforces the value set at write time; parsing here
  // gives us a type-narrow and a loud failure if a rogue row ever slips through.
  const contentType = contentTypeSchema.parse(item.contentType);

  // Defense-in-depth: media items must carry a mimeType in the platform's
  // allowlist. The upload path (media-pipeline.ts) blocks non-conforming
  // values before they hit the DB, but if anything ever bypasses that check
  // we throw here so the share response never ships malformed media.
  let validatedMimeType: PublicShareContentItem['mimeType'] = null;
  if (item.mimeType !== null) {
    const parsed = ALLOWED_MEDIA_MIME_TYPES.safeParse(item.mimeType);
    if (!parsed.success) {
      throw new Error(`Disallowed mime type in stored media: ${item.mimeType}`);
    }
    validatedMimeType = parsed.data;
  }

  const base: Omit<PublicShareContentItem, 'downloadUrl' | 'expiresAt'> = {
    id: item.id,
    contentType,
    position: item.position,
    encryptedBlob: item.encryptedBlob ? toBase64(item.encryptedBlob) : null,
    mimeType: validatedMimeType,
    sizeBytes: item.sizeBytes,
    width: item.width,
    height: item.height,
    durationMs: item.durationMs,
  };

  if (!MEDIA_CONTENT_TYPES.has(contentType) || !item.storageKey) {
    return { ...base, downloadUrl: null, expiresAt: null };
  }

  const { url, expiresAt } = await mediaStorage.mintDownloadUrl({ key: item.storageKey });
  return { ...base, downloadUrl: url, expiresAt };
}

/** Public route — GET /:shareId (mounted at /api/shares). No auth required. */
export const publicSharesRoute = new Hono<AppEnv>().get(
  '/:shareId',
  rateLimitByIp('shareGetIpRateLimit'),
  zValidator('param', z.object({ shareId: z.string().min(1) })),
  async (c) => {
    const db = c.get('db');
    const mediaStorage = c.get('mediaStorage');
    const { shareId } = c.req.valid('param');

    const share = await db
      .select({
        id: sharedMessages.id,
        messageId: sharedMessages.messageId,
        wrappedShareKey: sharedMessages.wrappedContentKey,
        createdAt: sharedMessages.createdAt,
      })
      .from(sharedMessages)
      .where(eq(sharedMessages.id, shareId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!share) {
      return c.json(createErrorResponse(ERROR_CODE_SHARE_NOT_FOUND), 404);
    }

    const items = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.messageId, share.messageId))
      .orderBy(asc(contentItems.position));

    let serializedItems: PublicShareContentItem[];
    try {
      serializedItems = await Promise.all(
        items.map((item) => serializePublicShareContentItem(item, mediaStorage))
      );
    } catch (error) {
      console.error('Presigned URL mint failed for share', {
        shareId: share.id,
        messageId: share.messageId,
        itemCount: items.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(createErrorResponse(ERROR_CODE_STORAGE_READ_FAILED), 500);
    }

    return c.json(
      {
        shareId: share.id,
        messageId: share.messageId,
        /** Wrapped content key — recipients unwrap with the shareSecret from the URL fragment. */
        wrappedShareKey: toBase64(share.wrappedShareKey),
        contentItems: serializedItems,
        createdAt: share.createdAt.toISOString(),
      },
      200
    );
  }
);
