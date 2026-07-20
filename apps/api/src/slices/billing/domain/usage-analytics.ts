import { z } from 'zod';
import { trimPage } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { BillingStores } from '../ports/index.js';
import type {
  LedgerEntryKind,
  LedgerHistoryRow,
  UsageBreakdownRow,
  UsageConversationSpendRow,
  UsageCostByModelRow,
  UsageGranularity,
  UsageSpendingBucket,
  UsageSummaryRow,
  UsageTokenBucket,
} from '../ports/stores.js';

/**
 * The billing usage-analytics read layer: a session-scoped, keyset-paginated
 * per-model spend breakdown over `usage_records`. The aggregation groups the
 * caller's rows by `modelId` (`SUM(cost)` + record/estimated counts). Money
 * stays nano-USD bigint here; the route serializes it as a NanoUSD string at
 * the JSON boundary.
 */

export const DEFAULT_USAGE_PAGE_LIMIT = 50;

export const usageBreakdownQuerySchema = z.object({
  // The cursor is the previous page's last modelId — a plain string, not a uuid.
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export interface UsageBreakdownResult {
  readonly models: readonly UsageBreakdownRow[];
  /** The last model id of this page when a further page exists, else null. */
  readonly nextCursor: string | null;
}

export function readUsageBreakdown(
  stores: BillingStores,
  db: Database,
  params: { readonly userId: string; readonly limit?: number; readonly cursor?: string }
): ResultAsync<UsageBreakdownResult, DomainError> {
  const limit = params.limit ?? DEFAULT_USAGE_PAGE_LIMIT;
  return stores
    .aggregateUsageByModel(db, {
      userId: params.userId,
      // One extra row probes for a further page without a second query.
      limit: limit + 1,
      ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
    })
    .map((rows) => {
      const { page: models, hasMore } = trimPage(rows, limit);
      const last = models.at(-1);
      return {
        models,
        nextCursor: hasMore && last !== undefined ? last.modelId : null,
      };
    });
}

/** The default page size for the paginated ledger transaction history. */
export const DEFAULT_TRANSACTIONS_PAGE_LIMIT = 50;

/** A caller-scoped analytics date range, from ISO `YYYY-MM-DD` day strings. */
export interface UsageDateRangeParams {
  readonly userId: string;
  readonly startDate: string;
  readonly endDate: string;
}

/**
 * Resolves the inclusive UTC day window an analytics query spans: the start of
 * `startDate` through the last millisecond of `endDate`. Matches the legacy
 * usage surface, which bounded `createdAt` to whole UTC days.
 */
function usageWindow(params: UsageDateRangeParams): { readonly start: Date; readonly end: Date } {
  return {
    start: new Date(`${params.startDate}T00:00:00.000Z`),
    end: new Date(`${params.endDate}T23:59:59.999Z`),
  };
}

/** KPI totals over the caller's language generations in the date range. */
export function readUsageSummary(
  stores: BillingStores,
  db: Database,
  params: UsageDateRangeParams
): ResultAsync<UsageSummaryRow, DomainError> {
  return stores.summarizeUsage(db, { userId: params.userId, ...usageWindow(params) });
}

/** The (period, model) spend series, optionally narrowed to one model. */
export function readSpendingOverTime(
  stores: BillingStores,
  db: Database,
  params: UsageDateRangeParams & { readonly granularity: UsageGranularity; readonly model?: string }
): ResultAsync<readonly UsageSpendingBucket[], DomainError> {
  return stores.usageSpendingOverTime(db, {
    userId: params.userId,
    ...usageWindow(params),
    granularity: params.granularity,
    ...(params.model === undefined ? {} : { modelId: params.model }),
  });
}

/** The per-(model, provider) spend + token breakdown, priciest first. */
export function readCostByModel(
  stores: BillingStores,
  db: Database,
  params: UsageDateRangeParams
): ResultAsync<readonly UsageCostByModelRow[], DomainError> {
  return stores.usageCostByModel(db, { userId: params.userId, ...usageWindow(params) });
}

/** The token-count series over time, optionally narrowed to one model. */
export function readTokenUsageOverTime(
  stores: BillingStores,
  db: Database,
  params: UsageDateRangeParams & { readonly granularity: UsageGranularity; readonly model?: string }
): ResultAsync<readonly UsageTokenBucket[], DomainError> {
  return stores.usageTokensOverTime(db, {
    userId: params.userId,
    ...usageWindow(params),
    granularity: params.granularity,
    ...(params.model === undefined ? {} : { modelId: params.model }),
  });
}

/** The caller's top-spend conversations in the range (spend desc, capped). */
export function readSpendingByConversation(
  stores: BillingStores,
  db: Database,
  params: UsageDateRangeParams & { readonly limit: number }
): ResultAsync<readonly UsageConversationSpendRow[], DomainError> {
  return stores.usageSpendingByConversation(db, {
    userId: params.userId,
    ...usageWindow(params),
    limit: params.limit,
  });
}

/** The caller's user-wallet ledger legs across the range, oldest first. */
export function readBalanceHistory(
  stores: BillingStores,
  db: Database,
  params: UsageDateRangeParams & { readonly limit: number }
): ResultAsync<readonly LedgerHistoryRow[], DomainError> {
  return stores.readLedgerHistory(db, {
    userId: params.userId,
    ...usageWindow(params),
    limit: params.limit,
  });
}

/** The distinct model ids the caller has ever used, ascending. */
export function readUsageModels(
  stores: BillingStores,
  db: Database,
  userId: string
): ResultAsync<readonly string[], DomainError> {
  return stores.distinctUsageModels(db, userId);
}

/** One transaction-history row (money as bigint; the route serializes it). */
export interface LedgerTransactionView {
  readonly id: string;
  readonly amountNanoUsd: bigint;
  readonly balanceAfterNanoUsd: bigint;
  readonly kind: LedgerEntryKind;
  readonly paymentId: string | null;
  readonly createdAt: Date;
}

export interface LedgerTransactionsPage {
  readonly transactions: readonly LedgerTransactionView[];
  /** ISO createdAt of the last row when a further page exists, else null. */
  readonly nextCursor: string | null;
}

/**
 * The caller's paginated ledger transaction history over user-wallet legs
 * (newest first). Cursor is the previous page's last `createdAt` (exclusive);
 * `offset` and a `kind` filter are supported.
 */
export function readLedgerTransactions(
  stores: BillingStores,
  db: Database,
  params: {
    readonly userId: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly offset?: number;
    readonly kind?: LedgerEntryKind;
  }
): ResultAsync<LedgerTransactionsPage, DomainError> {
  const limit = params.limit ?? DEFAULT_TRANSACTIONS_PAGE_LIMIT;
  return stores
    .listLedgerTransactions(db, {
      userId: params.userId,
      // One extra row probes for a further page without a second query.
      limit: limit + 1,
      ...(params.cursor === undefined ? {} : { cursor: new Date(params.cursor) }),
      ...(params.offset === undefined ? {} : { offset: params.offset }),
      ...(params.kind === undefined ? {} : { kind: params.kind }),
    })
    .map((rows) => {
      const { page, hasMore } = trimPage(rows, limit);
      const last = page.at(-1);
      return {
        transactions: page.map((row) => ({
          id: row.id,
          amountNanoUsd: row.amountNanoUsd,
          balanceAfterNanoUsd: row.balanceAfterNanoUsd,
          kind: row.kind,
          paymentId: row.paymentId,
          createdAt: row.createdAt,
        })),
        nextCursor: hasMore && last !== undefined ? last.createdAt.toISOString() : null,
      };
    });
}
