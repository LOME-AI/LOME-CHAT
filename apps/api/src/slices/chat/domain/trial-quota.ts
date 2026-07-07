import { z } from 'zod';
import { TRIAL_MESSAGE_LIMIT, secondsUntilNextUtcMidnight } from '@hushbox/shared';
import { defineKey } from '../../../lib/redis/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { Variables } from '../../../lib/context/index.js';

/**
 * The trial 5/day quota — the dual-identity anti-evasion gate that lives in the
 * trial ROUTE (it holds both the client's `x-trial-token` and the request IP,
 * which the admission hook cannot see). It increments a per-session and a
 * per-IP counter and compares the HIGHER against the limit: a rotated token
 * resets the session count, but the IP count still catches the evasion.
 */

/** The per-request Redis client as the pipeline types it (boundaries: domain never imports infra). */
type RedisClient = Variables['redis'];

/** A full UTC day bounds each counter; the live expiry is aligned to the next UTC midnight. */
const DAILY_TTL_SECONDS = 24 * 60 * 60;

/** Upstash JSON-parses the stored integer string; coerce it back to a number. */
const trialCountSchema = z.coerce.number().int().nonnegative();

export const TRIAL_QUOTA_KEYS = {
  /** Per trial-session id (the `x-trial-token`, or a freshly minted uuid). */
  session: defineKey({
    schema: trialCountSchema,
    ttlSeconds: DAILY_TTL_SECONDS,
    buildKey: (sessionId: string) => `trial:usage:session:${sessionId}`,
  }),
  /** Per client-IP (SHA-256 hash) — the identity a rotated token cannot dodge. */
  ip: defineKey({
    schema: trialCountSchema,
    ttlSeconds: DAILY_TTL_SECONDS,
    buildKey: (ipHash: string) => `trial:usage:ip:${ipHash}`,
  }),
} as const;

export interface TrialQuotaResult {
  readonly allowed: boolean;
  readonly count: number;
}

export interface ConsumeTrialQuotaArgs {
  readonly sessionId: string;
  readonly ipHash: string;
}

async function incrWithMidnightTtl(redis: RedisClient, key: string): Promise<number> {
  const count = await redis.incr(key);
  // NX anchors the expiry at the first increment — a full day's window resets at
  // one UTC midnight and a later increment never extends it (the free-tier
  // period-key discipline; no reset jobs) — and repairs a counter whose creator
  // crashed before its EXPIRE landed.
  await redis.expire(key, secondsUntilNextUtcMidnight(), 'NX');
  return count;
}

/**
 * Consume one trial message slot across BOTH identities atomically: increment
 * the session and IP counters, then compare the higher against the daily limit.
 * Increment-then-check has no check-then-act race. Redis down fails closed
 * (typed `unavailable`) — the trial send is refused, never silently admitted.
 */
export function consumeTrialQuota(
  redis: RedisClient,
  args: ConsumeTrialQuotaArgs
): ResultAsync<TrialQuotaResult, DomainError> {
  return fromPromise(
    (async (): Promise<TrialQuotaResult> => {
      const [sessionCount, ipCount] = await Promise.all([
        incrWithMidnightTtl(redis, TRIAL_QUOTA_KEYS.session.buildKey(args.sessionId)),
        incrWithMidnightTtl(redis, TRIAL_QUOTA_KEYS.ip.buildKey(args.ipHash)),
      ]);
      const count = Math.max(sessionCount, ipCount);
      return { allowed: count <= TRIAL_MESSAGE_LIMIT, count };
    })(),
    (cause): DomainError => unavailableError('trial quota check failed', cause)
  );
}

const encoder = new TextEncoder();

/** SHA-256 hex of the client IP — the anti-evasion counter never stores a raw IP. */
export async function hashIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(ip));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
