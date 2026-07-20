import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import { conversationMembers } from '@hushbox/db';
import {
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_SERVICE_UNAVAILABLE,
  ERROR_CODE_CONVERSATION_NOT_FOUND,
} from '@hushbox/shared';
import { resolveLinkGuest } from '../middleware/resolve-link-guest.js';
import { createErrorResponse } from '../lib/error-response.js';
import type { AppEnv } from '../types.js';

export const websocketRoute = new Hono<AppEnv>().get(
  '/:conversationId',
  zValidator('param', z.object({ conversationId: z.string() })),
  async (c) => {
    const user = c.get('user');
    const { conversationId } = c.req.valid('param');
    const db = c.get('db');

    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- internal DO routing, host is ignored
    const upgradeUrl = new URL('http://internal/websocket');

    if (user) {
      // Authenticated user path
      const member = await db
        .select({ id: conversationMembers.id, privilege: conversationMembers.privilege })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, user.id),
            isNull(conversationMembers.leftAt)
          )
        )
        .limit(1)
        .then((rows) => rows[0]);

      if (!member) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }

      upgradeUrl.searchParams.set('userId', user.id);
    } else {
      // Link guest path — resolve via query param or header
      const linkGuest = await resolveLinkGuest(c);
      if (!linkGuest) {
        return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
      }

      upgradeUrl.searchParams.set('userId', linkGuest.linkId);
      upgradeUrl.searchParams.set('guest', 'true');
      if (linkGuest.displayName) {
        upgradeUrl.searchParams.set('name', linkGuest.displayName);
      }
    }

    const doBinding = c.env.CONVERSATION_ROOM;
    if (!doBinding) {
      return c.json(createErrorResponse(ERROR_CODE_SERVICE_UNAVAILABLE), 503);
    }

    const id = doBinding.idFromName(conversationId);
    const stub = doBinding.get(id);

    return stub.fetch(
      new Request(upgradeUrl.toString(), {
        headers: c.req.raw.headers,
      })
    );
  }
);
