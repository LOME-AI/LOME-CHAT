import type { Database } from '@hushbox/db';
import type { Modality, PublicUsageStats, UsageStatsTrendBucket } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * Read seam for the public usage-stats builder: GLOBAL (unscoped) aggregates
 * over `usage_records` plus the snapshot store. The raw counts these queries
 * return are the anonymization boundary's input — they exist only transiently
 * inside `buildPublicUsageStats` and must never persist or leave the slice.
 */

/** A global usage window: one modality, half-open `[start, end)` on createdAt. */
export interface GlobalUsageWindowQuery {
  readonly modality: Modality;
  /** Inclusive lower bound; null means all-time (unbounded below). */
  readonly start: Date | null;
  /** Exclusive upper bound. */
  readonly end: Date;
}

/** One per-model global aggregate row. Money stays bigint; counts die in-domain. */
export interface GlobalModelUsageRow {
  readonly modelId: string;
  readonly messageCount: number;
  readonly costNanoUsd: bigint;
}

/**
 * Per-record cost percentiles in nano-USD. `number` (not bigint) because SQL
 * `percentile_cont` interpolates to double precision — these are display
 * statistics for the public page, never settlement math.
 */
export interface GlobalCostPercentiles {
  readonly medianNanoUsd: number;
  readonly p90NanoUsd: number;
}

/** One (bucket, model) count row of the trend series. */
export interface GlobalTrendCountRow {
  /** UTC bucket start as an ISO `YYYY-MM-DD` date string. */
  readonly bucketStart: string;
  readonly modelId: string;
  readonly messageCount: number;
}

export interface PublicStatsSnapshotRow {
  readonly id: string;
  readonly schemaVersion: number;
  /** The stored jsonb payload — already anonymized at write time. */
  readonly stats: unknown;
  readonly createdAt: Date;
}

export interface PublicStatsStores {
  /** Global per-model message counts + cost sums for one window + modality. */
  aggregateGlobalUsageByModel(
    db: Database,
    query: GlobalUsageWindowQuery
  ): ResultAsync<readonly GlobalModelUsageRow[], DomainError>;

  /** Median/p90 per-record cost for the window; null when it has no records. */
  readGlobalCostPercentiles(
    db: Database,
    query: GlobalUsageWindowQuery
  ): ResultAsync<GlobalCostPercentiles | null, DomainError>;

  /** Per-(bucket, model) counts within the window, bucketed by day or month. */
  readGlobalTrendCounts(
    db: Database,
    query: GlobalUsageWindowQuery & { readonly bucket: UsageStatsTrendBucket }
  ): ResultAsync<readonly GlobalTrendCountRow[], DomainError>;

  /** Appends one snapshot row holding the full anonymized payload. */
  insertPublicStatsSnapshot(
    db: Database,
    input: { readonly schemaVersion: number; readonly stats: PublicUsageStats }
  ): ResultAsync<PublicStatsSnapshotRow, DomainError>;

  /** The newest snapshot row matching `schemaVersion`, or null. */
  readLatestPublicStatsSnapshot(
    db: Database,
    schemaVersion: number
  ): ResultAsync<PublicStatsSnapshotRow | null, DomainError>;
}
