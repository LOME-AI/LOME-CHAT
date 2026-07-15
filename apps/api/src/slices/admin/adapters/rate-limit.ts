import { z } from 'zod';
import { defineRateLimitKey } from '../../../lib/redis/index.js';

/**
 * Read-volume caps on the admin plane's sensitive read surfaces (Charter
 * #12: metadata reads are scoped, audited, and volume-capped). Enforced by
 * the edge `rateLimitByAdminActor` middleware the app assembly mounts on the
 * read paths (routes may not import adapters, so the mounts live in
 * `app.ts`), keyed per hashed admin actor. Windows are sized for 1–3
 * founder-admins working a console — generous for real use, prohibitive for
 * bulk exfiltration.
 */
const rateLimitWindowSchema = z.object({
  count: z.number(),
  firstAttempt: z.number(),
});

/** Customer-360 loads: each is a whole-customer metadata assembly. */
export const adminCustomer360RateLimit = defineRateLimitKey({
  schema: rateLimitWindowSchema,
  ttlSeconds: 3600,
  buildKey: (actorHash: string) => `admin:read:360:ratelimit:${actorHash}`,
  rateLimitConfig: { maxAttempts: 120, windowSeconds: 3600 },
});

/** Audit-trail searches (the trail names users as targets). */
export const adminAuditSearchRateLimit = defineRateLimitKey({
  schema: rateLimitWindowSchema,
  ttlSeconds: 3600,
  buildKey: (actorHash: string) => `admin:read:audit:ratelimit:${actorHash}`,
  rateLimitConfig: { maxAttempts: 240, windowSeconds: 3600 },
});

/** SQL panel queries — psql-grade reads; the row cap bounds each page. */
export const adminSqlPanelRateLimit = defineRateLimitKey({
  schema: rateLimitWindowSchema,
  ttlSeconds: 3600,
  buildKey: (actorHash: string) => `admin:read:sql:ratelimit:${actorHash}`,
  rateLimitConfig: { maxAttempts: 120, windowSeconds: 3600 },
});
