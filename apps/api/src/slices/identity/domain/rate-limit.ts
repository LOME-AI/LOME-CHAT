import { okAsync } from '../../../lib/result/index.js';
import { redisGet, redisSet } from '../../../lib/redis/index.js';
import type { z } from 'zod';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RateLimitConfig, RateLimitKeyDefinition } from '../../../lib/redis/index.js';
import type { rateLimitWindowSchema, RedisClient } from './keys.js';

type WindowState = z.infer<typeof rateLimitWindowSchema>;

export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface WindowEvaluation {
  readonly decision: RateLimitDecision;
  /** The state to persist, or null when the attempt was denied (no write). */
  readonly nextState: WindowState | null;
}

/**
 * Fixed-window evaluation (legacy-compatible semantics): the window opens at
 * the first attempt and every attempt inside it counts; a denied attempt
 * does not extend the window. Pure so the timing arithmetic is unit-testable
 * without Redis.
 */
export function evaluateWindow(
  stored: WindowState | null,
  config: RateLimitConfig,
  now: number
): WindowEvaluation {
  const fresh: WindowEvaluation = {
    decision: { allowed: true },
    nextState: { count: 1, firstAttempt: now },
  };
  if (stored === null) return fresh;
  const windowExpiry = stored.firstAttempt + config.windowSeconds * 1000;
  if (now > windowExpiry) return fresh;
  if (stored.count >= config.maxAttempts) {
    return {
      decision: { allowed: false, retryAfterSeconds: Math.ceil((windowExpiry - now) / 1000) },
      nextState: null,
    };
  }
  return {
    decision: { allowed: true },
    nextState: { count: stored.count + 1, firstAttempt: stored.firstAttempt },
  };
}

/**
 * One attempt against a registry-defined fixed window: read the stored
 * window, evaluate, persist the advanced state only when the attempt is
 * admitted (a denied attempt never extends the window).
 *
 * The read→evaluate→write is not atomic: concurrent attempts can each read
 * the same count and both admit, so the effective limit can overshoot by the
 * number of in-flight requests. Accepted (and legacy parity) — this is
 * advisory abuse-throttling, not a hard security boundary, and the overshoot
 * is bounded by concurrency, not unbounded. A Lua CAS would remove it if the
 * limit ever needs to be exact.
 */
export function consumeRateLimit(
  redis: RedisClient,
  definition: RateLimitKeyDefinition<typeof rateLimitWindowSchema, [string]>,
  identifier: string,
  now: number
): ResultAsync<RateLimitDecision, DomainError> {
  return redisGet(redis, definition, identifier).andThen((stored) => {
    const { decision, nextState } = evaluateWindow(stored, definition.rateLimitConfig, now);
    if (nextState === null) return okAsync(decision);
    return redisSet(redis, definition, nextState, identifier).map(() => decision);
  });
}
