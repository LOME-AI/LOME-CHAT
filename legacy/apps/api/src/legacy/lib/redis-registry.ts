import { z } from 'zod';
import { roadmapResponseSchema } from '@hushbox/shared';
import { SESSION_MAX_AGE_SECONDS } from './session.js';
import type { Redis } from '@upstash/redis';

export function defineKey<TSchema extends z.ZodType, TArgs extends unknown[]>(config: {
  schema: TSchema;
  ttl: number;
  buildKey: (...args: TArgs) => string;
}): {
  schema: TSchema;
  ttl: number;
  buildKey: (...args: TArgs) => string;
} {
  return config;
}

export function defineRateLimitKey<TSchema extends z.ZodType, TArgs extends unknown[]>(config: {
  schema: TSchema;
  ttl: number;
  buildKey: (...args: TArgs) => string;
  rateLimitConfig: {
    maxAttempts: number;
    windowSeconds: number;
    lockoutSeconds?: number;
  };
}): {
  schema: TSchema;
  ttl: number;
  buildKey: (...args: TArgs) => string;
  rateLimitConfig: {
    maxAttempts: number;
    windowSeconds: number;
    lockoutSeconds?: number;
  };
} {
  return config;
}

export const rateLimitDataSchema = z.object({
  count: z.number(),
  firstAttempt: z.number(),
});

const lockoutSchema = z.coerce.string();

