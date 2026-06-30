import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  createForkRequestSchema,
  renameForkRequestSchema,
  ERROR_CODE_FORK_NAME_TAKEN,
  ERROR_CODE_FORK_LIMIT_REACHED,
} from '@hushbox/shared';
import { createEvent } from '@hushbox/realtime/events';
import { requirePrivilege } from '../middleware/index.js';
import { createErrorResponse } from '../lib/error-response.js';
import { createFork, deleteFork, renameFork, ForkError } from '../services/forks/forks.js';
import { broadcastFireAndForget } from '../lib/broadcast.js';
import type { AppEnv } from '../types.js';

function mapForkError(error: ForkError): { status: 409 | 400; code: string } {
  switch (error.code) {
    case ERROR_CODE_FORK_NAME_TAKEN: {
      return { status: 409, code: error.code };
    }
    case ERROR_CODE_FORK_LIMIT_REACHED: {
      return { status: 400, code: error.code };
    }
    default: {
      return { status: 400, code: error.code };
    }
  }
}

export const forksRoute = new Hono<AppEnv>()
  .post(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('write'),
    zValidator('json', createForkRequestSchema),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { id, fromMessageId, name } = c.req.valid('json');

      try {
        const result = await createFork(db, {
          id,
          conversationId,
          fromMessageId,
          ...(name !== undefined && { name }),
        });

        const forks = result.forks.map((f) => ({
          id: f.id,
          conversationId: f.conversationId,
          name: f.name,
          tipMessageId: f.tipMessageId,
          createdAt: f.createdAt.toISOString(),
        }));

        const status = result.isNew ? 201 : 200;

        if (result.isNew) {
          const newFork = forks.find((f) => f.id === id);
          if (newFork) {
            broadcastFireAndForget(
              c.env,
              conversationId,
              createEvent('fork:created', {
                forkId: id,
                conversationId,
                name: newFork.name,
                tipMessageId: newFork.tipMessageId,
              })
            );
          }
        }

        return c.json({ forks, isNew: result.isNew }, status);
      } catch (error) {
        if (error instanceof ForkError) {
          const { status, code } = mapForkError(error);
          return c.json(createErrorResponse(code), status);
        }
        throw error;
      }
    }
  )
  .patch(
    '/:conversationId/:forkId',
    zValidator('param', z.object({ conversationId: z.string(), forkId: z.string() })),
    requirePrivilege('write'),
    zValidator('json', renameForkRequestSchema),
    async (c) => {
      const db = c.get('db');
      const { conversationId, forkId } = c.req.valid('param');
      const { name } = c.req.valid('json');

      try {
        await renameFork(db, { forkId, conversationId, name });

        broadcastFireAndForget(
          c.env,
          conversationId,
          createEvent('fork:renamed', { forkId, conversationId, name })
        );

        return c.json({ renamed: true }, 200);
      } catch (error) {
        if (error instanceof ForkError) {
          const { status, code } = mapForkError(error);
          return c.json(createErrorResponse(code), status);
        }
        throw error;
      }
    }
  )
  .delete(
    '/:conversationId/:forkId',
    zValidator('param', z.object({ conversationId: z.string(), forkId: z.string() })),
    requirePrivilege('write'),
    async (c) => {
      const db = c.get('db');
      const { conversationId, forkId } = c.req.valid('param');

      const result = await deleteFork(db, { conversationId, forkId });

      broadcastFireAndForget(
        c.env,
        conversationId,
        createEvent('fork:deleted', { forkId, conversationId })
      );

      return c.json({ remainingForks: result.remainingForks }, 200);
    }
  );
