import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { deviceTokens } from '@hushbox/db';
import { requireAuth } from '../middleware/require-auth.js';
import { getUser } from '../lib/get-user.js';
import type { AppEnv } from '../types.js';

export const deviceTokensRoute = new Hono<AppEnv>()
  .use('*', requireAuth())
  .post(
    '/',
    zValidator(
      'json',
      z.object({
        token: z.string().min(1),
        platform: z.enum(['ios', 'android']),
      })
    ),
    async (c) => {
      const db = c.get('db');
      const user = getUser(c);
      const { token, platform } = c.req.valid('json');

      await db
        .insert(deviceTokens)
        .values({
          userId: user.id,
          token,
          platform,
        })
        .onConflictDoUpdate({
          target: deviceTokens.token,
          set: {
            userId: user.id,
            platform,
            updatedAt: new Date(),
          },
        })
        .returning();

      return c.json({ registered: true }, 201);
    }
  )
  .delete('/:token', zValidator('param', z.object({ token: z.string() })), async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    if (!user) throw new Error('requireAuth must set user');
    const { token } = c.req.valid('param');

    await db
      .delete(deviceTokens)
      .where(and(eq(deviceTokens.token, token), eq(deviceTokens.userId, user.id)));

    return c.json({ deleted: true }, 200);
  });
