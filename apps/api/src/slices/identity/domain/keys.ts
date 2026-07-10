import { z } from 'zod';
import { SESSION_MAX_AGE_SECONDS } from '../../../lib/context/index.js';
import { defineKey, defineRateLimitKey } from '../../../lib/redis/index.js';
import type { Variables } from '../../../lib/context/index.js';

/**
 * The per-request Redis client as the pipeline types it — named here so
 * domain signatures never import the infra module (boundaries: only adapters
 * and lib may).
 */
export type RedisClient = Variables['redis'];

/**
 * Fixed-window counter state shared by the rate-limit entries below
 * (legacy-compatible shape: attempt count + window-opening timestamp).
 */
export const rateLimitWindowSchema = z.object({
  count: z.number(),
  firstAttempt: z.number(),
});

/**
 * Plain failure counter advanced with atomic INCR (coerced: the Upstash
 * client JSON-parses the stored integer string). The window is the key's TTL,
 * anchored at the first failure — unlike the advisory rate-limit windows
 * above, a lockout is a security boundary and must count N racing failures
 * as exactly N.
 */
export const lockoutCounterSchema = z.coerce.number();

/**
 * Shared shape of every OPAQUE step-up handshake's stored state. The userId
 * rides in the value so the finish round rejects a stolen handshake id bound
 * to another account; `expectedSerialized` is the OPAQUE expected-auth-result.
 */
