import {
  REDIS_REGISTRY,
  rateLimitDataSchema,
  redisGet,
  redisSet,
  redisSetRateLimitData,
  redisDel,
} from './redis-registry.js';
import type { Redis } from '@upstash/redis';
import type { z } from 'zod';

export interface RateLimitConfig {
  maxAttempts: number;
  windowSeconds: number;
  lockoutSeconds?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

export type LockoutResult = { lockedOut: false } | { lockedOut: true; retryAfterSeconds: number };

type RateLimitData = z.infer<typeof rateLimitDataSchema>;

export interface RateLimiter {
  config: RateLimitConfig;
}

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  return { config };
}

type RateLimitKeyName = {
  [K in keyof typeof REDIS_REGISTRY]: (typeof REDIS_REGISTRY)[K] extends {
    rateLimitConfig: unknown;
  }
    ? K
    : never;
}[keyof typeof REDIS_REGISTRY];

const LOCKOUT_KEY_NAMES = new Set([
  'loginLockout',
  'twoFactorLockout',
  'recoveryLockout',
  'deleteAccountLockout',
] as const);

type LockoutKeyName =
  | 'loginLockout'
  | 'twoFactorLockout'
  | 'recoveryLockout'
  | 'deleteAccountLockout';

export async function checkRateLimit<K extends RateLimitKeyName>(
  redis: Redis,
  keyName: K,
  ...args: Parameters<(typeof REDIS_REGISTRY)[K]['buildKey']>
): Promise<RateLimitResult> {
  const entry = REDIS_REGISTRY[keyName];
  if (!('rateLimitConfig' in entry)) {
    throw new Error(`Key ${keyName} is not a rate limit key`);
  }
  const config = entry.rateLimitConfig;

  const stored = await redisGet(redis, keyName, ...args);

  if (!stored) {
    const data: RateLimitData = {
      count: 1,
      firstAttempt: Date.now(),
    };
    await redisSetRateLimitData(redis, keyName, data, ...args);

    return {
      allowed: true,
      remaining: config.maxAttempts - 1,
    };
  }

  const data = rateLimitDataSchema.parse(stored);
  const windowExpiry = data.firstAttempt + config.windowSeconds * 1000;
  const now = Date.now();

  if (now > windowExpiry) {
    const newData: RateLimitData = {
      count: 1,
      firstAttempt: now,
    };
    await redisSetRateLimitData(redis, keyName, newData, ...args);

    return {
      allowed: true,
      remaining: config.maxAttempts - 1,
    };
  }

  if (data.count >= config.maxAttempts) {
    const retryAfterSeconds = Math.ceil((windowExpiry - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
    };
  }

  const newData: RateLimitData = {
    count: data.count + 1,
    firstAttempt: data.firstAttempt,
  };
  const remainingTtl = Math.ceil((windowExpiry - now) / 1000);
  await redisSetRateLimitData(redis, keyName, newData, ...args, { ttlOverride: remainingTtl });

  return {
    allowed: true,
    remaining: config.maxAttempts - newData.count,
  };
}

export async function recordFailedAttempt<
  K extends RateLimitKeyName,
  L extends LockoutKeyName | undefined = undefined,
>(
  redis: Redis,
  rateLimitKeyName: K,
  ...args: L extends LockoutKeyName
    ? [...Parameters<(typeof REDIS_REGISTRY)[K]['buildKey']>, L]
    : Parameters<(typeof REDIS_REGISTRY)[K]['buildKey']>
): Promise<{ lockoutTriggered: boolean }> {
  const entry = REDIS_REGISTRY[rateLimitKeyName];
  if (!('rateLimitConfig' in entry)) {
    throw new Error(`Key ${rateLimitKeyName} is not a rate limit key`);
  }
  const config = entry.rateLimitConfig;

  const lockoutKeyName = args.at(-1);
  const isLockoutKey =
    typeof lockoutKeyName === 'string' && LOCKOUT_KEY_NAMES.has(lockoutKeyName as LockoutKeyName);
  const buildArgs = isLockoutKey ? args.slice(0, -1) : args;

  const stored = await redisGet(
    redis,
    rateLimitKeyName,
    ...(buildArgs as Parameters<(typeof REDIS_REGISTRY)[K]['buildKey']>)
  );

  let data: RateLimitData;
  if (stored) {
    const existing = rateLimitDataSchema.parse(stored);
    const windowExpiry = existing.firstAttempt + config.windowSeconds * 1000;
    const now = Date.now();

    if (now > windowExpiry) {
      data = {
        count: 1,
        firstAttempt: now,
      };
    } else {
      data = {
        count: existing.count + 1,
        firstAttempt: existing.firstAttempt,
      };
    }
  } else {
    data = {
      count: 1,
      firstAttempt: Date.now(),
    };
  }

  await redisSetRateLimitData(
    redis,
    rateLimitKeyName,
    data,
    ...(buildArgs as Parameters<(typeof REDIS_REGISTRY)[K]['buildKey']>)
  );

  if (isLockoutKey && data.count >= config.maxAttempts) {
    const lockoutEntry = REDIS_REGISTRY[lockoutKeyName as LockoutKeyName];
    const lockoutUntil = Date.now() + lockoutEntry.ttl * 1000;
    await redisSet(
      redis,
      lockoutKeyName as LockoutKeyName,
      String(lockoutUntil),
      ...(buildArgs as Parameters<(typeof REDIS_REGISTRY)[LockoutKeyName]['buildKey']>)
    );
    return { lockoutTriggered: true };
  }

  return { lockoutTriggered: false };
}

export async function isLockedOut<K extends LockoutKeyName>(
  redis: Redis,
  lockoutKeyName: K,
  ...args: Parameters<(typeof REDIS_REGISTRY)[K]['buildKey']>
): Promise<LockoutResult> {
  const stored = await redisGet(redis, lockoutKeyName, ...args);

  if (!stored) {
    return { lockedOut: false };
  }

  const lockoutUntil = Number.parseInt(stored as string, 10);
  const now = Date.now();

  if (now >= lockoutUntil) {
    return { lockedOut: false };
  }

  const retryAfterSeconds = Math.ceil((lockoutUntil - now) / 1000);
  return {
    lockedOut: true,
    retryAfterSeconds,
  };
}

export async function clearLockout<
  K extends LockoutKeyName,
  R extends RateLimitKeyName | undefined = undefined,
>(
  redis: Redis,
  lockoutKeyName: K,
  ...args: R extends RateLimitKeyName
    ? [...Parameters<(typeof REDIS_REGISTRY)[K]['buildKey']>, R]
    : Parameters<(typeof REDIS_REGISTRY)[K]['buildKey']>
): Promise<void> {
  const rateLimitKeyName = args.at(-1);
  const isRateLimitKey = typeof rateLimitKeyName === 'string' && rateLimitKeyName in REDIS_REGISTRY;
  const buildArgs = isRateLimitKey ? args.slice(0, -1) : args;

  await redisDel(
    redis,
    lockoutKeyName,
    ...(buildArgs as Parameters<(typeof REDIS_REGISTRY)[K]['buildKey']>)
  );

  if (isRateLimitKey) {
    await redisDel(
      redis,
      rateLimitKeyName as RateLimitKeyName,
      ...(buildArgs as Parameters<(typeof REDIS_REGISTRY)[RateLimitKeyName]['buildKey']>)
    );
  }
}

export interface DualRateLimitParams {
  redis: Redis;
  userKeyName: RateLimitKeyName;
  ipKeyName: RateLimitKeyName;
  userIdentifier: string;
  ipHash: string;
}

export async function checkDualRateLimit(params: DualRateLimitParams): Promise<RateLimitResult> {
  const { redis, userKeyName, ipKeyName, userIdentifier, ipHash } = params;

  const userResult = await checkRateLimit(redis, userKeyName, userIdentifier);

  if (!userResult.allowed) {
    return userResult;
  }

  const ipResult = await checkRateLimit(redis, ipKeyName, ipHash);

  if (!ipResult.allowed) {
    return ipResult;
  }

  return {
    allowed: true,
    remaining: Math.min(userResult.remaining, ipResult.remaining),
  };
}

export interface DualFailedAttemptParams extends DualRateLimitParams {
  lockoutKeyName?: LockoutKeyName;
}

export async function recordDualFailedAttempt(
  params: DualFailedAttemptParams
): Promise<{ lockoutTriggered: boolean }> {
  const { redis, userKeyName, ipKeyName, userIdentifier, ipHash, lockoutKeyName } = params;

  const userResult = lockoutKeyName
    ? await recordFailedAttempt(redis, userKeyName, userIdentifier, lockoutKeyName)
    : await recordFailedAttempt(redis, userKeyName, userIdentifier);

  await recordFailedAttempt(redis, ipKeyName, ipHash);

  return { lockoutTriggered: userResult.lockoutTriggered };
}
