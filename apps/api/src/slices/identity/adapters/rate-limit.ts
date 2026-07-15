import { z } from 'zod';
import { defineRateLimitKey } from '../../../lib/redis/index.js';

/**
 * The per-IP abuse throttles on the unauthenticated auth surfaces. Legacy
 * DUAL-limited each of these (a per-user/email/token dimension AND a per-IP
 * dimension); the per-user dimensions are the atomic-reservation / advisory
 * entries in `domain/keys.ts`, consumed inside the domain flows. These per-IP
 * dimensions are enforced by the edge rate-limit middleware the app assembly
 * mounts on each auth route: routes may not import adapters, so the mounts
 * live in `app.ts`, binding these barrel-published entries to `rateLimitByIp`.
 * Colocated with the adapters (like `stores`) because their only consumer is
 * that infra edge enforcer, not domain logic. Windows mirror the legacy
 * `*IpRateLimit` entries.
 */
const ipWindowSchema = z.object({
  count: z.number(),
  firstAttempt: z.number(),
});

/** Login start, per IP (legacy `loginIpRateLimit`: 20 per 15 minutes). */
export const loginIpRateLimit = defineRateLimitKey({
  schema: ipWindowSchema,
  ttlSeconds: 900,
  buildKey: (ipHash: string) => `login:ip:ratelimit:${ipHash}`,
  rateLimitConfig: { maxAttempts: 20, windowSeconds: 900 },
});

/** Registration start, per IP (legacy `registerIpRateLimit`: 10 per hour). */
export const registerIpRateLimit = defineRateLimitKey({
  schema: ipWindowSchema,
  ttlSeconds: 3600,
  buildKey: (ipHash: string) => `register:ip:ratelimit:${ipHash}`,
  rateLimitConfig: { maxAttempts: 10, windowSeconds: 3600 },
});

/** Recovery reset start, per IP (legacy `recoveryIpRateLimit`: 10 per hour). */
export const recoveryResetIpRateLimit = defineRateLimitKey({
  schema: ipWindowSchema,
  ttlSeconds: 3600,
  buildKey: (ipHash: string) => `recovery:ip:ratelimit:${ipHash}`,
  rateLimitConfig: { maxAttempts: 10, windowSeconds: 3600 },
});

/**
 * Recovery wrapped-key retrieval, per IP (legacy `recoveryGetKeyIpRateLimit`:
 * 10 per hour). Paired with the per-target `recoveryGetKeyLockout` (3/hour).
 */
export const recoveryGetKeyIpRateLimit = defineRateLimitKey({
  schema: ipWindowSchema,
  ttlSeconds: 3600,
  buildKey: (ipHash: string) => `recovery:getkey:ip:ratelimit:${ipHash}`,
  rateLimitConfig: { maxAttempts: 10, windowSeconds: 3600 },
});

/** Email-verification token consume, per IP (legacy `verifyIpRateLimit`: 30 per hour). */
export const verifyEmailIpRateLimit = defineRateLimitKey({
  schema: ipWindowSchema,
  ttlSeconds: 3600,
  buildKey: (ipHash: string) => `verify:ip:ratelimit:${ipHash}`,
  rateLimitConfig: { maxAttempts: 30, windowSeconds: 3600 },
});

/** Verification-email resend, per IP (legacy `resendVerifyIpRateLimit`: 5 per 60s). */
export const resendVerifyIpRateLimit = defineRateLimitKey({
  schema: ipWindowSchema,
  ttlSeconds: 60,
  buildKey: (ipHash: string) => `resend-verify:ip:ratelimit:${ipHash}`,
  rateLimitConfig: { maxAttempts: 5, windowSeconds: 60 },
});
