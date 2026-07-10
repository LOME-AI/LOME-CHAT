import { z } from 'zod';

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

/**
 * The per-user active-DO/room set (ARCHITECTURE §15): a Redis SET holding the
 * conversationIds a real authenticated user currently has a live WebSocket in.
 * The ConversationRoom DO SADDs on WS accept and SREMs when the user's last
 * socket in a room closes; a session revocation reads it (SMEMBERS) to fan an
 * eviction out to exactly those rooms. It has no dedicated apps/api slice, so
 * the entry lives here alongside the registry mechanism.
 *
 * Expiry policy — the correctness bias is that under-inclusion leaks plaintext
 * while over-inclusion is a harmless evict-empty-room no-op, so the set is
 * SREM-driven and must NOT expire out from under a live connection. `ttlSeconds`
 * is therefore a long crash-orphan backstop (refreshed on each SADD) that
 * reclaims a set only if a DO died without ever SREMing; any stale member it
 * leaves is safe.
 */
export const REALTIME_REDIS_KEYS = {
  userActiveRooms: defineKey({
    schema: z.string(),
    ttlSeconds: 24 * 60 * 60,
    buildKey: (userId: string) => `realtime:user-active-rooms:${userId}`,
  }),
} as const;
