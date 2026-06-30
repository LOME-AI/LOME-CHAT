import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  conversations,
  conversationMembers,
  memberBudgets,
  conversationSpending,
  type Database,
  type DatabaseClient,
} from '@hushbox/db';
import type { EffectiveBudgetParams } from '@hushbox/shared';
import type { GroupReservedTotals } from '../../lib/speculative-balance.js';

interface MemberBudgetRow {
  memberId: string;
  userId: string | null;
  linkId: string | null;
  privilege: string;
  budget: string | null;
  spent: string | null;
}

interface MemberBudgetResult {
  memberId: string;
  userId: string | null;
  linkId: string | null;
  privilege: string;
  /** Dollar string from DB. '0.00' when no member_budgets row exists (LEFT JOIN miss). */
  budget: string;
  /** Dollar string from DB. '0' when no member_budgets row exists (LEFT JOIN miss). */
  spent: string;
}

export interface ConversationBudgetsResult {
  /** Dollar string from conversations.conversation_budget (numeric(20,2)). */
  conversationBudget: string;
  /** Dollar string from conversation_spending.total_spent (numeric(20,8)). */
  totalSpent: string;
  memberBudgets: MemberBudgetResult[];
}

/**
 * Gets budget data for all active members in a conversation,
 * plus the total conversation spending.
 *
 * Returns raw dollar strings from the DB — no unit conversion.
 */
export async function getConversationBudgets(
  db: Database,
  conversationId: string
): Promise<ConversationBudgetsResult> {
  // Query 1: active members LEFT JOIN memberBudgets
  const rows: MemberBudgetRow[] = await db
    .select({
      memberId: conversationMembers.id,
      userId: conversationMembers.userId,
      linkId: conversationMembers.linkId,
      privilege: conversationMembers.privilege,
      budget: memberBudgets.budget,
      spent: memberBudgets.spent,
    })
    .from(conversationMembers)
    .leftJoin(memberBudgets, eq(memberBudgets.memberId, conversationMembers.id))
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        isNull(conversationMembers.leftAt)
      )
    );

  // Query 2: total conversation spending
  const spendingRows = await db
    .select({ totalSpent: conversationSpending.totalSpent })
    .from(conversationSpending)
    .where(eq(conversationSpending.conversationId, conversationId))
    .limit(1)
    .then((r) => r);

  const [spendingRow] = spendingRows;

  // Query 3: conversation budget
  const conversationRow = await db
    .select({ conversationBudget: conversations.conversationBudget })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
    .then((r) => r[0]);

  return {
    conversationBudget: conversationRow?.conversationBudget ?? '0.00',
    totalSpent: spendingRow?.totalSpent ?? '0',
    memberBudgets: rows.map((row) => ({
      memberId: row.memberId,
      userId: row.userId,
      linkId: row.linkId,
      privilege: row.privilege,
      budget: row.budget ?? '0.00',
      spent: row.spent ?? '0',
    })),
  };
}

/**
 * Upserts a member budget. Converts cents to dollars for DB storage.
 * Uses INSERT ... ON CONFLICT DO UPDATE for idempotent writes.
 */
export async function updateMemberBudget(
  db: Database,
  memberId: string,
  budgetCents: number
): Promise<void> {
  const budgetDollars = (budgetCents / 100).toFixed(2);

  await db
    .insert(memberBudgets)
    .values({ memberId, budget: budgetDollars })
    .onConflictDoUpdate({
      target: memberBudgets.memberId,
      set: { budget: budgetDollars },
    })
    .returning({ id: memberBudgets.id });
}

/**
 * Updates the conversation-level budget. Converts cents to dollars for DB storage.
 */
export async function updateConversationBudget(
  db: Database,
  conversationId: string,
  budgetCents: number
): Promise<void> {
  const budgetDollars = (budgetCents / 100).toFixed(2);

  await db
    .update(conversations)
    .set({ conversationBudget: budgetDollars })
    .where(eq(conversations.id, conversationId));
}

export interface UpdateGroupSpendingParams {
  conversationId: string;
  memberId: string;
  costDollars: string;
}

/**
 * Atomically increments spending counters for group billing.
 * Called inside the same transaction as chargeForUsage().
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE for both tables:
 * - conversation_spending: upserts totalSpent += cost
 * - member_budgets: upserts spent += cost (budget defaults to 0 on insert)
 */
export async function updateGroupSpending(
  tx: DatabaseClient,
  params: UpdateGroupSpendingParams
): Promise<void> {
  const { conversationId, memberId, costDollars } = params;

  await tx
    .insert(conversationSpending)
    .values({
      conversationId,
      totalSpent: costDollars,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: conversationSpending.conversationId,
      set: {
        totalSpent: sql`${conversationSpending.totalSpent} + ${costDollars}::numeric`,
        updatedAt: new Date(),
      },
    });

  await tx
    .insert(memberBudgets)
    .values({
      memberId,
      budget: '0.00',
      spent: costDollars,
    })
    .onConflictDoUpdate({
      target: memberBudgets.memberId,
      set: {
        spent: sql`${memberBudgets.spent} + ${costDollars}::numeric`,
      },
    });
}

/**
 * Computes remaining budget for each group constraint dimension
 * with Redis reserved cents subtracted.
 *
 * Budget and spending are dollar strings from the DB.
 * Converts to fractional cents at comparison point since Redis reservations are in cents.
 *
 * Shared between buildBillingInput (enforcement) and GET /api/budgets (display).
 */
export function computeGroupRemaining(params: {
  conversationBudget: string;
  conversationSpent: string;
  memberBudget: string;
  memberSpent: string;
  ownerBalanceCents: number;
  reserved: GroupReservedTotals;
}): EffectiveBudgetParams {
  return {
    conversationRemainingCents:
      Number.parseFloat(params.conversationBudget) * 100 -
      Number.parseFloat(params.conversationSpent) * 100 -
      params.reserved.conversationTotal,
    memberRemainingCents:
      Number.parseFloat(params.memberBudget) * 100 -
      Number.parseFloat(params.memberSpent) * 100 -
      params.reserved.memberTotal,
    ownerRemainingCents: params.ownerBalanceCents - params.reserved.payerTotal,
  };
}
