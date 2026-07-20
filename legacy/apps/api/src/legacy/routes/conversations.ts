import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  createConversationRequestSchema,
  updateConversationRequestSchema,
  ERROR_CODE_CONVERSATION_NOT_FOUND,
  toBase64,
  fromBase64,
  contentTypeSchema,
  senderTypeSchema,
} from '@hushbox/shared';
import { conversationForks } from '@hushbox/db';

type ConversationFork = typeof conversationForks.$inferSelect;
import { createErrorResponse } from '../lib/error-response.js';
import { getUser } from '../lib/get-user.js';
import { requireAuth, requirePrivilege } from '../middleware/index.js';
import {
  listConversations,
  getConversationForMember,
  createOrGetConversation,
  updateConversation,
  deleteConversation,
} from '../services/conversations/index.js';
import type { Conversation, ContentItem, Database } from '@hushbox/db';
import type { MessageWithContent } from '../services/conversations/conversations.js';
import type {
  conversationResponseSchema,
  messageResponseSchema,
  contentItemResponseSchema,
} from '@hushbox/shared';
import type { AppEnv } from '../types.js';

/** Serialize a conversation entity for API responses. */
function serializeConversation(conv: Conversation): z.infer<typeof conversationResponseSchema> {
  return {
    id: conv.id,
    userId: conv.userId,
    title: toBase64(conv.title),
    currentEpoch: conv.currentEpoch,
    titleEpochNumber: conv.titleEpochNumber,
    nextSequence: conv.nextSequence,
    createdAt: conv.createdAt.toISOString(),
    updatedAt: conv.updatedAt.toISOString(),
  };
}

/** Serialize a content item for API responses. */
function serializeContentItem(item: ContentItem): z.infer<typeof contentItemResponseSchema> {
  return {
    id: item.id,
    contentType: contentTypeSchema.parse(item.contentType),
    position: item.position,
    encryptedBlob: item.encryptedBlob ? toBase64(item.encryptedBlob) : null,
    storageKey: item.storageKey,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    width: item.width,
    height: item.height,
    durationMs: item.durationMs,
    modelName: item.modelName,
    cost: item.cost,
    isSmartModel: item.isSmartModel,
  };
}

/** Serialize a message with its content items for API responses. */
function serializeMessage(msg: MessageWithContent): z.infer<typeof messageResponseSchema> {
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    wrappedContentKey: toBase64(msg.wrappedContentKey),
    // DB CHECK constraint guarantees this set; re-parse so a rogue row fails loud.
    senderType: senderTypeSchema.parse(msg.senderType),
    senderId: msg.senderId ?? null,
    epochNumber: msg.epochNumber,
    sequenceNumber: msg.sequenceNumber,
    parentMessageId: msg.parentMessageId ?? null,
    batchId: msg.batchId,
    createdAt: msg.createdAt.toISOString(),
    contentItems: msg.contentItems.map((ci) => serializeContentItem(ci)),
  };
}

/** Serialize a fork entity for API responses. */
function serializeFork(f: ConversationFork): {
  id: string;
  conversationId: string;
  name: string;
  tipMessageId: string | null;
  createdAt: string;
} {
  return {
    id: f.id,
    conversationId: f.conversationId,
    name: f.name,
    tipMessageId: f.tipMessageId,
    createdAt: f.createdAt.toISOString(),
  };
}

/** Fetch all forks for a conversation. */
async function fetchForks(db: Database, conversationId: string): Promise<ConversationFork[]> {
  return db
    .select()
    .from(conversationForks)
    .where(eq(conversationForks.conversationId, conversationId))
    .orderBy(conversationForks.createdAt);
}

export const conversationsRoute = new Hono<AppEnv>()
  .get(
    '/',
    zValidator(
      'query',
      z.object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
    ),
    requireAuth(),
    async (c) => {
      const user = getUser(c);
      const db = c.get('db');
      const query = c.req.valid('query');

      const { rows: userConversations, nextCursor } = await listConversations(db, user.id, {
        ...(query.cursor !== undefined && { cursor: query.cursor }),
        ...(query.limit !== undefined && { limit: query.limit }),
      });
      return c.json(
        {
          conversations: userConversations.map(
            ({ conversation, acceptedAt, invitedByUsername, privilege, muted, pinned }) => ({
              ...serializeConversation(conversation),
              accepted: acceptedAt !== null,
              invitedByUsername,
              privilege,
              muted,
              pinned,
            })
          ),
          nextCursor,
        },
        200
      );
    }
  )
  .get(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read', { allowLinkGuest: true }),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const user = c.get('user');
      const member = c.get('members').get(conversationId);
      if (!member) throw new Error('Member required after requirePrivilege');
      const callerId = c.get('callerId');

      const result = await getConversationForMember(
        db,
        conversationId,
        member.visibleFromEpoch,
        user?.id
      );
      if (!result) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }
      const accepted = result.acceptedAt !== null;
      const invitedByUsername = result.invitedByUsername;

      const forks = await fetchForks(db, conversationId);

      return c.json(
        {
          conversation: serializeConversation(result.conversation),
          messages: result.messages.map((msg) => serializeMessage(msg)),
          forks: forks.map((f) => serializeFork(f)),
          accepted,
          invitedByUsername,
          callerId,
          privilege: member.privilege,
        },
        200
      );
    }
  )
  .post('/', requireAuth(), zValidator('json', createConversationRequestSchema), async (c) => {
    const user = getUser(c);
    const db = c.get('db');
    const body = c.req.valid('json');

    const result = await createOrGetConversation(db, user.id, {
      id: body.id,
      title: body.title ? fromBase64(body.title) : undefined,
      epochPublicKey: fromBase64(body.epochPublicKey),
      confirmationHash: fromBase64(body.confirmationHash),
      memberWrap: fromBase64(body.memberWrap),
      userPublicKey: user.publicKey,
    });

    if (!result) {
      return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
    }

    const existingForks = result.isNew ? [] : await fetchForks(db, result.conversation.id);

    const response = {
      conversation: serializeConversation(result.conversation),
      messages: result.messages?.map((msg) => serializeMessage(msg)),
      forks: existingForks.map((f) => serializeFork(f)),
      isNew: result.isNew,
      accepted: true as const, // creator is always auto-accepted
      invitedByUsername: null as string | null,
    };

    const status = result.isNew ? 201 : 200;
    return c.json(response, status);
  })
  .patch(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('owner'),
    zValidator('json', updateConversationRequestSchema),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const body = c.req.valid('json');

      const conversation = await updateConversation(db, conversationId, user.id, {
        title: fromBase64(body.title),
        titleEpochNumber: body.titleEpochNumber,
      });

      if (!conversation) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }

      return c.json(
        {
          conversation: serializeConversation(conversation),
          accepted: true as const, // only owner can update, always accepted
          invitedByUsername: null as string | null,
        },
        200
      );
    }
  )
  .delete(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('owner'),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');

      const deleted = await deleteConversation(db, conversationId, user.id);
      if (!deleted) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }

      return c.json({ deleted: true }, 200);
    }
  );
