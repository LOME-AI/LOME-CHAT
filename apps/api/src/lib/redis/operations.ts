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

export function redisDel<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): ResultAsync<void, DomainError> {
  return fromPromise(redis.del(definition.buildKey(...args)), (cause) =>
    unavailableError('redis del failed', cause)
  ).map((): void => undefined);
}
