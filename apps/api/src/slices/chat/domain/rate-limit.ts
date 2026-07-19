import { z } from 'zod';
import { okAsync } from '../../../lib/result/index.js';
import { defineRateLimitKey, redisIncr, redisTtl } from '../../../lib/redis/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RateLimitConfig, RateLimitKeyDefinition } from '../../../lib/redis/index.js';
import type { Variables } from '../../../lib/context/index.js';

/**
 * The chat slice's Redis reserve-before-verify throttle — an advisory fixed
 * window (increment-then-compare) for the paid send's per-user rate limit. It
 * fails closed: Redis down refuses the send, never admits it unbounded.
 */

/** The per-request Redis client as the pipeline types it (boundaries: domain never imports infra). */
type RedisClient = Variables['redis'];

/** Plain INCR counter (coerced: the Upstash client JSON-parses the stored integer string). */
const counterSchema = z.coerce.number();

/**
 * The paid chat send's per-user rate limit — 30 sends / 60s per user, keyed by
 * the authenticated caller. Enforced by the edge rate-limit middleware mounted
 * on `/chat` and `/chat/regenerate` before context resolution and turn build;
 * the guest send path enforces it in-handler (its key is the DB-resolved
 * linkId).
 */
export const CHAT_STREAM_USER_RATE_LIMIT = defineRateLimitKey({
  schema: counterSchema,
  ttlSeconds: 60,
  buildKey: (userId: string) => `chat:stream:user:ratelimit:${userId}`,
  rateLimitConfig: { maxAttempts: 30, windowSeconds: 60 },
});

export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * The window arithmetic: `count` INCLUDES the send being decided (the caller
 * reserved it with an atomic increment), so the gate is `count > maxAttempts`
 * and exactly `maxAttempts` sends pass per window under any concurrency. A
 * counter with no remaining expiry answers the full window, conservatively.
 * Pure so the arithmetic is unit-testable without Redis.
 */
export function evaluateReservation(
  count: number,
  remainingSeconds: number | null,
  config: RateLimitConfig
): RateLimitDecision {
  if (count <= config.maxAttempts) return { allowed: true };
  return { allowed: false, retryAfterSeconds: remainingSeconds ?? config.windowSeconds };
}

/**
 * Reserves one send against a rate-limit counter before the expensive work. The
 * INCR is atomic (`EXPIRE … NX` anchors the window at the first send, never
 * extending it); Redis down fails closed (typed `unavailable`) — the send is
 * refused, never admitted unbounded.
 */
function consumeReservation(
  redis: RedisClient,
  definition: RateLimitKeyDefinition<z.ZodType, [string]>,
  id: string
): ResultAsync<RateLimitDecision, DomainError> {
  return redisIncr(redis, definition, id).andThen((count) => {
    if (count <= definition.rateLimitConfig.maxAttempts) {
      return okAsync<RateLimitDecision, DomainError>({ allowed: true });
    }
    return redisTtl(redis, definition, id).map((remainingSeconds) =>
      evaluateReservation(count, remainingSeconds, definition.rateLimitConfig)
    );
  });
}

/** Reserves one paid chat send for the authenticated user before context resolution. */
export function consumeChatStreamUserLimit(
  redis: RedisClient,
  userId: string
): ResultAsync<RateLimitDecision, DomainError> {
  return consumeReservation(redis, CHAT_STREAM_USER_RATE_LIMIT, userId);
}
