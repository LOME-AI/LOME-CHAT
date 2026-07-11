import { z } from 'zod';
import { roadmapResponseSchema } from '@hushbox/shared';
import { defineKey, defineRateLimitKey } from './define-key.js';

/**
 * Redis entries for the platform routes (`apps/api/src/platform/**`) — the
 * cross-cutting app-level surface that is not a slice, so its registry
 * entries live here beside the mechanism (the same placement as
 * `REALTIME_REDIS_KEYS`).
 */

/** Stored shape of the edge window limiter (`middleware/rate-limit.ts`). */
const rateLimitCounterSchema = z.object({
  count: z.number(),
  firstAttempt: z.number(),
});

/**
 * Per-IP cap on the UNAUTHENTICATED public roadmap endpoint. The response is
 * heavily cached (1 h Redis + 5 min CDN edge) so this primarily caps
 * scrape-style traffic that bypasses the edge cache by varying headers.
 * 30/60s mirrors the public share-read cap; a marketing roadmap page does
 * not refresh that frequently in normal use.
 */
export const roadmapIpRateLimit = defineRateLimitKey({
  schema: rateLimitCounterSchema,
  ttlSeconds: 60,
  buildKey: (ipHash: string) => `roadmap:ip:ratelimit:${ipHash}`,
  rateLimitConfig: { maxAttempts: 30, windowSeconds: 60 },
});

/**
 * Public roadmap cache. Key is `roadmap:<teamKey>:<schemaVersion>`; the
 * caller bumps its schemaVersion literal when the response shape changes so
 * isolates still serving the old shape simply miss and refill — never serve
 * stale data under a different schema.
 */
export const roadmapCache = defineKey({
  schema: roadmapResponseSchema,
  ttlSeconds: 60 * 60,
  buildKey: (teamKey: string, schemaVersion: string) =>
    `roadmap:${teamKey.toLowerCase()}:${schemaVersion}`,
});
