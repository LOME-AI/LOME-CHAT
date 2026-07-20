import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { conversations } from '@hushbox/db';
import { effectiveBudgetCents, ERROR_CODE_CONVERSATION_NOT_FOUND } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { requirePrivilege } from '../middleware/index.js';
import {
  getConversationBudgets,
  updateMemberBudget,
  updateConversationBudget,
  computeGroupRemaining,
} from '../services/billing/budgets.js';
import { getUserTierInfo } from '../services/billing/balance.js';
import { getGroupReservedTotals } from '../lib/speculative-balance.js';
import type { AppEnv } from '../types.js';

export const budgetsRoute = new Hono<AppEnv>()
  .get(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read', { allowLinkGuest: true }),
    async (c) => {
      const db = c.get('db');
      const redis = c.get('redis');
      const { conversationId } = c.req.valid('param');
      const member = c.get('members').get(conversationId);
      if (!member) throw new Error('Member required after requirePrivilege');

      const result = await getConversationBudgets(db, conversationId);

      const convRow = await db
        .select({ userId: conversations.userId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1)
        .then((rows) => rows[0]);

      if (!convRow) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }
      const ownerId = convRow.userId;

      const [ownerTierInfo, reserved] = await Promise.all([
        getUserTierInfo(db, ownerId),
        getGroupReservedTotals(redis, conversationId, member.id, ownerId),
      ]);

      const currentMemberBudget = result.memberBudgets.find((mb) => mb.memberId === member.id);

      // Exclude the conversation owner from the member budgets response —
      // the owner funds all budgets and doesn't need a personal spending limit.
      const filteredMemberBudgets = result.memberBudgets.filter((mb) => mb.privilege !== 'owner');

      const groupRemaining = computeGroupRemaining({
        conversationBudget: result.conversationBudget,
        conversationSpent: result.totalSpent,
        memberBudget: currentMemberBudget?.budget ?? '0.00',
        memberSpent: currentMemberBudget?.spent ?? '0',
        ownerBalanceCents: ownerTierInfo.balanceCents,
        reserved,
      });

      const effective = effectiveBudgetCents(groupRemaining);

      return c.json(
        {
          conversationBudget: result.conversationBudget,
          totalSpent: result.totalSpent,
          memberBudgets: filteredMemberBudgets,
          effectiveDollars: effective / 100,
          ownerTier: ownerTierInfo.tier,
          ownerBalanceDollars: ownerTierInfo.balanceCents / 100,
          memberBudgetDollars: Number.parseFloat(currentMemberBudget?.budget ?? '0.00'),
        },
        200
      );
    }
  )
  .patch(
    '/:conversationId/member/:memberId',
    zValidator('param', z.object({ conversationId: z.string(), memberId: z.string() })),
    requirePrivilege('admin'),
    zValidator(
      'json',
      z.object({
        budgetCents: z.number().int().min(0),
      })
    ),
    async (c) => {
      const db = c.get('db');
      const { memberId } = c.req.valid('param');
      const { budgetCents } = c.req.valid('json');

      await updateMemberBudget(db, memberId, budgetCents);

      return c.json({ updated: true }, 200);
    }
  )
  .patch(
    '/:conversationId/budget',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('owner'),
    zValidator(
      'json',
      z.object({
        budgetCents: z.number().int().min(0),
      })
    ),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { budgetCents } = c.req.valid('json');

      await updateConversationBudget(db, conversationId, budgetCents);

      return c.json({ updated: true }, 200);
    }
  );
