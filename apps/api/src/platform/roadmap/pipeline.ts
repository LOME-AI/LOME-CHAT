import { roadmapResponseSchema } from '@hushbox/shared';
import { roadmapCache } from '../../lib/redis/index.js';
import { redisGet, redisSet } from '../../lib/redis/index.js';
import { unavailableError, validationError } from '../../lib/errors/index.js';
import { errAsync, fromPromise, okAsync } from '../../lib/result/index.js';
import { normalizeRoadmap } from './normalize.js';
import type { Redis } from '@upstash/redis';
import type { RoadmapResponse } from '@hushbox/shared';
import type { DomainError } from '../../lib/errors/index.js';
import type { ResultAsync } from '../../lib/result/index.js';
import type { LinearClient } from './linear-types.js';

/**
 * Schema version baked into the cache key. Bump the string when the public
 * response shape changes so old isolates can't serve stale data under a
 * different schema — a worker still caching against the old version key
 * simply misses and refills.
 */
export const ROADMAP_SCHEMA_VERSION = 'v2';

export interface BuildRoadmapDeps {
  readonly linear: LinearClient;
  readonly redis: Redis;
  readonly teamKey: string;
}

/**
 * Read-through cached roadmap build: Redis hit (1 h TTL) returns the cached
 * value untouched; a miss fetches from Linear, normalizes, validates the
 * public shape, writes the cache, and returns the fresh response.
 *
 * Every failure — Linear unreachable, a Linear schema mismatch, Redis down —
 * surfaces as an error the route maps to a 503; there is no stale fallback
 * by design ("if it's down, it doesn't work").
 */
export function buildRoadmap(deps: BuildRoadmapDeps): ResultAsync<RoadmapResponse, DomainError> {
  return redisGet(deps.redis, roadmapCache, deps.teamKey, ROADMAP_SCHEMA_VERSION).andThen(
    (cached) => {
      if (cached !== null) return okAsync(cached);
      return fromPromise(fetchAndNormalize(deps.linear, deps.teamKey), (cause) =>
        unavailableError('roadmap: Linear fetch or normalize failed', cause)
      ).andThen((response) => {
        const parsed = roadmapResponseSchema.safeParse(response);
        if (!parsed.success) {
          return errAsync(
            validationError('roadmap: normalized response failed the public schema', parsed.error)
          );
        }
        return redisSet(
          deps.redis,
          roadmapCache,
          parsed.data,
          deps.teamKey,
          ROADMAP_SCHEMA_VERSION
        ).map(() => parsed.data);
      });
    }
  );
}

async function fetchAndNormalize(linear: LinearClient, teamKey: string): Promise<RoadmapResponse> {
  const data = await linear.fetchRoadmap(teamKey);
  const graph = await normalizeRoadmap(data);
  return { nodes: [...graph.nodes] };
}
