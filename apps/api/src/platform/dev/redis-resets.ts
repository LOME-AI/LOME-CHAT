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
 * prefixes mirror the identity slice's key registry: the per-email/per-target
 * lockouts and throttles, the one-time TOTP markers, and the per-IP abuse
 * throttles on the unauthenticated auth surfaces (the `*:ip:ratelimit:*`
 * family from the identity rate-limit adapter). The E2E suite drives many
 * signups/logins from one localhost IP, so the per-IP buckets must be cleared
 * between tests or later flows trip 429 on the shared IP dimension.
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
    'login:ip:ratelimit:*',
    'register:ip:ratelimit:*',
    'recovery:ip:ratelimit:*',
    'recovery:getkey:ip:ratelimit:*',
    'verify:ip:ratelimit:*',
    'resend-verify:ip:ratelimit:*',
  ]);
}

/**
 * Reset usage-surface rate limits between tests. Deliberately does NOT clear
 * `billing:admission:*`: that state (per-wallet holds + balance snapshots +
 * scope counters) is global across every wallet, so a per-test wipe under
 * parallel Playwright workers races another worker's live admission — deleting
 * its snapshot mid-flow forces the fail-closed admission script to refuse with
 * a false INSUFFICIENT_ADMISSION. Admission state is instead cleared once per
 * run via `resetAdmissionState` (per-worker wallet isolation + the hold/snapshot
 * TTLs keep it clean during the run).
 */
export async function resetUsageRateLimits(redis: Redis): Promise<RedisResetResult> {
  return deleteRedisKeysByPrefixes(redis, [
    'chat:stream:user:ratelimit:*',
    'media:download:user:ratelimit:*',
    'media:share:presign:ip:ratelimit:*',
    'media:share:presign:remint:ratelimit:*',
    'conversations:share:read:ip:ratelimit:*',
  ]);
}

/**
 * Clear all billing admission state (per-wallet holds, scope holds, and balance
 * snapshots). Global by design — intended to run ONCE per E2E run to give a
 * clean baseline, never per-test (see `resetUsageRateLimits` for why a per-test
 * global wipe races parallel workers).
 */
export async function resetAdmissionState(redis: Redis): Promise<RedisResetResult> {
  return deleteRedisKeysByPrefixes(redis, ['billing:admission:*']);
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
