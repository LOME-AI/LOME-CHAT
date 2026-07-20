import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and, gte, lte, desc, sql, asc, type Column } from 'drizzle-orm';
import { usageRecords, llmCompletions, wallets, ledgerEntries } from '@hushbox/db';
import {
  usageDateRangeQuerySchema,
  usageTimeSeriesQuerySchema,
  usageConversationQuerySchema,
  usageBalanceHistoryQuerySchema,
} from '@hushbox/shared';
import { requireAuth } from '../middleware/require-auth.js';
import { getUser } from '../lib/get-user.js';
import type { AppEnv } from '../types.js';

function toStartOfDay(dateString: string): Date {
  return new Date(`${dateString}T00:00:00.000Z`);
}

function toEndOfDay(dateString: string): Date {
  return new Date(`${dateString}T23:59:59.999Z`);
}

/**
 * Build a date_trunc SQL expression using raw granularity.
 * Safe because granularity is validated by Zod to be 'day' | 'week'.
 */
function dateTrunc(granularity: string, column: Column): ReturnType<typeof sql> {
  return sql`date_trunc('${sql.raw(granularity)}', ${column})`;
}

interface SummaryResult {
  totalSpent: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
}

const EMPTY_SUMMARY: SummaryResult = {
  totalSpent: '0',
  messageCount: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCachedTokens: 0,
};

function buildSummaryResponse(result: Partial<SummaryResult> | undefined): SummaryResult {
  if (!result) return { ...EMPTY_SUMMARY };
  return { ...EMPTY_SUMMARY, ...result };
}

function parseDateRange(query: { startDate: string; endDate: string }): { start: Date; end: Date } {
  return { start: toStartOfDay(query.startDate), end: toEndOfDay(query.endDate) };
}

function buildUsageConditions(
  userId: string,
  start: Date,
  end: Date,
  model?: string
): ReturnType<typeof eq>[] {
  const conditions = [
    eq(usageRecords.userId, userId),
    eq(usageRecords.status, 'completed'),
    gte(usageRecords.createdAt, start),
    lte(usageRecords.createdAt, end),
  ];
  if (model) {
    conditions.push(eq(llmCompletions.model, model));
  }
  return conditions;
}

