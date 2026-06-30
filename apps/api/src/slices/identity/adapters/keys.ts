import { z } from 'zod';
import { SESSION_MAX_AGE_SECONDS } from '../../../lib/context/index.js';
import { defineKey, defineRateLimitKey } from '../../../lib/redis/index.js';

/**
 * Fixed-window counter state shared by the rate-limit entries below
 * (legacy-compatible shape: attempt count + window-opening timestamp).
 */
export const rateLimitWindowSchema = z.object({
  count: z.number(),
  firstAttempt: z.number(),
});

/**
 * The identity slice's Redis registry entries.
 *
 * OPAQUE handshake state is keyed by a server-issued UUID, never by the
 * identifier: the identifier moves into the stored value so the finish step
 * can verify it matches the request (defense-in-depth against a stolen
 * handshake id), and per-identifier keying would let two concurrent
 * handshakes clobber each other's `expected` value.
 *
 * Session keys mirror the legacy key shapes exactly — production cookies
 * sealed before the cutover must keep resolving to the same Redis entries.
 */
export const IDENTITY_KEYS = {
  opaquePendingRegistration: defineKey({
    schema: z.object({
      email: z.string(),
      username: z.string(),
      userId: z.string(),
      existing: z.boolean().optional(),
    }),
    ttlSeconds: 300,
    buildKey: (handshakeId: string) => `opaque:pending:${handshakeId}`,
  }),
  opaquePendingLogin: defineKey({
    schema: z.object({
      identifier: z.string(),
      userId: z.string().nullable(),
      expectedSerialized: z.array(z.number()),
    }),
    ttlSeconds: 120,
    buildKey: (handshakeId: string) => `opaque:login:${handshakeId}`,
  }),
  // Coerced: the Upstash client JSON-parses stored values, so '1' returns as
  // the number 1.
  sessionActive: defineKey({
    schema: z.coerce.string(),
    ttlSeconds: SESSION_MAX_AGE_SECONDS,
    buildKey: (userId: string, sessionId: string) => `sessions:user:active:${userId}:${sessionId}`,
  }),
  passwordChangedAt: defineKey({
    schema: z.coerce.number(),
    ttlSeconds: SESSION_MAX_AGE_SECONDS,
    buildKey: (userId: string) => `auth:pw-changed:${userId}`,
  }),
  loginRateLimit: defineRateLimitKey({
    schema: rateLimitWindowSchema,
    ttlSeconds: 900,
    buildKey: (identifier: string) => `login:user:ratelimit:${identifier.toLowerCase()}`,
    rateLimitConfig: { maxAttempts: 5, windowSeconds: 900 },
  }),
  registerRateLimit: defineRateLimitKey({
    schema: rateLimitWindowSchema,
    ttlSeconds: 3600,
    buildKey: (email: string) => `register:email:ratelimit:${email.toLowerCase()}`,
    rateLimitConfig: { maxAttempts: 3, windowSeconds: 3600 },
  }),
} as const;
