import { unavailableError, validationError } from '../errors/index.js';
import { errAsync, fromPromise, okAsync } from '../result/index.js';
import type { Redis } from '@upstash/redis';
import type { z } from 'zod';
import type { DomainError } from '../errors/index.js';
import type { ResultAsync } from '../result/index.js';
import type { RedisKeyDefinition } from './define-key.js';

export function redisGet<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): ResultAsync<z.infer<TSchema> | null, DomainError> {
  return fromPromise(redis.get(definition.buildKey(...args)), (cause) =>
    unavailableError('redis get failed', cause)
  ).andThen((stored) => {
    if (stored === null) return okAsync(null);
    const parsed = definition.schema.safeParse(stored);
    return parsed.success
      ? okAsync(parsed.data)
      : errAsync(validationError('redis stored value failed schema validation', parsed.error));
  });
}

/**
 * Atomic single-use read: Redis `GETDEL` returns the value and removes the
 * key in one operation, so two concurrent callers on the same key can never
 * both observe it — exactly one wins the value, the other reads null. This is
 * the primitive a first-delivery claim on ephemeral state (an OPAQUE
 * handshake) is built on; a `GET`-then-`DEL` pair could let both win.
 */
export function redisGetDel<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): ResultAsync<z.infer<TSchema> | null, DomainError> {
  return fromPromise(redis.getdel(definition.buildKey(...args)), (cause) =>
    unavailableError('redis getdel failed', cause)
  ).andThen((stored) => {
    if (stored === null) return okAsync(null);
    const parsed = definition.schema.safeParse(stored);
    return parsed.success
      ? okAsync(parsed.data)
      : errAsync(validationError('redis stored value failed schema validation', parsed.error));
  });
}

export function redisSet<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  value: z.infer<TSchema>,
  ...args: TArgs
): ResultAsync<void, DomainError> {
  const parsed = definition.schema.safeParse(value);
  if (!parsed.success) {
    return errAsync(validationError('redis value failed schema validation', parsed.error));
  }
  return fromPromise(
    redis.set(definition.buildKey(...args), parsed.data, { ex: definition.ttlSeconds }),
    (cause) => unavailableError('redis set failed', cause)
  ).map((): void => undefined);
}

/**
 * Atomic conditional claim: Redis `SET … NX` writes only when the key is
 * absent and reports whether this caller's write won, so N concurrent
 * claimants on one key resolve to exactly one winner. This is the primitive a
 * first-use marker (a consumed TOTP code) is built on; a `GET`-then-`SET`
 * pair would let every racer through.
 */
export function redisSetNx<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  value: z.infer<TSchema>,
  ...args: TArgs
): ResultAsync<boolean, DomainError> {
  const parsed = definition.schema.safeParse(value);
  if (!parsed.success) {
    return errAsync(validationError('redis value failed schema validation', parsed.error));
  }
  return fromPromise(
    redis.set(definition.buildKey(...args), parsed.data, { nx: true, ex: definition.ttlSeconds }),
    (cause) => unavailableError('redis setnx failed', cause)
  ).map((reply) => reply === 'OK');
}

/**
 * Atomic counter advance: Redis `INCR` returns the post-increment count, so N
 * concurrent callers observe N distinct counts — the primitive an exact
 * failure-lockout is built on (a read-then-write window would collapse racing
 * failures into one). The definition's TTL is attached with `EXPIRE … NX`
 * (set only when no expiry exists), so the window is anchored at the first
 * increment and never extended; the extra call also repairs a counter whose
 * creator crashed before its EXPIRE landed.
 */
export function redisIncr<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): ResultAsync<number, DomainError> {
  const key = definition.buildKey(...args);
  return fromPromise(
    (async (): Promise<number> => {
      const count = await redis.incr(key);
      await redis.expire(key, definition.ttlSeconds, 'NX');
      return count;
    })(),
    (cause) => unavailableError('redis incr failed', cause)
  );
}

/**
 * Remaining lifetime of a key in whole seconds; null when the key is missing
 * or carries no expiry.
 */
export function redisTtl<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): ResultAsync<number | null, DomainError> {
  return fromPromise(redis.ttl(definition.buildKey(...args)), (cause) =>
    unavailableError('redis ttl failed', cause)
  ).map((seconds) => (seconds > 0 ? seconds : null));
}

export function redisDel<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): ResultAsync<void, DomainError> {
  return fromPromise(redis.del(definition.buildKey(...args)), (cause) =>
    unavailableError('redis del failed', cause)
  ).map((): void => undefined);
}