export const REDIS_REGISTRY = {
  // Rate limit keys — login
  loginUserRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 900,
    buildKey: (userIdentifier: string) => `login:user:ratelimit:${userIdentifier.toLowerCase()}`,
    rateLimitConfig: { maxAttempts: 5, windowSeconds: 900 },
  }),
  loginIpRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 900,
    buildKey: (ipHash: string) => `login:ip:ratelimit:${ipHash}`,
    rateLimitConfig: { maxAttempts: 20, windowSeconds: 900 },
  }),

  // Rate limit keys — registration
  registerEmailRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 3600,
    buildKey: (email: string) => `register:email:ratelimit:${email.toLowerCase()}`,
    rateLimitConfig: { maxAttempts: 3, windowSeconds: 3600 },
  }),
  registerIpRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 3600,
    buildKey: (ipHash: string) => `register:ip:ratelimit:${ipHash}`,
    rateLimitConfig: { maxAttempts: 10, windowSeconds: 3600 },
  }),

  // Rate limit keys — 2FA
  twoFactorUserRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 900,
    buildKey: (userId: string) => `2fa:user:ratelimit:${userId}`,
    rateLimitConfig: { maxAttempts: 10, windowSeconds: 900 },
  }),

  // Rate limit keys — delete-account
  deleteAccountUserRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 3600,
    buildKey: (userId: string) => `delete-account:user:ratelimit:${userId}`,
    rateLimitConfig: { maxAttempts: 3, windowSeconds: 3600 },
  }),

  // Rate limit keys — recovery
  recoveryUserRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 3600,
    buildKey: (userIdentifier: string) => `recovery:user:ratelimit:${userIdentifier.toLowerCase()}`,
    rateLimitConfig: { maxAttempts: 3, windowSeconds: 3600 },
  }),
  recoveryIpRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 3600,
    buildKey: (ipHash: string) => `recovery:ip:ratelimit:${ipHash}`,
    rateLimitConfig: { maxAttempts: 10, windowSeconds: 3600 },
  }),
  recoveryGetKeyUserRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 3600,
    buildKey: (userIdentifier: string) =>
      `recovery:getkey:user:ratelimit:${userIdentifier.toLowerCase()}`,
    rateLimitConfig: { maxAttempts: 3, windowSeconds: 3600 },
  }),
  recoveryGetKeyIpRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 3600,
    buildKey: (ipHash: string) => `recovery:getkey:ip:ratelimit:${ipHash}`,
    rateLimitConfig: { maxAttempts: 10, windowSeconds: 3600 },
  }),

  // Rate limit keys — email verification
  verifyTokenRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 3600,
    buildKey: (token: string) => `verify:token:ratelimit:${token}`,
    rateLimitConfig: { maxAttempts: 10, windowSeconds: 3600 },
  }),
  verifyIpRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 3600,
    buildKey: (ipHash: string) => `verify:ip:ratelimit:${ipHash}`,
    rateLimitConfig: { maxAttempts: 30, windowSeconds: 3600 },
  }),

  // Rate limit keys — resend verification
  resendVerifyEmailRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 60,
    buildKey: (email: string) => `resend-verify:email:ratelimit:${email.toLowerCase()}`,
    rateLimitConfig: { maxAttempts: 1, windowSeconds: 60 },
  }),
  resendVerifyIpRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 60,
    buildKey: (ipHash: string) => `resend-verify:ip:ratelimit:${ipHash}`,
    rateLimitConfig: { maxAttempts: 5, windowSeconds: 60 },
  }),

  // Rate limit keys — cost-amplification surfaces (chat/media/share)
  // Per-user cap on AI Gateway calls. The bottleneck is the gateway itself,
  // so a user-level cap is sufficient — IP-level adds little when the worst
  // offender is an authenticated user repeatedly invoking inference.
  chatStreamUserRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 60,
    buildKey: (userId: string) => `chat:stream:user:ratelimit:${userId}`,
    rateLimitConfig: { maxAttempts: 30, windowSeconds: 60 },
  }),
  // Per-user cap on presigned URL minting. Minting is cheap, but a flood
  // could DOS the signing path (R2 SigV4 / KMS) — cap at 60/min/user.
  mediaDownloadUserRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 60,
    buildKey: (userId: string) => `media:download:user:ratelimit:${userId}`,
    rateLimitConfig: { maxAttempts: 60, windowSeconds: 60 },
  }),
  // Per-IP cap on the UNAUTHENTICATED public share lookup endpoint.
  // Throttle to slow down share-id scraping/scanning.
  shareGetIpRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 60,
    buildKey: (ipHash: string) => `share:get:ip:ratelimit:${ipHash}`,
    rateLimitConfig: { maxAttempts: 30, windowSeconds: 60 },
  }),
  // Per-user cap on share creation — each request inserts a DB row.
  shareCreateUserRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 60,
    buildKey: (userId: string) => `share:create:user:ratelimit:${userId}`,
    rateLimitConfig: { maxAttempts: 20, windowSeconds: 60 },
  }),
  // Per-IP burst cap on the UNAUTHENTICATED trial chat stream. The daily
  // message-count cap (consumeTrialMessage) limits total spend, but a burst
  // of requests under the daily cap can still flood Redis / the AI gateway
  // before the daily counter saturates. 20/60s is generous for trial UX
  // while throttling pathological floods.
  trialChatStreamIpRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 60,
    buildKey: (ipHash: string) => `trial:chat:stream:ip:ratelimit:${ipHash}`,
    rateLimitConfig: { maxAttempts: 20, windowSeconds: 60 },
  }),
  // Per-IP cap on the UNAUTHENTICATED public roadmap endpoint. The response
  // is heavily cached (1h Redis + 5min CDN edge) so this primarily caps
  // scrape-style traffic that bypasses the edge cache by varying headers.
  // 30/60s aligns with shareGetIpRateLimit; a marketing roadmap page does
  // not refresh that frequently in normal use.
  roadmapIpRateLimit: defineRateLimitKey({
    schema: rateLimitDataSchema,
    ttl: 60,
    buildKey: (ipHash: string) => `roadmap:ip:ratelimit:${ipHash}`,
    rateLimitConfig: { maxAttempts: 30, windowSeconds: 60 },
  }),

  // Lockout keys
  loginLockout: defineKey({
    schema: lockoutSchema,
    ttl: 900,
    buildKey: (userIdentifier: string) => `login:lockout:${userIdentifier.toLowerCase()}`,
  }),
  twoFactorLockout: defineKey({
    schema: lockoutSchema,
    ttl: 900,
    buildKey: (userId: string) => `2fa:lockout:${userId}`,
  }),
  recoveryLockout: defineKey({
    schema: lockoutSchema,
    ttl: 3600,
    buildKey: (userIdentifier: string) => `recovery:lockout:${userIdentifier.toLowerCase()}`,
  }),
  deleteAccountLockout: defineKey({
    schema: lockoutSchema,
    ttl: 24 * 60 * 60,
    buildKey: (userId: string) => `delete-account:lockout:${userId}`,
  }),

  // OPAQUE state. All six OPAQUE handshakes (registration, login, change
  // password, 2FA disable, delete account, recovery reset) are keyed by a
  // server-issued UUID, not by the identifier or userId. The identifier or
  // userId moves into the stored value so the finish step can still verify
  // it matches the request — defense-in-depth against a stolen session
  // token being used with a different account. Per-identifier keying caused
  // a race where two concurrent handshakes for the same user clobbered each
  // other's `expected` value in Redis, breaking both handshakes; the
  // sessionId-keyed scheme matches how RFC-compliant PAKE implementations
  // track per-handshake state.
  opaquePendingRegistration: defineKey({
    schema: z.object({
      email: z.string(),
      username: z.string(),
      userId: z.string(),
      existing: z.boolean().optional(),
    }),
    ttl: 300,
    buildKey: (sessionId: string) => `opaque:pending:${sessionId}`,
  }),
  opaquePendingLogin: defineKey({
    schema: z.object({
      identifier: z.string(),
      userId: z.string().nullable(),
      expectedSerialized: z.array(z.number()),
    }),
    ttl: 120,
    buildKey: (sessionId: string) => `opaque:login:${sessionId}`,
  }),
  opaquePendingChangePassword: defineKey({
    schema: z.object({
      userId: z.string(),
      expectedSerialized: z.array(z.number()),
    }),
    ttl: 300,
    buildKey: (sessionId: string) => `opaque:change-pw:${sessionId}`,
  }),
  opaquePending2FADisable: defineKey({
    schema: z.object({
      userId: z.string(),
      expectedSerialized: z.array(z.number()),
    }),
    ttl: 300,
    buildKey: (sessionId: string) => `opaque:2fa-disable:${sessionId}`,
  }),
  opaquePendingDeleteAccount: defineKey({
    schema: z.object({
      userId: z.string(),
      expectedSerialized: z.array(z.number()),
    }),
    ttl: 300,
    buildKey: (sessionId: string) => `opaque:delete-account:${sessionId}`,
  }),
  opaquePendingRecoveryReset: defineKey({
    schema: z.object({
      identifier: z.string(),
    }),
    ttl: 300,
    buildKey: (sessionId: string) => `opaque:recovery-reset:${sessionId}`,
  }),

  // TOTP state
  totpPendingSetup: defineKey({
    schema: z.object({
      secret: z.string(),
      encryptedBlob: z.array(z.number()),
    }),
    ttl: 300,
    buildKey: (userId: string) => `totp:pending:${userId}`,
  }),
  totpUsedCode: defineKey({
    schema: z.coerce.string(),
    ttl: 120,
    buildKey: (userId: string, code: string) => `totp:used:${userId}:${code}`,
  }),

  // Trial usage tracking
  trialTokenUsage: defineKey({
    schema: z.coerce.number(),
    ttl: 86_400,
    buildKey: (trialToken: string) => `trial:token:${trialToken}`,
  }),
  trialIpUsage: defineKey({
    schema: z.coerce.number(),
    ttl: 86_400,
    buildKey: (ipHash: string) => `trial:ip:${ipHash}`,
  }),

  // Speculative balance reservation
  chatReservedBalance: defineKey({
    schema: z.coerce.number(),
    ttl: 180,
    buildKey: (userId: string) => `chat:reserved:${userId}`,
  }),
  groupMemberReserved: defineKey({
    schema: z.coerce.number(),
    ttl: 180,
    buildKey: (conversationId: string, memberId: string) =>
      `chat:group-reserved:${conversationId}:${memberId}`,
  }),
  conversationReserved: defineKey({
    schema: z.coerce.number(),
    ttl: 180,
    buildKey: (conversationId: string) => `chat:conversation-reserved:${conversationId}`,
  }),

  // Billing login token (mobile app → web billing)
  billingLoginToken: defineKey({
    schema: z.object({ userId: z.string() }),
    ttl: 60,
    buildKey: (token: string) => `billing:login-token:${token}`,
  }),

  // Public roadmap cache. Key is `roadmap:<teamKey>:<schemaVersion>`; bump
  // the literal schemaVersion when the response shape changes so old isolates
  // can't serve stale data with a different schema.
  roadmapCache: defineKey({
    schema: roadmapResponseSchema,
    ttl: 60 * 60,
    buildKey: (teamKey: string, schemaVersion: string) =>
      `roadmap:${teamKey.toLowerCase()}:${schemaVersion}`,
  }),

  // Session tracking
  sessionActive: defineKey({
    schema: z.coerce.string(),
    ttl: SESSION_MAX_AGE_SECONDS,
    buildKey: (userId: string, sessionId: string) => `sessions:user:active:${userId}:${sessionId}`,
  }),
  passwordChangedAt: defineKey({
    schema: z.coerce.number(),
    ttl: SESSION_MAX_AGE_SECONDS,
    buildKey: (userId: string) => `auth:pw-changed:${userId}`,
  }),
} as const;

