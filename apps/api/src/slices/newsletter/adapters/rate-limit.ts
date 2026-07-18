import { z } from 'zod';
import { defineRateLimitKey } from '../../../lib/redis/index.js';

const rateLimitCounterSchema = z.object({
  count: z.number(),
  firstAttempt: z.number(),
});

/**
 * Per-IP cap on UNAUTHENTICATED public newsletter signup — each request can
 * trigger an outbound confirmation email, so this is an abuse throttle (an
 * advisory fixed window, not a secret-guessing reservation). Enforced by the
 * edge `rateLimitByIp` the app assembly mounts on `POST /newsletter/subscribe`
 * (routes may not import adapters, which is why the mount lives in `app.ts`);
 * the composition root imports it through the slice barrel. The DB-side
 * per-address resend throttle bounds mail volume per target independently.
 */
export const newsletterSubscribeIpRateLimit = defineRateLimitKey({
  schema: rateLimitCounterSchema,
  ttlSeconds: 60,
  buildKey: (ipHash: string) => `newsletter:subscribe:ip:ratelimit:${ipHash}`,
  rateLimitConfig: { maxAttempts: 10, windowSeconds: 60 },
});

/**
 * Per-IP cap on the public token-consumption endpoints, mirroring identity's
 * `verifyEmailIpRateLimit` (30/hour): the token itself is the credential, so
 * this is abuse-cost bounding on probing, not a secret-guessing reservation.
 * One key per route (the identity precedent), same values on both.
 */
export const newsletterConfirmIpRateLimit = defineRateLimitKey({
  schema: rateLimitCounterSchema,
  ttlSeconds: 3600,
  buildKey: (ipHash: string) => `newsletter:confirm:ip:ratelimit:${ipHash}`,
  rateLimitConfig: { maxAttempts: 30, windowSeconds: 3600 },
});

export const newsletterUnsubscribeIpRateLimit = defineRateLimitKey({
  schema: rateLimitCounterSchema,
  ttlSeconds: 3600,
  buildKey: (ipHash: string) => `newsletter:unsubscribe:ip:ratelimit:${ipHash}`,
  rateLimitConfig: { maxAttempts: 30, windowSeconds: 3600 },
});
