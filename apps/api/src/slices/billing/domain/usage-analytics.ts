import { z } from 'zod';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { BillingStores } from '../ports/index.js';
import type { UsageBreakdownRow } from '../ports/stores.js';

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
      const hasMore = rows.length > limit;
      const models = hasMore ? rows.slice(0, limit) : rows;
      const last = models.at(-1);
      return {
        models,
        nextCursor: hasMore && last !== undefined ? last.modelId : null,
      };
    });
}
