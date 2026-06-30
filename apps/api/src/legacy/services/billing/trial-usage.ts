import { TRIAL_MESSAGE_LIMIT, secondsUntilNextUtcMidnight } from '@hushbox/shared';
import { REDIS_REGISTRY } from '../../lib/redis-registry.js';
import type { Redis } from '@upstash/redis';

export interface TrialUsageCheckResult {
  canSend: boolean;
  messageCount: number;
  limit: number;
}

/**
 * Atomically increment a Redis key and set TTL on first creation.
 * INCR on a non-existent key creates it at 1. TTL set only on first increment.
 */
async function incrWithTtl(redis: Redis, key: string, ttl: number): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, ttl);
  }
  return count;
}

/**
 * Atomically consume a trial message slot by incrementing counters first, then checking.
 * Eliminates the check-then-act race condition of separate check + increment.
 *
 * Dual-identity anti-evasion: increments both token and IP keys, uses the higher count.
 *
 * @param redis - Redis client
 * @param trialToken - Token stored in localStorage (may be null)
 * @param ipHash - SHA-256 hash of IP address
 * @returns Whether trial user can send and current message count
 */
export async function consumeTrialMessage(
  redis: Redis,
  trialToken: string | null,
  ipHash: string
): Promise<TrialUsageCheckResult> {
  const ttl = secondsUntilNextUtcMidnight();
  const ipKey = REDIS_REGISTRY.trialIpUsage.buildKey(ipHash);

  if (trialToken === null) {
    const ipCount = await incrWithTtl(redis, ipKey, ttl);
    return {
      canSend: ipCount <= TRIAL_MESSAGE_LIMIT,
      messageCount: ipCount,
      limit: TRIAL_MESSAGE_LIMIT,
    };
  }

  const tokenKey = REDIS_REGISTRY.trialTokenUsage.buildKey(trialToken);
  const [tokenCount, ipCount] = await Promise.all([
    incrWithTtl(redis, tokenKey, ttl),
    incrWithTtl(redis, ipKey, ttl),
  ]);

  const messageCount = Math.max(tokenCount, ipCount);
  return {
    canSend: messageCount <= TRIAL_MESSAGE_LIMIT,
    messageCount,
    limit: TRIAL_MESSAGE_LIMIT,
  };
}