type Registry = typeof REDIS_REGISTRY;

export async function redisGet<K extends keyof Registry>(
  redis: Redis,
  keyName: K,
  ...args: Parameters<Registry[K]['buildKey']>
): Promise<z.infer<Registry[K]['schema']> | null> {
  const entry = REDIS_REGISTRY[keyName];
  const redisKey = (entry.buildKey as (...a: unknown[]) => string)(...args);
  const stored = await redis.get(redisKey);
  if (stored === null) return null;
  return entry.schema.parse(stored) as z.infer<Registry[K]['schema']>;
}

interface SetOptions {
  ttlOverride?: number;
}

export async function redisSet<K extends keyof Registry>(
  redis: Redis,
  keyName: K,
  value: z.infer<Registry[K]['schema']>,
  ...args: [...Parameters<Registry[K]['buildKey']>, SetOptions?]
): Promise<void> {
  const entry = REDIS_REGISTRY[keyName];

  const lastArgument = args.at(-1);
  const hasOptions = typeof lastArgument === 'object' && 'ttlOverride' in lastArgument;
  const options = hasOptions ? lastArgument : undefined;
  const buildArgs = hasOptions ? args.slice(0, -1) : args;

  entry.schema.parse(value);
  const redisKey = (entry.buildKey as (...a: unknown[]) => string)(...buildArgs);
  const ttl = options?.ttlOverride ?? entry.ttl;
  await redis.set(redisKey, value, { ex: ttl });
}