export const usageRoute = new Hono<AppEnv>()
  .use('*', requireAuth())

  .get('/summary', zValidator('query', usageDateRangeQuerySchema), async (c) => {
    const user = getUser(c);
    const db = c.get('db');
    const query = c.req.valid('query');
    const { start, end } = parseDateRange(query);

    const conditions = buildUsageConditions(user.id, start, end);

    const [result] = await db
      .select({
        totalSpent: sql<string>`coalesce(sum(${usageRecords.cost}::numeric), 0)::text`,
        messageCount: sql<number>`count(*)::int`,
        totalInputTokens: sql<number>`coalesce(sum(${llmCompletions.inputTokens}), 0)::int`,
        totalOutputTokens: sql<number>`coalesce(sum(${llmCompletions.outputTokens}), 0)::int`,
        totalCachedTokens: sql<number>`coalesce(sum(${llmCompletions.cachedTokens}), 0)::int`,
      })
      .from(usageRecords)
      .innerJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
      .where(and(...conditions));

    return c.json(buildSummaryResponse(result), 200);
  })

  .get('/spending-over-time', zValidator('query', usageTimeSeriesQuerySchema), async (c) => {
    const user = getUser(c);
    const db = c.get('db');
    const query = c.req.valid('query');
    const { start, end } = parseDateRange(query);
    const granularity = query.granularity;

    const conditions = buildUsageConditions(user.id, start, end, query.model);
    const truncExpr = dateTrunc(granularity, usageRecords.createdAt);

    const data = await db
      .select({
        period: sql<string>`${truncExpr}::text`,
        model: llmCompletions.model,
        totalCost: sql<string>`sum(${usageRecords.cost}::numeric)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(usageRecords)
      .innerJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
      .where(and(...conditions))
      .groupBy(truncExpr, llmCompletions.model)
      .orderBy(asc(truncExpr));

    return c.json({ data }, 200);
  })

  .get('/cost-by-model', zValidator('query', usageDateRangeQuerySchema), async (c) => {
    const user = getUser(c);
    const db = c.get('db');
    const query = c.req.valid('query');
    const { start, end } = parseDateRange(query);

    const conditions = buildUsageConditions(user.id, start, end);

    const data = await db
      .select({
        model: llmCompletions.model,
        provider: llmCompletions.provider,
        totalCost: sql<string>`sum(${usageRecords.cost}::numeric)::text`,
        messageCount: sql<number>`count(*)::int`,
        totalInputTokens: sql<number>`sum(${llmCompletions.inputTokens})::int`,
        totalOutputTokens: sql<number>`sum(${llmCompletions.outputTokens})::int`,
      })
      .from(usageRecords)
      .innerJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
      .where(and(...conditions))
      .groupBy(llmCompletions.model, llmCompletions.provider)
      .orderBy(desc(sql`sum(${usageRecords.cost}::numeric)`));

    return c.json({ data }, 200);
  })

  .get('/token-usage-over-time', zValidator('query', usageTimeSeriesQuerySchema), async (c) => {
    const user = getUser(c);
    const db = c.get('db');
    const query = c.req.valid('query');
    const { start, end } = parseDateRange(query);
    const granularity = query.granularity;

    const conditions = buildUsageConditions(user.id, start, end, query.model);
    const truncExpr = dateTrunc(granularity, usageRecords.createdAt);

    const data = await db
      .select({
        period: sql<string>`${truncExpr}::text`,
        inputTokens: sql<number>`sum(${llmCompletions.inputTokens})::int`,
        outputTokens: sql<number>`sum(${llmCompletions.outputTokens})::int`,
        cachedTokens: sql<number>`sum(${llmCompletions.cachedTokens})::int`,
      })
      .from(usageRecords)
      .innerJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
      .where(and(...conditions))
      .groupBy(truncExpr)
      .orderBy(asc(truncExpr));

    return c.json({ data }, 200);
  })

  .get(
    '/spending-by-conversation',
    zValidator('query', usageConversationQuerySchema),
    async (c) => {
      const user = getUser(c);
      const db = c.get('db');
      const query = c.req.valid('query');
      const { start, end } = parseDateRange(query);

      const data = await db
        .select({
          conversationId: usageRecords.sourceId,
          totalSpent: sql<string>`sum(${usageRecords.cost}::numeric)::text`,
        })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.userId, user.id),
            eq(usageRecords.status, 'completed'),
            eq(usageRecords.sourceType, 'conversation'),
            gte(usageRecords.createdAt, start),
            lte(usageRecords.createdAt, end)
          )
        )
        .groupBy(usageRecords.sourceId)
        .orderBy(desc(sql`sum(${usageRecords.cost}::numeric)`))
        .limit(query.limit);

      return c.json({ data }, 200);
    }
  )

  .get('/balance-history', zValidator('query', usageBalanceHistoryQuerySchema), async (c) => {
    const user = getUser(c);
    const db = c.get('db');
    const query = c.req.valid('query');
    const { start, end } = parseDateRange(query);

    const data = await db
      .select({
        createdAt: sql<string>`${ledgerEntries.createdAt}::text`,
        balanceAfter: ledgerEntries.balanceAfter,
        entryType: ledgerEntries.entryType,
        amount: ledgerEntries.amount,
      })
      .from(ledgerEntries)
      .innerJoin(wallets, eq(ledgerEntries.walletId, wallets.id))
      .where(
        and(
          eq(wallets.userId, user.id),
          gte(ledgerEntries.createdAt, start),
          lte(ledgerEntries.createdAt, end)
        )
      )
      .orderBy(asc(ledgerEntries.createdAt))
      .limit(query.limit);

    return c.json({ data }, 200);
  })

  .get('/models', async (c) => {
    const user = getUser(c);
    const db = c.get('db');

    const results = await db
      .selectDistinct({ model: llmCompletions.model })
      .from(llmCompletions)
      .innerJoin(usageRecords, eq(llmCompletions.usageRecordId, usageRecords.id))
      .where(and(eq(usageRecords.userId, user.id), eq(usageRecords.status, 'completed')))
      .orderBy(asc(llmCompletions.model));

    return c.json({ models: results.map((r) => r.model) }, 200);
  });
