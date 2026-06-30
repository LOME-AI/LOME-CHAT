import type { z } from 'zod';

/**
 * The typed Redis key-registry mechanism (doctrine: Redis keys exist only as
 * typed key-registry entries — schema + TTL + buildKey). Slices declare their
 * own entries with these helpers; this module owns the mechanism only.
 */
export interface RedisKeyDefinition<TSchema extends z.ZodType, TArgs extends readonly unknown[]> {
  readonly schema: TSchema;
  readonly ttlSeconds: number;
  readonly buildKey: (...args: TArgs) => string;
}

export interface RateLimitConfig {
  readonly maxAttempts: number;
  readonly windowSeconds: number;
  readonly lockoutSeconds?: number;
}

export interface RateLimitKeyDefinition<
  TSchema extends z.ZodType,
  TArgs extends readonly unknown[],
> extends RedisKeyDefinition<TSchema, TArgs> {
  readonly rateLimitConfig: RateLimitConfig;
}

export function defineKey<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  definition: RedisKeyDefinition<TSchema, TArgs>
): RedisKeyDefinition<TSchema, TArgs> {
  return definition;
}

export function defineRateLimitKey<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  definition: RateLimitKeyDefinition<TSchema, TArgs>
): RateLimitKeyDefinition<TSchema, TArgs> {
  return definition;
}
