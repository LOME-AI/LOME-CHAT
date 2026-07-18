import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { publicStatsSnapshots, usageRecords } from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { UsageStatsTrendBucket } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { GlobalUsageWindowQuery, PublicStatsStores } from '../ports/public-stats.js';
import type { SQL } from 'drizzle-orm';

/** One mapper for every read query: infra rejections become `unavailable`. */
function storeFailure(cause: unknown): DomainError {
  return unavailableError('public-stats store query failed', cause);
}

/**
 * The global (unscoped) usage window: one modality, half-open `[start, end)`
 * on createdAt. Deliberately has NO userId conjunct — these aggregates feed
 * the anonymized public stats, and the raw counts they return never leave
 * `buildPublicUsageStats`.
 */
function globalWindow(query: GlobalUsageWindowQuery): SQL | undefined {
  const conditions = [
    eq(usageRecords.modality, query.modality),
    lt(usageRecords.createdAt, query.end),
  ];
  if (query.start !== null) conditions.push(gte(usageRecords.createdAt, query.start));
  return and(...conditions);
}

/**
 * A UTC bucket start as an ISO date string. The bucket is a closed
 * `'day' | 'month'` union from the shared windows constant, never
 * client-freeform, so interpolating it as raw SQL cannot inject.
 */
function bucketStartExpr(bucket: UsageStatsTrendBucket): SQL<string> {
  return sql<string>`date_trunc('${sql.raw(bucket)}', ${usageRecords.createdAt})::date::text`;
}

export function createPublicStatsStores(): PublicStatsStores {
  return {
    aggregateGlobalUsageByModel(db: Database, query) {
      return fromPromise(
        db
          .select({
            modelId: usageRecords.modelId,
            messageCount: sql<number>`count(*)`.mapWith(Number),
            // Money stays bigint — never Number()-coerced.
            costNanoUsd: sql<bigint>`sum(${usageRecords.costNanoUsd})`.mapWith(BigInt),
          })
          .from(usageRecords)
          .where(globalWindow(query))
          .groupBy(usageRecords.modelId)
          .orderBy(usageRecords.modelId),
        storeFailure
      );
    },

    readGlobalCostPercentiles(db: Database, query) {
      // percentile_cont interpolates to double precision — a display
      // statistic for the public page, never settlement math (which stays
      // bigint). NULL (no rows in the window) maps to null.
      return fromPromise(
        db
          .select({
            medianNanoUsd: sql<
              number | null
            >`percentile_cont(0.5) within group (order by ${usageRecords.costNanoUsd})`,
            p90NanoUsd: sql<
              number | null
            >`percentile_cont(0.9) within group (order by ${usageRecords.costNanoUsd})`,
          })
          .from(usageRecords)
          .where(globalWindow(query)),
        storeFailure
      ).map((rows) => {
        const row = rows[0];
        if (row === undefined) return null;
        const { medianNanoUsd, p90NanoUsd } = row;
        if (medianNanoUsd === null || p90NanoUsd === null) return null;
        return { medianNanoUsd, p90NanoUsd };
      });
    },

    readGlobalTrendCounts(db: Database, query) {
      const bucketStart = bucketStartExpr(query.bucket);
      return fromPromise(
        db
          .select({
            bucketStart,
            modelId: usageRecords.modelId,
            messageCount: sql<number>`count(*)`.mapWith(Number),
          })
          .from(usageRecords)
          .where(globalWindow(query))
          .groupBy(bucketStart, usageRecords.modelId)
          .orderBy(bucketStart, usageRecords.modelId),
        storeFailure
      );
    },

    insertPublicStatsSnapshot(db: Database, input) {
      return fromPromise(
        db
          .insert(publicStatsSnapshots)
          .values({ schemaVersion: input.schemaVersion, stats: input.stats })
          .returning({
            id: publicStatsSnapshots.id,
            schemaVersion: publicStatsSnapshots.schemaVersion,
            stats: publicStatsSnapshots.stats,
            createdAt: publicStatsSnapshots.createdAt,
          }),
        storeFailure
      ).map((rows) => {
        const row = rows[0];
        if (row === undefined)
          throw new Error('public-stats store: snapshot insert returned no row');
        return row;
      });
    },

    readLatestPublicStatsSnapshot(db: Database, schemaVersion) {
      return fromPromise(
        db
          .select({
            id: publicStatsSnapshots.id,
            schemaVersion: publicStatsSnapshots.schemaVersion,
            stats: publicStatsSnapshots.stats,
            createdAt: publicStatsSnapshots.createdAt,
          })
          .from(publicStatsSnapshots)
          .where(eq(publicStatsSnapshots.schemaVersion, schemaVersion))
          // uuidv7 ids are time-ordered — the id tiebreak keeps same-timestamp
          // rows deterministic.
          .orderBy(desc(publicStatsSnapshots.createdAt), desc(publicStatsSnapshots.id))
          .limit(1),
        storeFailure
      ).map((rows) => rows[0] ?? null);
    },
  };
}
