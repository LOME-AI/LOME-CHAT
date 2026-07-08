import { z } from 'zod';
import { okAsync } from '../../../lib/result/index.js';
import { defineRateLimitKey, redisIncr, redisTtl } from '../../../lib/redis/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RateLimitConfig } from '../../../lib/redis/index.js';
import type { Variables } from '../../../lib/context/index.js';

/**
 * The trial send's per-IP BURST throttle — an abuse cap distinct from the 5/day
 * quota (`trial-quota.ts`). The quota bounds daily spend across two identities;
 * this bounds request RATE from one source so a flood is refused cheaply,
 * before the expensive catalog read and before any daily slot is consumed. It
 * is an advisory fixed window (increment-then-compare); the ledger of daily use
 * is the quota, not this counter.
 */

/** The per-request Redis client as the pipeline types it (boundaries: domain never imports infra). */
type RedisClient = Variables['redis'];

/** Plain INCR counter (coerced: the Upstash client JSON-parses the stored integer string). */
const burstCounterSchema = z.coerce.number();

export const TRIAL_BURST_RATE_LIMIT = defineRateLimitKey({
  schema: burstCounterSchema,
  ttlSeconds: 60,
  buildKey: (ipHash: string) => `trial:burst:ip:ratelimit:${ipHash}`,
  rateLimitConfig: { maxAttempts: 20, windowSeconds: 60 },
});

export type TrialBurstDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * The window arithmetic: `count` INCLUDES the send being decided (the caller
 * reserved it with an atomic increment), so the gate is `count > maxAttempts`
 * and exactly `maxAttempts` sends pass per window under any concurrency. A
 * counter with no remaining expiry answers the full window, conservatively.
 * Pure so the arithmetic is unit-testable without Redis.
 */
export function evaluateTrialBurst(
  count: number,
  remainingSeconds: number | null,
  config: RateLimitConfig
): TrialBurstDecision {
  if (count <= config.maxAttempts) return { allowed: true };
  return { allowed: false, retryAfterSeconds: remainingSeconds ?? config.windowSeconds };
}

/**
 * Reserves one trial send for the hashed IP before the catalog read. The INCR
 * is atomic (`EXPIRE … NX` anchors the window at the first send, never
 * extending it); Redis down fails closed (typed `unavailable`) — the send is
 * refused, never admitted unbounded.
 */
export function consumeTrialBurst(
  redis: RedisClient,
  ipHash: string
): ResultAsync<TrialBurstDecision, DomainError> {
  return redisIncr(redis, TRIAL_BURST_RATE_LIMIT, ipHash).andThen((count) => {
    if (count <= TRIAL_BURST_RATE_LIMIT.rateLimitConfig.maxAttempts) {
      return okAsync<TrialBurstDecision, DomainError>({ allowed: true });
    }
    return redisTtl(redis, TRIAL_BURST_RATE_LIMIT, ipHash).map((remainingSeconds) =>
      evaluateTrialBurst(count, remainingSeconds, TRIAL_BURST_RATE_LIMIT.rateLimitConfig)
    );
  });
}
