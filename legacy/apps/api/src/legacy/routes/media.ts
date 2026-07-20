import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { contentItems, messages, conversationMembers, epochs, epochMembers } from '@hushbox/db';
import {
  ERROR_CODE_CONTENT_ITEM_NOT_FOUND,
  ERROR_CODE_CONTENT_ITEM_NOT_MEDIA,
  ERROR_CODE_NOT_AUTHENTICATED,
  ERROR_CODE_STORAGE_READ_FAILED,
} from '@hushbox/shared';
import { resolveLinkGuestByKey } from '../middleware/resolve-link-guest.js';
import { rateLimitByCaller } from '../middleware/rate-limit.js';
import { createErrorResponse } from '../lib/error-response.js';
import type { AppEnv } from '../types.js';
import type { Context, MiddlewareHandler } from 'hono';

const MEDIA_CONTENT_TYPES = new Set(['image', 'audio', 'video']);

type CallerIdentity =
  | { kind: 'user'; userId: string; publicKey: Uint8Array }
  | { kind: 'link'; linkId: string; publicKey: Uint8Array };

/**
 * Resolve the caller's identity for media authorization. Accepts either an
 * authenticated session user or a link guest (via `x-link-public-key`).
 * Returns `null` when neither is present.
 *
 * Both identity kinds gate access through the same two-step query: an active
 * `conversation_members` row AND an `epoch_members` row for the message's
 * specific epoch. The link-guest case keys the member row by `link_id` and
 * the epoch row by the link's `member_public_key`.
 */
async function resolveCaller(c: Context<AppEnv>): Promise<CallerIdentity | null> {
  const user = c.get('user');
  if (user) {
    return { kind: 'user', userId: user.id, publicKey: user.publicKey };
  }
  const linkGuest = await resolveLinkGuestByKey(c);
  if (linkGuest) {
    return { kind: 'link', linkId: linkGuest.linkId, publicKey: linkGuest.publicKey };
  }
  return null;
}

function callerMemberPredicate(caller: CallerIdentity): ReturnType<typeof eq> {
  return caller.kind === 'user'
    ? eq(conversationMembers.userId, caller.userId)
    : eq(conversationMembers.linkId, caller.linkId);
}

function callerRateLimitId(caller: CallerIdentity): string {
  return caller.kind === 'user' ? caller.userId : `link:${caller.linkId}`;
}

const mediaCallerMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const caller = await resolveCaller(c);
  if (!caller) {
    return c.json(createErrorResponse(ERROR_CODE_NOT_AUTHENTICATED), 401);
  }
  c.set('callerId', callerRateLimitId(caller));
  c.set('mediaCaller', caller);
  return next();
};

/**
 * Auth middleware specific to /api/media — admits session users AND link
 * guests, attaches caller identity for the route handler, and sets
 * `callerId` so the downstream `rateLimitByCaller` middleware has a key.
 * Required because `requirePrivilege('read', { allowLinkGuest: true })`
 * keys off `:conversationId` in the URL; media URLs only carry the content
 * item id.
 */
function requireMediaCaller(): MiddlewareHandler<AppEnv> {
  return mediaCallerMiddleware;
}

/**
 * GET /:contentItemId/download-url (mounted at /api/media).
 *
 * Returns a short-lived presigned GET URL that the client uses to fetch the
 * encrypted media object directly from R2. Bytes never pass through the Worker
 * on reads.
 *
 * Authorization: the caller must be an active member of the conversation AND
 * an `epoch_members` row for the message's specific epoch. Conversation
 * membership alone would let a late-joiner mint download URLs for ciphertext
 * from earlier epochs they were never part of — they cannot decrypt, but
 * they could exfiltrate the encrypted blobs. The epoch-level JOIN closes
 * that gap. Non-epoch-members receive 404 (blind response — we don't
 * disclose whether the item exists).
 *
 * Both session users and link guests are admitted; the JOIN keys vary per
 * identity but the epoch gate is identical.
 */
export const mediaRoute = new Hono<AppEnv>().get(
  '/:contentItemId/download-url',
  requireMediaCaller(),
  rateLimitByCaller('mediaDownloadUserRateLimit'),
  zValidator('param', z.object({ contentItemId: z.string().min(1) })),
  async (c) => {
    const caller = c.get('mediaCaller');
    const db = c.get('db');
    const mediaStorage = c.get('mediaStorage');
    const { contentItemId } = c.req.valid('param');

    const row = await db
      .select({
        id: contentItems.id,
        contentType: contentItems.contentType,
        storageKey: contentItems.storageKey,
        conversationId: messages.conversationId,
      })
      .from(contentItems)
      .innerJoin(messages, eq(messages.id, contentItems.messageId))
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, messages.conversationId),
          callerMemberPredicate(caller),
          isNull(conversationMembers.leftAt)
        )
      )
      // Bridge messages.epoch_number → epochs.id so we can join epoch_members
      // by id. epochs.(conversationId, epochNumber) is a unique constraint,
      // so this row is unambiguous.
      .innerJoin(
        epochs,
        and(
          eq(epochs.conversationId, messages.conversationId),
          eq(epochs.epochNumber, messages.epochNumber)
        )
      )
      // Caller's public key (user or link) must appear in epoch_members for
      // the message's specific epoch. memberPublicKey is unique per epoch.
      .innerJoin(
        epochMembers,
        and(eq(epochMembers.epochId, epochs.id), eq(epochMembers.memberPublicKey, caller.publicKey))
      )
      .where(eq(contentItems.id, contentItemId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!row) {
      return c.json(createErrorResponse(ERROR_CODE_CONTENT_ITEM_NOT_FOUND), 404);
    }

    if (!MEDIA_CONTENT_TYPES.has(row.contentType) || !row.storageKey) {
      return c.json(createErrorResponse(ERROR_CODE_CONTENT_ITEM_NOT_MEDIA), 400);
    }

    try {
      const { url, expiresAt } = await mediaStorage.mintDownloadUrl({ key: row.storageKey });
      return c.json({ downloadUrl: url, expiresAt }, 200);
    } catch {
      return c.json(createErrorResponse(ERROR_CODE_STORAGE_READ_FAILED), 500);
    }
  }
);
