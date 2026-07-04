import { z } from 'zod';
import { okAsync } from '../../../lib/result/index.js';
import { defineRateLimitKey, redisIncr, redisTtl } from '../../../lib/redis/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RateLimitConfig } from '../../../lib/redis/index.js';
import type { Variables } from '../../../lib/context/index.js';

/**
 * The media slice's rate-limit registry entries.
 *
 * `mediaDownloadUserRateLimit` (per caller — userId or `link:<linkId>`) and
 * `sharePresignIpRateLimit` (per IP on the unauthenticated share path) are
 * registry entries only: enforcement lands with the edge rate-limit
 * enforcer, mirroring the conversations slice's `publicShareReadRateLimit`.
 * Windows preserve the legacy registry's values (presign minting 60/min per
 * caller; the share IP cap mirrors the public share read's 30/min).
 *
 * `sharePresignRemintRateLimit` is enforced HERE (route-behavioral): a
 * shareId is an unauthenticated capability, so unlimited re-mints would let
 * one leaked share hammer the signing path and re-arm ciphertext URLs
 * indefinitely; the edge enforcer's per-IP cap does not bound a distributed
 * caller, the per-shareId counter does.
 */

/** The per-request Redis client as the pipeline types it (boundaries: the infra module stays in adapters/lib). */
export type RedisClient = Variables['redis'];

const windowCounterSchema = z.object({
  count: z.number(),
  firstAttempt: z.number(),
});

/**
 * Plain INCR counter (coerced: the Upstash client JSON-parses the stored
 * integer string) — the re-mint cap counts N racing mints as exactly N.
 */
const remintCounterSchema = z.coerce.number();

export const MEDIA_RATE_LIMITS = {
  mediaDownloadUserRateLimit: defineRateLimitKey({
    schema: windowCounterSchema,
    ttlSeconds: 60,
    buildKey: (callerId: string) => `media:download:user:ratelimit:${callerId}`,
    rateLimitConfig: { maxAttempts: 60, windowSeconds: 60 },
  }),
  sharePresignIpRateLimit: defineRateLimitKey({
    schema: windowCounterSchema,
    ttlSeconds: 60,
    buildKey: (ipHash: string) => `media:share:presign:ip:ratelimit:${ipHash}`,
    rateLimitConfig: { maxAttempts: 30, windowSeconds: 60 },
  }),
  sharePresignRemintRateLimit: defineRateLimitKey({
    schema: remintCounterSchema,
    ttlSeconds: 60,
    buildKey: (shareId: string) => `media:share:presign:remint:ratelimit:${shareId}`,
    rateLimitConfig: { maxAttempts: 30, windowSeconds: 60 },
  }),
} as const;

export type RemintDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * Attempt-reservation arithmetic: `count` INCLUDES the mint being decided
 * (the caller reserved it with an atomic increment), so the gate is
 * `count > maxAttempts` and exactly `maxAttempts` mints pass per window no
 * matter how many race. An unexpiring counter answers the full window,
 * conservatively. Pure so the arithmetic is unit-testable without Redis.
 */
export function evaluateRemint(
  count: number,
  remainingSeconds: number | null,
  config: RateLimitConfig
): RemintDecision {
  if (count <= config.maxAttempts) return { allowed: true };
  return { allowed: false, retryAfterSeconds: remainingSeconds ?? config.windowSeconds };
}

/** Reserves one presign re-mint for the shareId before any authorization runs. */
export function reserveShareRemint(
  redis: RedisClient,
  shareId: string
): ResultAsync<RemintDecision, DomainError> {
  const definition = MEDIA_RATE_LIMITS.sharePresignRemintRateLimit;
  return redisIncr(redis, definition, shareId).andThen((count) => {
    if (count <= definition.rateLimitConfig.maxAttempts) {
      return okAsync<RemintDecision, DomainError>({ allowed: true });
    }
    return redisTtl(redis, definition, shareId).map((remainingSeconds) =>
      evaluateRemint(count, remainingSeconds, definition.rateLimitConfig)
    );
  });
}
