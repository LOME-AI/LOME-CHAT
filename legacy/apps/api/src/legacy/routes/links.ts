import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { epochs, sharedLinks } from '@hushbox/db';
import {
  ERROR_CODE_LINK_NOT_FOUND,
  ERROR_CODE_EPOCH_NOT_FOUND,
  ERROR_CODE_MEMBER_LIMIT_REACHED,
  MAX_CONVERSATION_MEMBERS,
  toBase64,
  fromBase64,
  rotationSchema,
} from '@hushbox/shared';
import { createEvent } from '@hushbox/realtime/events';
import { toRotationParams, handleRotationError } from '../services/keys/keys.js';
import { requirePrivilege, requireLinkGuest } from '../middleware/index.js';
import { createErrorResponse } from '../lib/error-response.js';
import { broadcastFireAndForget } from '../lib/broadcast.js';
import { listLinks, createLink, revokeLink, changeLinkPrivilege } from '../services/links/index.js';
import type { AppEnv } from '../types.js';

export const linksRoute = new Hono<AppEnv>()
  .get(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read', { allowLinkGuest: true }),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');

      const links = await listLinks(db, conversationId);

      return c.json(
        {
          links: links.map((link) => ({
            id: link.id,
            linkPublicKey: toBase64(link.linkPublicKey),
            privilege: link.privilege,
            displayName: link.displayName,
            createdAt: link.createdAt.toISOString(),
          })),
        },
        200
      );
    }
  )
  .post(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('admin'),
    zValidator(
      'json',
      z
        .object({
          linkPublicKey: z.string(),
          memberWrap: z.string(),
          privilege: z.string(),
          giveFullHistory: z.boolean(),
          displayName: z.string().min(1).max(100).optional(),
          rotation: rotationSchema.optional(),
        })
        .refine((d) => d.giveFullHistory || d.rotation !== undefined, {
          message: 'rotation required when giveFullHistory is false',
        })
    ),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const body = c.req.valid('json');

      const currentEpoch = await db
        .select({
          id: epochs.id,
          epochNumber: epochs.epochNumber,
          memberCount: sql<number>`(
            SELECT count(*)::int FROM conversation_members
            WHERE conversation_id = ${conversationId} AND left_at IS NULL
          )`,
        })
        .from(epochs)
        .where(eq(epochs.conversationId, conversationId))
        .orderBy(desc(epochs.epochNumber))
        .limit(1)
        .then((rows) => rows[0]);

      if (!currentEpoch) {
        return c.json(createErrorResponse(ERROR_CODE_EPOCH_NOT_FOUND), 404);
      }

      if (currentEpoch.memberCount >= MAX_CONVERSATION_MEMBERS) {
        return c.json(createErrorResponse(ERROR_CODE_MEMBER_LIMIT_REACHED), 400);
      }

      let visibleFromEpoch: number;
      if (body.giveFullHistory) {
        visibleFromEpoch = 1;
      } else {
        if (!body.rotation) {
          throw new Error('invariant: rotation required when giveFullHistory is false');
        }
        visibleFromEpoch = body.rotation.expectedEpoch + 1;
      }

      try {
        const result = await createLink(db, {
          conversationId,
          linkPublicKey: fromBase64(body.linkPublicKey),
          memberWrap: fromBase64(body.memberWrap),
          privilege: body.privilege,
          visibleFromEpoch,
          currentEpochId: currentEpoch.id,
          ...(body.displayName !== undefined && { displayName: body.displayName }),
          ...(body.rotation !== undefined && {
            rotation: toRotationParams(conversationId, body.rotation),
          }),
        });

        if (body.rotation) {
          broadcastFireAndForget(
            c.env,
            conversationId,
            createEvent('rotation:complete', {
              conversationId,
              newEpochNumber: body.rotation.expectedEpoch + 1,
            })
          );
        }

        return c.json({ linkId: result.linkId, memberId: result.memberId }, 201);
      } catch (error) {
        return handleRotationError(error, c);
      }
    }
  )
  .post(
    '/:conversationId/revoke',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('admin'),
    zValidator(
      'json',
      z.object({
        linkId: z.string(),
        rotation: rotationSchema,
      })
    ),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { linkId, rotation } = c.req.valid('json');

      const rotationParams = toRotationParams(conversationId, rotation);

      try {
        const result = await revokeLink(db, linkId, conversationId, rotationParams);

        if (!result.revoked) {
          return c.json(createErrorResponse(ERROR_CODE_LINK_NOT_FOUND), 404);
        }

        if (result.memberId) {
          broadcastFireAndForget(
            c.env,
            conversationId,
            createEvent('member:removed', {
              conversationId,
              memberId: result.memberId,
            })
          );
        }

        broadcastFireAndForget(
          c.env,
          conversationId,
          createEvent('rotation:complete', {
            conversationId,
            newEpochNumber: rotation.expectedEpoch + 1,
          })
        );

        return c.json({ revoked: true }, 200);
      } catch (error) {
        return handleRotationError(error, c);
      }
    }
  )
  .patch(
    '/:conversationId/:linkId/privilege',
    zValidator('param', z.object({ conversationId: z.string(), linkId: z.string() })),
    requirePrivilege('admin'),
    zValidator('json', z.object({ privilege: z.enum(['read', 'write']) })),
    async (c) => {
      const db = c.get('db');
      const { conversationId, linkId } = c.req.valid('param');
      const { privilege } = c.req.valid('json');

      const result = await changeLinkPrivilege(db, { conversationId, linkId, privilege });

      if (!result.changed) {
        return c.json(createErrorResponse(ERROR_CODE_LINK_NOT_FOUND), 404);
      }

      if (result.memberId) {
        broadcastFireAndForget(
          c.env,
          conversationId,
          createEvent('member:privilege-changed', {
            conversationId,
            memberId: result.memberId,
            privilege,
          })
        );
      }

      return c.json({ changed: true }, 200);
    }
  )
  .patch(
    '/:conversationId/:linkId/name',
    zValidator('param', z.object({ conversationId: z.string(), linkId: z.string() })),
    requirePrivilege('admin'),
    zValidator('json', z.object({ displayName: z.string().min(1).max(100) })),
    async (c) => {
      const db = c.get('db');
      const { linkId } = c.req.valid('param');
      const { displayName } = c.req.valid('json');

      const link = await db
        .select({ id: sharedLinks.id })
        .from(sharedLinks)
        .where(and(eq(sharedLinks.id, linkId), isNull(sharedLinks.revokedAt)))
        .limit(1)
        .then((rows) => rows[0]);

      if (!link) {
        return c.json(createErrorResponse(ERROR_CODE_LINK_NOT_FOUND), 404);
      }

      await db.update(sharedLinks).set({ displayName }).where(eq(sharedLinks.id, linkId));

      return c.json({ success: true }, 200);
    }
  )
  .patch(
    '/:conversationId/my-name',
    zValidator('param', z.object({ conversationId: z.string() })),
    requireLinkGuest(),
    zValidator('json', z.object({ displayName: z.string().min(1).max(100) })),
    async (c) => {
      const db = c.get('db');
      const linkGuest = c.get('linkGuest');
      if (!linkGuest) throw new Error('Link guest required after requireLinkGuest');
      const { displayName } = c.req.valid('json');

      await db.update(sharedLinks).set({ displayName }).where(eq(sharedLinks.id, linkGuest.linkId));

      return c.json({ success: true }, 200);
    }
  );
