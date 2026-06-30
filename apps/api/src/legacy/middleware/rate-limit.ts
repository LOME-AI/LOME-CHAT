import { ERROR_CODE_RATE_LIMITED } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { getClientIp, hashIp } from '../lib/client-ip.js';
import type { AppEnv } from '../types.js';
import type { MiddlewareHandler } from 'hono';
import type { REDIS_REGISTRY } from '../lib/redis-registry.js';

type RateLimitKeyName = {
  [K in keyof typeof REDIS_REGISTRY]: (typeof REDIS_REGISTRY)[K] extends {
    rateLimitConfig: unknown;
  }
    ? K
    : never;
}[keyof typeof REDIS_REGISTRY];

/**
 * Per-caller rate limit middleware.
 *
 * Caps requests per principal per window using `c.var.callerId` — the
 * principal id set by `requirePrivilege` (user.id for session users, linkId
 * for link guests). Use for endpoints where the cost-amplification target is
 * bound to the caller (chat streaming → AI gateway calls, share creation →
 * DB writes, media presign → signing path).
 *
 * Must be mounted AFTER `requirePrivilege` on every route so `callerId` is
 * populated for both authenticated users and link guests. Throws an internal
 * error if `callerId` is missing — that signals a misconfigured route, not a
 * client problem.
 */
export function rateLimitByCaller(keyName: RateLimitKeyName): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const callerId = c.get('callerId');
    if (!callerId) {
      throw new Error(
        'rateLimitByCaller requires callerId — mount requirePrivilege before this middleware'
      );
    }
    const redis = c.get('redis');
    const result = await checkRateLimit(redis, keyName, callerId);
    if (!result.allowed) {
      return c.json(
        createErrorResponse(ERROR_CODE_RATE_LIMITED, {
          retryAfterSeconds: result.retryAfterSeconds,
        }),
        429
      );
    }
    return next();
  };
}

/**
 * Per-IP rate limit middleware.
 *
 * Caps requests per client IP per window. Use for unauthenticated endpoints
 * (public share lookup) where there is no user principal — the IP is the
 * only available identity. The IP is hashed before being used as a Redis
 * key to avoid storing raw addresses.
 */
export function rateLimitByIp(keyName: RateLimitKeyName): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const redis = c.get('redis');
    const ip = getClientIp(c);
    const ipHash = hashIp(ip);
    const result = await checkRateLimit(redis, keyName, ipHash);
    if (!result.allowed) {
      return c.json(
        createErrorResponse(ERROR_CODE_RATE_LIMITED, {
          retryAfterSeconds: result.retryAfterSeconds,
        }),
        429
      );
    }
    return next();
  };
}