export const stepUpPendingSchema = z.object({
  userId: z.string(),
  expectedSerialized: z.array(z.number()),
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
  // Billing-portal login token (mobile app → web billing handoff). Keyed by
  // the token itself and NEVER deleted on redemption: the 60-second TTL is the
  // expiry, and replays within it converge on the same deterministic session
  // (token-is-key idempotency — legacy contract, preserved across the cutover
  // so in-flight production tokens keep resolving).
  billingLoginToken: defineKey({
    schema: z.object({ userId: z.string() }),
    ttlSeconds: 60,
    buildKey: (token: string) => `billing:login-token:${token}`,
  }),
  // Password-login lockout: failed-attempt counter, keyed on the user id when
  // the identifier resolves to an account (unifying email and username into
  // one guessing budget) else on the lowercased canonical identifier. A
  // secret-guessing surface, so the counter is the atomic attempt-reservation
  // gate, never the advisory window; a verified login clears it.
  loginLockout: defineRateLimitKey({
    schema: lockoutCounterSchema,
    ttlSeconds: 900,
    buildKey: (identifier: string) => `login:lockout:${identifier.toLowerCase()}`,
    rateLimitConfig: { maxAttempts: 5, windowSeconds: 900 },
  }),
  registerRateLimit: defineRateLimitKey({
    schema: rateLimitWindowSchema,
    ttlSeconds: 3600,
    buildKey: (email: string) => `register:email:ratelimit:${email.toLowerCase()}`,
    rateLimitConfig: { maxAttempts: 3, windowSeconds: 3600 },
  }),
  // TOTP enrollment: the fresh secret held (plaintext + its encrypted blob)
  // between setup and the confirming verify. Single-use — the verify consumes
  // it via `redisGetDel` so a replayed confirmation cannot re-enable.
  //
  // Deliberate: the plaintext secret exists in Redis for this 300-second
  // pending-setup window only (the confirming code must be checked against
  // it, and Redis is ephemeral coordination, never durable truth). The
  // durable store persists only `totpSecretEncrypted`.
  totpPendingSetup: defineKey({
    schema: z.object({
      secret: z.string(),
      encryptedBlob: z.array(z.number()),
    }),
    ttlSeconds: 300,
    buildKey: (userId: string) => `totp:pending:${userId}`,
  }),
  // Consumed-code marker for TOTP replay protection: a code accepted once
  // cannot be reused inside its validity window. Coerced (Upstash JSON-parses).
  totpUsedCode: defineKey({
    schema: z.coerce.string(),
    ttlSeconds: 120,
    buildKey: (userId: string, code: string) => `totp:used:${userId}:${code}`,
  }),
  // OPAQUE step-up handshake state for the sensitive authenticated ops. Keyed
  // by a server-issued handshake id (never userId) so concurrent step-ups for
  // one user cannot clobber each other's `expected`; the userId rides in the
  // value so the finish round rejects a stolen handshake id bound to another
  // account.
  opaquePendingChangePassword: defineKey({
    schema: stepUpPendingSchema,
    ttlSeconds: 300,
    buildKey: (handshakeId: string) => `opaque:change-password:${handshakeId}`,
  }),
  opaquePending2FADisable: defineKey({
    schema: stepUpPendingSchema,
    ttlSeconds: 300,
    buildKey: (handshakeId: string) => `opaque:2fa-disable:${handshakeId}`,
  }),
  opaquePendingDeleteAccount: defineKey({
    schema: stepUpPendingSchema,
    ttlSeconds: 300,
    buildKey: (handshakeId: string) => `opaque:delete-account:${handshakeId}`,
  }),
  // Recovery reset handshake: only the identifier rides along (the recovery
  // phrase never reaches the server — the client rewraps its key locally).
  opaquePendingRecoveryReset: defineKey({
    schema: z.object({ identifier: z.string() }),
    ttlSeconds: 300,
    buildKey: (handshakeId: string) => `opaque:recovery-reset:${handshakeId}`,
  }),
  // Email verification-resend throttle (per email, user-keyed only — the new
  // pipeline carries no client IP).
  resendVerifyRateLimit: defineRateLimitKey({
    schema: rateLimitWindowSchema,
    ttlSeconds: 3600,
    buildKey: (email: string) => `resend-verify:email:ratelimit:${email.toLowerCase()}`,
    rateLimitConfig: { maxAttempts: 3, windowSeconds: 3600 },
  }),
  // Recovery wrapped-key retrieval lockout (per canonical identifier). The
  // returned blob is offline-attackable ciphertext, so retrieval is a
  // secret-guessing surface: the counter is the atomic attempt-reservation
  // gate. No success clears it — every response looks identical by design
  // (enumeration safety), so there is nothing verified to clear on.
  recoveryGetKeyLockout: defineRateLimitKey({
    schema: lockoutCounterSchema,
    ttlSeconds: 3600,
    buildKey: (identifier: string) => `recovery:getkey:lockout:${identifier.toLowerCase()}`,
    rateLimitConfig: { maxAttempts: 5, windowSeconds: 3600 },
  }),
  // Recovery reset lockout (per canonical identifier), attempt-reservation
  // for the same reason. The server never verifies the recovery phrase (it
  // never leaves the client), so no reset outcome is a verified success and
  // the counter is never cleared — the window simply expires.
  recoveryResetLockout: defineRateLimitKey({
    schema: lockoutCounterSchema,
    ttlSeconds: 3600,
    buildKey: (identifier: string) => `recovery:reset:lockout:${identifier.toLowerCase()}`,
    rateLimitConfig: { maxAttempts: 3, windowSeconds: 3600 },
  }),
  // TOTP-verify lockout: failed-attempt counter. After `maxAttempts` failures
  // inside the TTL window the account's 2FA verification is locked for the
  // rest of it; a success clears the window (legacy parity: 10 attempts /
  // 15 min).
  twoFactorLockout: defineRateLimitKey({
    schema: lockoutCounterSchema,
    ttlSeconds: 900,
    buildKey: (userId: string) => `2fa:lockout:${userId}`,
    rateLimitConfig: { maxAttempts: 10, windowSeconds: 900 },
  }),
  // Account-deletion request lockout: failed step-up attempts (legacy parity:
  // 3 attempts / 24 hours). The window equals the TTL, so the third failure
  // locks deletion for the rest of a full day.
  deleteAccountLockout: defineRateLimitKey({
    schema: lockoutCounterSchema,
    ttlSeconds: 86_400,
    buildKey: (userId: string) => `delete-account:lockout:${userId}`,
    rateLimitConfig: { maxAttempts: 3, windowSeconds: 86_400 },
  }),
} as const;
