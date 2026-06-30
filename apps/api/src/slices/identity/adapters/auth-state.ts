import { okAsync } from '../../../lib/result/index.js';
import { redisDel, redisGet, redisSet } from '../../../lib/redis/index.js';
import { IDENTITY_KEYS, rateLimitWindowSchema } from './keys.js';
import type { z } from 'zod';
import type { Redis } from '@upstash/redis';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RateLimitConfig, RedisKeyDefinition } from '../../../lib/redis/index.js';
import type { AuthStateStore, RateLimitDecision, RateLimitKind } from '../ports/index.js';

type WindowState = z.infer<typeof rateLimitWindowSchema>;

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

const RATE_LIMIT_KEYS = {
  login: IDENTITY_KEYS.loginRateLimit,
  register: IDENTITY_KEYS.registerRateLimit,
} as const satisfies Record<RateLimitKind, unknown>;

/**
 * Resolve-and-delete: the single-use contract of the `consume*` port
 * methods. Read-evaluate-write (not atomic) for the rate limiter — a racing
 * pair can each observe the same count, matching the legacy limiter's
 * accepted slack.
 */
function consumeState<TSchema extends z.ZodType>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, readonly [string]>,
  handshakeId: string
): ResultAsync<z.infer<TSchema> | null, DomainError> {
  return redisGet(redis, definition, handshakeId).andThen((state) => {
    if (state === null) return okAsync(null);
    return redisDel(redis, definition, handshakeId).map(() => state);
  });
}

/** Redis implementation of the ephemeral auth coordination state. */
export function createIdentityAuthState(redis: Redis): AuthStateStore {
  return {
    savePendingRegistration: (handshakeId, state) =>
      redisSet(redis, IDENTITY_KEYS.opaquePendingRegistration, state, handshakeId),
    consumePendingRegistration: (handshakeId) =>
      consumeState(redis, IDENTITY_KEYS.opaquePendingRegistration, handshakeId),
    savePendingLogin: (handshakeId, state) =>
      redisSet(redis, IDENTITY_KEYS.opaquePendingLogin, state, handshakeId),
    consumePendingLogin: (handshakeId) =>
      consumeState(redis, IDENTITY_KEYS.opaquePendingLogin, handshakeId),
    consumeRateLimit: (kind, identifier, now) => {
      const definition = RATE_LIMIT_KEYS[kind];
      return redisGet(redis, definition, identifier).andThen((stored) => {
        const { decision, nextState } = evaluateWindow(stored, definition.rateLimitConfig, now);
        if (nextState === null) return okAsync(decision);
        return redisSet(redis, definition, nextState, identifier).map(() => decision);
      });
    },
    clearRateLimit: (kind, identifier) => redisDel(redis, RATE_LIMIT_KEYS[kind], identifier),
  };
}
