import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { z } from 'zod';
import { createApp } from './app.js';
import { hashRateLimitId } from './middleware/rate-limit.js';
import { publicShareReadRateLimit } from './slices/conversations/index.js';
import type { Bindings } from './lib/context/index.js';
import type { TelemetryEnv } from './lib/telemetry/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`share-read rate-limit tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');
const UPSTASH_REDIS_REST_URL = requiredEnv('UPSTASH_REDIS_REST_URL');
const UPSTASH_REDIS_REST_TOKEN = requiredEnv('UPSTASH_REDIS_REST_TOKEN');

const devEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
};

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const refusalBodySchema = z.object({
  code: z.string(),
  details: z.object({ retryAfterSeconds: z.number() }),
});

// A per-run-unique caller identity, hashed into the limiter key and never
// parsed as an IP (`resolveClientIp` returns `cf-connecting-ip` verbatim). A
// uuid guarantees no window is shared with a parallel worker or a prior run.
const IP = `share-read-ratelimit-test-${crypto.randomUUID()}`;

async function limiterKey(): Promise<string> {
  const ipHash = await hashRateLimitId(IP);
  return publicShareReadRateLimit.buildKey(ipHash);
}

// Flush before as well as after: a leftover window from a crashed prior run
// must not pollute the under-cap admission below.
beforeAll(async () => {
  await redis.del(await limiterKey());
});
afterAll(async () => {
  await redis.del(await limiterKey());
});

// The cap mounts at the composition root (app.ts), not in the slice manifest,
// so only a request through the real composed app proves the mounted path
// matches the route — a path typo there would silently unprotect the route.
// Accumulating the cap by firing `maxAttempts` real requests straddles the
// fixed window under parallel load (30 composed-app requests can exceed the
// 60s window, rolling it over mid-test); instead the window is pinned at the
// cap with a fresh `firstAttempt`, so the refused request is deterministic —
// the same seed-then-refuse pattern the limiter's own window-arithmetic test
// uses. The full accumulation path stays covered by the middleware
// integration suite's edge-limiter case for this same limiter.
describe('composed app: public share read per-IP cap', () => {
  it('admits an under-cap GET from one IP, then refuses one at the cap with 429 RATE_LIMITED', async () => {
    const app = createApp();
    const path = `/conversations/shared/message/${crypto.randomUUID()}`;
    const headers = { 'cf-connecting-ip': IP };
    const { maxAttempts, windowSeconds } = publicShareReadRateLimit.rateLimitConfig;

    // Under the cap: a fresh window admits the request past the limiter (the
    // fake link 404s, but never 429s).
    const admitted = await app.request(path, { headers }, devEnv);
    expect(admitted.status).not.toBe(429);

    // At the cap: pin the window to `maxAttempts` with a fresh `firstAttempt`,
    // so it is guaranteed open (no wall-clock straddle) and the next request
    // through the mounted path is deterministically refused.
    await redis.set(
      await limiterKey(),
      { count: maxAttempts, firstAttempt: Date.now() },
      { ex: windowSeconds }
    );

    const refused = await app.request(path, { headers }, devEnv);
    expect(refused.status).toBe(429);
    const body = refusalBodySchema.parse(await refused.json());
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.details.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
  });
});
