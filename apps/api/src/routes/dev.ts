import { Hono } from 'hono';
import { like, eq, count, inArray } from 'drizzle-orm';
import { users, conversations, messages, projects } from '@lome-chat/db';
import { DEV_EMAIL_DOMAIN, TEST_EMAIL_DOMAIN } from '@lome-chat/shared';
import type { DevPersona } from '@lome-chat/shared';
import type { AppEnv } from '../types.js';

export function createDevRoute(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/personas', async (c) => {
    const db = c.get('db');
    const type = c.req.query('type') ?? 'dev';
    const emailDomain = type === 'test' ? TEST_EMAIL_DOMAIN : DEV_EMAIL_DOMAIN;

    const devUsers = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        image: users.image,
      })
      .from(users)
      .where(like(users.email, `%@${emailDomain}`));

    const personas: DevPersona[] = await Promise.all(
      devUsers.map(async (user) => {
        const [convCount] = await db
          .select({ count: count() })
          .from(conversations)
          .where(eq(conversations.userId, user.id));

        const [msgCount] = await db
          .select({ count: count() })
          .from(messages)
          .innerJoin(conversations, eq(messages.conversationId, conversations.id))
          .where(eq(conversations.userId, user.id));

        const [projCount] = await db
          .select({ count: count() })
          .from(projects)
          .where(eq(projects.userId, user.id));

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          image: user.image,
          stats: {
            conversationCount: convCount?.count ?? 0,
            messageCount: msgCount?.count ?? 0,
            projectCount: projCount?.count ?? 0,
          },
          credits: '$0.00',
        };
      })
    );

    return c.json({ personas });
  });

  app.delete('/test-data', async (c) => {
    const db = c.get('db');

    // Find all test persona users using existing constant
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `%@${TEST_EMAIL_DOMAIN}`));

    const testUserIds = testUsers.map((u) => u.id);

    if (testUserIds.length === 0) {
      return c.json({ success: true, deleted: { conversations: 0, messages: 0 } });
    }

    // Get conversation IDs for test users
    const testConvs = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.userId, testUserIds));

    const convIds = testConvs.map((conv) => conv.id);

    let deletedMessages = 0;
    let deletedConversations = 0;

    if (convIds.length > 0) {
      // Delete messages first (FK constraint)
      const msgResult = await db.delete(messages).where(inArray(messages.conversationId, convIds));
      deletedMessages = msgResult.rowCount ?? 0;

      // Delete conversations
      const convResult = await db.delete(conversations).where(inArray(conversations.id, convIds));
      deletedConversations = convResult.rowCount ?? 0;
    }

    return c.json({
      success: true,
      deleted: { conversations: deletedConversations, messages: deletedMessages },
    });
  });

  return app;
}
