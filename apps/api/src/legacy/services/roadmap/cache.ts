import { redisGet, redisSet } from '../../lib/redis-registry.js';
import type { Redis } from '@upstash/redis';
import type { RoadmapResponse } from '@hushbox/shared';

/**
 * Schema version baked into the cache key. Bump this string when the
 * public response shape changes so old isolates can't serve stale data
 * with a different schema. Worker isolates that already cached against
 * the old version key simply miss and refill.
 */
const ROADMAP_SCHEMA_VERSION = 'v2';

/**
 * Read-through cache for the public roadmap response. Backed by Upstash
 * Redis with a 1 h TTL.
 *
 * If Linear is unreachable, callers receive an error; this cache layer
 * never returns stale data on upstream failure (the design decision was
 * "if it's down, it doesn't work" — keep it simple).
 */
export class RoadmapCache {
  constructor(
    private readonly redis: Redis,
    private readonly teamKey: string
  ) {}

  async get(): Promise<RoadmapResponse | null> {
    return redisGet(this.redis, 'roadmapCache', this.teamKey, ROADMAP_SCHEMA_VERSION);
  }

  async set(value: RoadmapResponse): Promise<void> {
    await redisSet(this.redis, 'roadmapCache', value, this.teamKey, ROADMAP_SCHEMA_VERSION);
  }
}
