import { z } from 'zod';
import { defineRateLimitKey } from '../../../lib/redis/index.js';

/**
 * The per-IP cap on the UNAUTHENTICATED public share read endpoint, throttling
 * link-id scraping. Enforced by the edge rate-limit middleware the app
 * assembly mounts on the share-read path (the composition root imports it
 * through the slice barrel — routes may not import adapters, which is why
 * the mount lives in `app.ts`). Colocated with the adapters (like
 * `membershipCacheKey`) because its only consumer is that infra edge
 * enforcer, not domain logic. Window mirrors the legacy `shareGetIpRateLimit`.
 */
const rateLimitCounterSchema = z.object({
  count: z.number(),
  firstAttempt: z.number(),
});

export const publicShareReadRateLimit = defineRateLimitKey({
  schema: rateLimitCounterSchema,
  ttlSeconds: 60,
  buildKey: (ipHash: string) => `conversations:share:read:ip:ratelimit:${ipHash}`,
  rateLimitConfig: { maxAttempts: 30, windowSeconds: 60 },
});
