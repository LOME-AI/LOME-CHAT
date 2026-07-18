import { z } from 'zod';
import { defineRateLimitKey } from '../../../lib/redis/index.js';

/**
 * The per-caller cap on AUTHENTICATED feedback submission — each request inserts
 * a `feedback` row. An advisory fixed window (an abuse throttle, not a
 * secret-guessing reservation). Enforced by the edge `rateLimitByCaller` the app
 * assembly mounts on `POST /feedback` (routes may not import adapters, which is
 * why the mount lives in `app.ts`); the composition root imports it through the
 * slice barrel and binds it to the mounted path. Colocated with the adapters
 * because its only consumer is that infra edge enforcer, not domain logic.
 */
const rateLimitCounterSchema = z.object({
  count: z.number(),
  firstAttempt: z.number(),
});

export const feedbackSubmitRateLimit = defineRateLimitKey({
  schema: rateLimitCounterSchema,
  ttlSeconds: 60,
  buildKey: (callerId: string) => `feedback:submit:user:ratelimit:${callerId}`,
  rateLimitConfig: { maxAttempts: 10, windowSeconds: 60 },
});

/**
 * The hourly per-user ceiling layered over the 10/min burst limiter: it bounds
 * sustained submission a burst window can't (ten every minute is 600/hour). A
 * second advisory fixed window; both apply on `POST /feedback` and either
 * tripping answers 429. `maxAttempts: 30/hour` is a chosen default — tunable.
 */
export const feedbackSubmitHourlyRateLimit = defineRateLimitKey({
  schema: rateLimitCounterSchema,
  ttlSeconds: 3600,
  buildKey: (callerId: string) => `feedback:submit:user:hourly:ratelimit:${callerId}`,
  rateLimitConfig: { maxAttempts: 30, windowSeconds: 3600 },
});
