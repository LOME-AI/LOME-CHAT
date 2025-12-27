import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, desc, and } from 'drizzle-orm';
import {
  conversations,
  messages,
  selectConversationSchema,
  selectMessageSchema,
} from '@lome-chat/db';
import {
  createConversationRequestSchema,
  updateConversationRequestSchema,
  createMessageRequestSchema,
} from '@lome-chat/shared';
import type { AppEnv } from '../types.js';

// Response schemas for OpenAPI documentation
const errorSchema = z.object({
  error: z.string(),
});

const conversationsListResponseSchema = z.object({
  conversations: z.array(selectConversationSchema),
});

const conversationDetailResponseSchema = z.object({
  conversation: selectConversationSchema,
  messages: z.array(selectMessageSchema),
});

const createConversationResponseSchema = z.object({
  conversation: selectConversationSchema,
  message: selectMessageSchema.optional(),
});

const updateConversationResponseSchema = z.object({
  conversation: selectConversationSchema,
});

const deleteConversationResponseSchema = z.object({
  deleted: z.boolean(),
});

const createMessageResponseSchema = z.object({
  message: selectMessageSchema,
});

// Route definitions
const listConversationsRoute = createRoute({
  method: 'get',
  path: '/',
  responses: {
    200: {
      content: { 'application/json': { schema: conversationsListResponseSchema } },
      description: 'List of conversations for authenticated user',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
  },
});

const getConversationRoute = createRoute({
  method: 'get',
  path: '/{id}',
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationDetailResponseSchema } },
      description: 'Conversation with messages',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Conversation not found',
    },
  },
});

const createConversationRoute = createRoute({
  method: 'post',
  path: '/',
  request: {
    body: {
      content: {
        'application/json': {
          schema: createConversationRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: createConversationResponseSchema } },
      description: 'Conversation created',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
  },
});

const updateConversationRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: updateConversationRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: updateConversationResponseSchema } },
      description: 'Conversation updated',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid request',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Conversation not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal server error',
    },
  },
});

const deleteConversationRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: deleteConversationResponseSchema } },
      description: 'Conversation deleted',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Conversation not found',
    },
  },
});

const createMessageRoute = createRoute({
  method: 'post',
  path: '/{id}/messages',
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: createMessageRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: createMessageResponseSchema } },
      description: 'Message created',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid request',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Conversation not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal server error',
    },
  },
});

/**
 * Creates conversations routes with OpenAPI documentation.
 * Requires dbMiddleware, authMiddleware, and sessionMiddleware to be applied.
 */
export function createConversationsRoutes(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  // GET / - List all conversations for authenticated user
  app.openapi(listConversationsRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const userConversations = await db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, user.id))
      .orderBy(desc(conversations.updatedAt));

    return c.json({ conversations: userConversations }, 200);
  });

  // GET /:id - Get single conversation with messages
  app.openapi(getConversationRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { id: conversationId } = c.req.valid('param');

    // Get conversation and verify ownership
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)));

    if (!conversation) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    // Get messages for conversation
    const conversationMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt);

    return c.json({ conversation, messages: conversationMessages }, 200);
  });

  // POST / - Create a new conversation
  app.openapi(createConversationRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const body = c.req.valid('json');

    // Determine title: use provided title, or generate from firstMessage, or use default
    let conversationTitle: string | undefined = body.title;
    if (!conversationTitle && body.firstMessage) {
      // Auto-generate title from first message content (truncate to 50 chars)
      const content = body.firstMessage.content;
      if (content.length > 50) {
        conversationTitle = content.slice(0, 50) + '...';
      } else {
        conversationTitle = content;
      }
    }

    // Use transaction to ensure atomicity of conversation + message creation
    const result = await db.transaction(async (tx) => {
      // Create conversation - use provided/generated title or default
      const [conversation] = await tx
        .insert(conversations)
        .values({
          userId: user.id,
          title: conversationTitle ?? 'New Conversation',
        })
        .returning();

      if (!conversation) {
        throw new Error('Failed to create conversation');
      }

      // Optionally create first message
      if (body.firstMessage) {
        const [message] = await tx
          .insert(messages)
          .values({
            conversationId: conversation.id,
            role: 'user',
            content: body.firstMessage.content,
          })
          .returning();

        return { conversation, message };
      }

      return { conversation };
    });

    return c.json(result, 201);
  });

  // PATCH /:id - Update conversation (rename)
  app.openapi(updateConversationRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { id: conversationId } = c.req.valid('param');
    const body = c.req.valid('json');

    // Verify ownership
    const [existing] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)));

    if (!existing) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    // Update conversation
    const [conversation] = await db
      .update(conversations)
      .set({
        title: body.title,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId))
      .returning();

    if (!conversation) {
      return c.json({ error: 'Failed to update conversation' }, 500);
    }

    return c.json({ conversation }, 200);
  });

  // DELETE /:id - Delete conversation
  app.openapi(deleteConversationRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { id: conversationId } = c.req.valid('param');

    // Verify ownership
    const [existing] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)));

    if (!existing) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    // Delete conversation (messages cascade via FK)
    await db.delete(conversations).where(eq(conversations.id, conversationId));

    return c.json({ deleted: true }, 200);
  });

  // POST /:id/messages - Add message to conversation
  app.openapi(createMessageRoute, async (c) => {
    const user = c.get('user');
    const db = c.get('db');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { id: conversationId } = c.req.valid('param');
    const body = c.req.valid('json');

    // Verify conversation exists and user owns it
    const [existing] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)));

    if (!existing) {
      return c.json({ error: 'Conversation not found' }, 404);
    }

    // Create message
    const [message] = await db
      .insert(messages)
      .values({
        conversationId,
        role: body.role,
        content: body.content,
        model: body.model,
      })
      .returning();

    if (!message) {
      return c.json({ error: 'Failed to create message' }, 500);
    }

    // Update conversation's updatedAt
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));

    return c.json({ message }, 201);
  });

  return app;
}
