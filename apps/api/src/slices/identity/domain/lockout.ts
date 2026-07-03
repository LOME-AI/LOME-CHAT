import { okAsync } from '../../../lib/result/index.js';
import { redisDel, redisIncr, redisTtl } from '../../../lib/redis/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RateLimitConfig, RateLimitKeyDefinition } from '../../../lib/redis/index.js';
import type { lockoutCounterSchema, RedisClient } from './keys.js';

type LockoutDefinition = RateLimitKeyDefinition<typeof lockoutCounterSchema, [string]>;

export type LockoutDecision =
  | { readonly lockedOut: false }
  | { readonly lockedOut: true; readonly retryAfterSeconds: number };

/**
 * Attempt-reservation evaluation (distinct from the advisory
 * `evaluateWindow`): `count` INCLUDES the attempt being decided — the caller
 * reserved it with an atomic increment before asking — so the gate is
 * `count > maxAttempts`, admitting exactly `maxAttempts` verifications per
 * window no matter how many run concurrently. `remainingSeconds` is the
 * counter key's TTL; a counter that is somehow unexpiring answers the full
 * window, conservatively. Pure so the cap arithmetic is unit-testable
 * without Redis.
 */
export function evaluateLockout(
  count: number,
  remainingSeconds: number | null,
  config: RateLimitConfig
): LockoutDecision {
  if (count <= config.maxAttempts) return { lockedOut: false };
  return { lockedOut: true, retryAfterSeconds: remainingSeconds ?? config.windowSeconds };
}

/**
 * Reserves one verification attempt BEFORE any checking or verifying runs:
 * the atomic increment is itself the gate, so N concurrent attempts observe
 * N distinct counts and at most `maxAttempts` of them are ever admitted to
 * verification — a check-then-verify read would let every racer through.
 * Because every attempt increments (there is no locked fast-path that skips
 * it), the EXPIRE-NX self-repair inside the increment fires on every
 * attempt. A denied attempt still advances the count but never the TTL —
 * fail-closed, bounded by the window anchored at the first attempt. A
 * verified success clears the whole counter via `clearLockout`; the slot it
 * reserved is not refunded individually.
 */
export function reserveAttempt(
  redis: RedisClient,
  definition: LockoutDefinition,
  identifier: string
): ResultAsync<LockoutDecision, DomainError> {
  return redisIncr(redis, definition, identifier).andThen((count) => {
    if (count <= definition.rateLimitConfig.maxAttempts) {
      return okAsync<LockoutDecision, DomainError>({ lockedOut: false });
    }
    return redisTtl(redis, definition, identifier).map((remainingSeconds) =>
      evaluateLockout(count, remainingSeconds, definition.rateLimitConfig)
    );
  });
}

/** Clears the attempt counter (call on a verified success). */
export function clearLockout(
  redis: RedisClient,
  definition: LockoutDefinition,
  identifier: string
): ResultAsync<void, DomainError> {
  return redisDel(redis, definition, identifier);
}
