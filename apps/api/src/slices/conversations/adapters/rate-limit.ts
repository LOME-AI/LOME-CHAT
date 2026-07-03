import { z } from 'zod';
import { defineRateLimitKey } from '../../../lib/redis/index.js';

/**
 * The per-IP cap on the UNAUTHENTICATED public share read endpoint, throttling
 * link-id scraping. This is a registry entry only: enforcement lands with the
 * edge/IP rate-limit enforcer, so no code consumes this yet. It is colocated
 * with the adapters (like `membershipCacheKey`) because its only future
 * consumer is that infra edge enforcer, not domain logic. Window mirrors the
 * legacy `shareGetIpRateLimit`.
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
