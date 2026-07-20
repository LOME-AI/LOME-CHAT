import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import { fromBase64, ERROR_CODE_UNAUTHORIZED, ERROR_CODE_INVALID_BASE64 } from '@hushbox/shared';
import { searchUsers } from '../services/users/user-search.js';
import { createErrorResponse } from '../lib/error-response.js';
import type { AppEnv } from '../types.js';

export const usersRoute = new Hono<AppEnv>()
  .post(
    '/search',
    zValidator(
      'json',
      z.object({
        query: z.string().min(1).max(50),
        excludeConversationId: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
    ),
    async (c) => {
      const user = c.get('user');
      if (!user) {
        return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
      }

      const db = c.get('db');
      const { query, excludeConversationId, limit } = c.req.valid('json');

      const results = await searchUsers(db, query, user.id, {
        ...(excludeConversationId !== undefined && { excludeConversationId }),
        ...(limit !== undefined && { limit }),
      });

      return c.json({ users: results }, 200);
    }
  )
  .patch(
    '/custom-instructions',
    zValidator(
      'json',
      z.object({
        customInstructionsEncrypted: z.string().nullable(),
      })
    ),
    async (c) => {
      const user = c.get('user');
      if (!user) {
        return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
      }

      const { customInstructionsEncrypted } = c.req.valid('json');

      let bytea: Uint8Array | null = null;
      if (customInstructionsEncrypted !== null) {
        try {
          bytea = fromBase64(customInstructionsEncrypted);
        } catch {
          return c.json(createErrorResponse(ERROR_CODE_INVALID_BASE64), 400);
        }
      }

      const db = c.get('db');
      await db
        .update(users)
        .set({ customInstructionsEncrypted: bytea })
        .where(eq(users.id, user.id));

      return c.json({ success: true }, 200);
    }
  );
