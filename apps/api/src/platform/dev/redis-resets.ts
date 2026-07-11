import type { Redis } from '@upstash/redis';

export interface RedisResetResult {
  deleted: number;
}

/**
 * SCAN `count` hint for the dev reset endpoints. Far above the production
 * default: each SCAN is one HTTP round-trip through the Serverless Redis
 * HTTP proxy, and under E2E saturation the round-trip count — not Redis
 * CPU — is the cost. Server-side MATCH still scopes the response to
 * matching keys. Dev-only; never runs against production Redis.
 */
const RESET_SCAN_COUNT = 1000;

async function deleteRedisKeysByPrefixes(
  redis: Redis,
  prefixes: readonly string[]
): Promise<RedisResetResult> {
  let deleted = 0;
  for (const prefix of prefixes) {
    let cursor: string | number = 0;
    do {
      const [nextCursor, keys]: [string, string[]] = await redis.scan(cursor, {
        match: prefix,
        count: RESET_SCAN_COUNT,
      });
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');
  }
  return { deleted };
}

/**
 * Reset all trial usage for testing. The new tree keys every trial counter
 * under `trial:` (session/IP quotas, the burst limiter, the daily global
 * spend cap), so one prefix covers the family.
 */
export async function resetTrialUsage(redis: Redis): Promise<RedisResetResult> {
  return deleteRedisKeysByPrefixes(redis, ['trial:*']);
}

/**
 * Reset auth-related rate limits, lockouts and TOTP replay markers. The
 * prefixes mirror the identity slice's key registry (lockouts, registration
 * and resend throttles, recovery lockouts, one-time TOTP markers).
 */
export async function resetAuthRateLimits(redis: Redis): Promise<RedisResetResult> {
  return deleteRedisKeysByPrefixes(redis, [
    'login:lockout:*',
    '2fa:lockout:*',
    'register:email:ratelimit:*',
    'resend-verify:email:ratelimit:*',
    'recovery:getkey:lockout:*',
    'recovery:reset:lockout:*',
    'delete-account:lockout:*',
    'totp:used:*',
  ]);
}

/**
 * Reset usage-surface rate limits and admission holds between tests. The
 * `billing:admission:*` prefix is the new-tree equivalent of the legacy
 * `chat:*reserved*` reservation keys (holds + snapshots + scope counters).
 */
export async function resetUsageRateLimits(redis: Redis): Promise<RedisResetResult> {
  return deleteRedisKeysByPrefixes(redis, [
    'chat:stream:user:ratelimit:*',
    'media:download:user:ratelimit:*',
    'media:share:presign:ip:ratelimit:*',
    'media:share:presign:remint:ratelimit:*',
    'conversations:share:read:ip:ratelimit:*',
    'billing:admission:*',
  ]);
}

/**
 * Delete a user's TOTP replay markers (`totp:used:{userId}:{code}`) so a
 * previously-accepted code can be presented again without waiting for the
 * next 30-second window. The markers enforce one-time use; clearing them
 * lets a flow reuse the current code while the real replay check and crypto
 * verification still run against it.
 */
export async function clearTotpReplayMarkers(
  redis: Redis,
  userId: string
): Promise<RedisResetResult> {
  return deleteRedisKeysByPrefixes(redis, [`totp:used:${userId}:*`]);
}