type RateLimitKeyName = {
  [K in keyof Registry]: Registry[K] extends { rateLimitConfig: unknown } ? K : never;
}[keyof Registry];

/**
 * Type-safe redis set for rate-limit keys whose schema is always rateLimitDataSchema.
 * Avoids the generic inference limitation where TypeScript cannot resolve
 * z.infer<Registry[K]['schema']> when K is a generic bounded to a union.
 */
export async function redisSetRateLimitData<K extends RateLimitKeyName>(
  redis: Redis,
  keyName: K,
  value: z.infer<typeof rateLimitDataSchema>,
  ...args: [...Parameters<Registry[K]['buildKey']>, SetOptions?]
): Promise<void> {
  const entry = REDIS_REGISTRY[keyName];

  const lastArgument = args.at(-1);
  const hasOptions = typeof lastArgument === 'object' && 'ttlOverride' in lastArgument;
  const options = hasOptions ? lastArgument : undefined;
  const buildArgs = hasOptions ? args.slice(0, -1) : args;

  rateLimitDataSchema.parse(value);
  const redisKey = (entry.buildKey as (...a: unknown[]) => string)(...buildArgs);
  const ttl = options?.ttlOverride ?? entry.ttl;
  await redis.set(redisKey, value, { ex: ttl });
}

export async function redisDel<K extends keyof Registry>(
  redis: Redis,
  keyName: K,
  ...args: Parameters<Registry[K]['buildKey']>
): Promise<void> {
  const entry = REDIS_REGISTRY[keyName];
  const redisKey = (entry.buildKey as (...a: unknown[]) => string)(...args);
  await redis.del(redisKey);
}

const INCR_BY_FLOAT_SCRIPT = `
local val = redis.call("INCRBYFLOAT", KEYS[1], ARGV[1])
local num = tonumber(val)
if num <= 0 then
  redis.call("DEL", KEYS[1])
  return "0"
end
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
return val
`;

export async function redisIncrByFloat<K extends keyof Registry>(
  redis: Redis,
  keyName: K,
  increment: number,
  ...args: Parameters<Registry[K]['buildKey']>
): Promise<number> {
  const entry = REDIS_REGISTRY[keyName];
  const redisKey = (entry.buildKey as (...a: unknown[]) => string)(...args);
  const result = await redis.eval(
    INCR_BY_FLOAT_SCRIPT,
    [redisKey],
    [String(increment), String(entry.ttl)]
  );
  return Number(result);
}
