import { PUBLIC_USAGE_STATS_SCHEMA_VERSION, publicUsageStatsSchema } from '@hushbox/shared';
import { statsCache } from '../../lib/redis/index.js';
import { redisGet, redisSet } from '../../lib/redis/index.js';
import { unavailableError, validationError } from '../../lib/errors/index.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { readLatestPublicStatsSnapshot } from '../../slices/billing/index.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { PublicUsageStats } from '@hushbox/shared';
import type { DomainError } from '../../lib/errors/index.js';
import type { ResultAsync } from '../../lib/result/index.js';
import type { PublicStatsStores } from '../../slices/billing/index.js';

export interface BuildPublicStatsDeps {
  readonly stores: PublicStatsStores;
  readonly db: Database;
  readonly redis: Redis;
  /** Cache-key scope; production always passes `STATS_CACHE_SCOPE`. */
  readonly cacheScope: string;
}

/** The single production cache-key scope (tests isolate with unique scopes). */
export const STATS_CACHE_SCOPE = 'global';

/**
 * Read-through cached public usage stats: Redis hit (1 h TTL) returns the
 * cached payload untouched; a miss reads the latest snapshot row matching
 * `PUBLIC_USAGE_STATS_SCHEMA_VERSION` through the billing barrel, validates
 * the stored payload, writes the cache, and returns it.
 *
 * No snapshot row, a stored payload failing the schema, or Redis/DB failure
 * all surface as errors the route maps to a 503 — there is no fallback
 * computation and no stale-serving beyond the Redis TTL, by design.
 */
export function buildPublicStats(
  deps: BuildPublicStatsDeps
): ResultAsync<PublicUsageStats, DomainError> {
  return redisGet(
    deps.redis,
    statsCache,
    deps.cacheScope,
    PUBLIC_USAGE_STATS_SCHEMA_VERSION
  ).andThen((cached) => {
    if (cached !== null) return okAsync(cached);
    return readLatestPublicStatsSnapshot(
      deps.stores,
      deps.db,
      PUBLIC_USAGE_STATS_SCHEMA_VERSION
    ).andThen((row) => {
      if (row === null) {
        return errAsync(unavailableError('stats: no snapshot row for the current schema version'));
      }
      const parsed = publicUsageStatsSchema.safeParse(row.stats);
      if (!parsed.success) {
        return errAsync(
          validationError('stats: stored snapshot payload failed the public schema', parsed.error)
        );
      }
      return redisSet(
        deps.redis,
        statsCache,
        parsed.data,
        deps.cacheScope,
        PUBLIC_USAGE_STATS_SCHEMA_VERSION
      ).map(() => parsed.data);
    });
  });
}
