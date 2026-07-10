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

/**
 * The IPv6 prefix width the trial counters key on. An operator routes a whole
 * /64 (its lower 64 bits — 4 of the 8 hextets) to a single subscriber, so an
 * attacker owning one /64 can mint billions of distinct addresses. Zeroing the
 * host bits before hashing collapses that whole subnet onto one counter, which
 * is the identity a rotated address cannot dodge — the IPv6 analogue of the
 * per-IPv4 counter.
 */
const IPV6_PREFIX_HEXTETS = 4;
const IPV6_HEXTETS = 8;

/** Parse a dotted-quad into its four octets, or null if it is not a valid IPv4. */
function ipv4Octets(text: string): readonly number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Parse one colon-delimited token into the hextet(s) it contributes: a plain
 *  hex token yields one hextet; a trailing dotted-quad (IPv4-in-IPv6) yields two.
 *  Null on any malformed token. */
function parseHextetToken(token: string, isLast: boolean): number[] | null {
  if (token.includes('.')) {
    // A dotted-quad may appear only as the trailing token (the IPv4-in-IPv6 form).
    if (!isLast) return null;
    const octets = ipv4Octets(token);
    if (octets === null) return null;
    const [a, b, c, d] = octets as [number, number, number, number];
    return [(a << 8) | b, (c << 8) | d];
  }
  if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
  return [Number.parseInt(token, 16)];
}

/** Parse a colon-run of an IPv6 address into hextets; an embedded dotted-quad
 *  tail (only valid as the final token) contributes its two 16-bit halves. */
function parseHextetRun(run: string): number[] | null {
  if (run === '') return [];
  const tokens = run.split(':');
  const hextets: number[] = [];
  for (const [index, token] of tokens.entries()) {
    const parsed = parseHextetToken(token, index === tokens.length - 1);
    if (parsed === null) return null;
    hextets.push(...parsed);
  }
  return hextets;
}

/** Expand a `::`-compressed address (the runs before and after the `::`) into
 *  eight hextets, zero-filling the elided middle, or null if the two runs are
 *  malformed or together exceed eight hextets. */
function expandCompressed(before: string, after: string): readonly number[] | null {
  const head = parseHextetRun(before);
  const tail = parseHextetRun(after);
  if (head === null || tail === null) return null;
  const fill = IPV6_HEXTETS - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

/**
 * Parse an IPv6 literal into its eight 16-bit hextets, or null if it is not a
 * well-formed IPv6 address (a plain IPv4 address returns null — it is hashed
 * verbatim). Handles `::` zero-compression and an embedded IPv4 tail.
 */
function ipv6Hextets(ip: string): readonly number[] | null {
  if (!ip.includes(':')) return null;
  const address = ip.replace(/%.*$/, ''); // drop any zone id (fe80::1%eth0)
  const compress = address.indexOf('::');

  if (compress === -1) {
    const hextets = parseHextetRun(address);
    return hextets?.length === IPV6_HEXTETS ? hextets : null;
  }
  if (address.includes('::', compress + 1)) return null; // a second '::' is illegal
  return expandCompressed(address.slice(0, compress), address.slice(compress + 2));
}

/** Canonical /64 network prefix: the first four hextets, zero-padded lowercase. */
function ipv6PrefixKey(hextets: readonly number[]): string {
  return hextets
    .slice(0, IPV6_PREFIX_HEXTETS)
    .map((hextet) => hextet.toString(16).padStart(4, '0'))
    .join(':');
}

/**
 * SHA-256 hex of the client IP — the anti-evasion counter never stores a raw
 * IP. An IPv6 address is first reduced to its /64 network prefix so an attacker
 * cannot rotate the host bits for a fresh counter per request; IPv4 (and any
 * unparseable value, including the `0.0.0.0` sentinel) is hashed verbatim.
 */
export async function hashIp(ip: string): Promise<string> {
  const hextets = ipv6Hextets(ip);
  const canonical = hextets === null ? ip : ipv6PrefixKey(hextets);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
