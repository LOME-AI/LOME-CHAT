import { afterAll, describe, expect, it } from 'vitest';
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

// Unique per run so a concurrent suite never shares this window.
function randomOctet(): string {
  return String(Math.floor(Math.random() * 255));
}
const IP = `10.9.${randomOctet()}.${randomOctet()}`;

afterAll(async () => {
  await redis.del(publicShareReadRateLimit.buildKey(await hashRateLimitId(IP)));
});

// The cap mounts at the composition root (app.ts), not in the slice manifest,
// so only a request through the real composed app proves the mounted path
// matches the route — a path typo there would silently unprotect the route.
describe('composed app: public share read per-IP cap', () => {
  it('admits maxAttempts GETs from one IP, then refuses with 429 RATE_LIMITED', async () => {
    const app = createApp();
    const path = `/conversations/shared/message/${crypto.randomUUID()}`;
    const headers = { 'cf-connecting-ip': IP };
    const { maxAttempts, windowSeconds } = publicShareReadRateLimit.rateLimitConfig;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const res = await app.request(path, { headers }, devEnv);
      // Admitted past the limiter: the fake link 404s, but never 429s.
      expect(res.status).not.toBe(429);
    }

    const refused = await app.request(path, { headers }, devEnv);
    expect(refused.status).toBe(429);
    const body = refusalBodySchema.parse(await refused.json());
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.details.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
  });
});
