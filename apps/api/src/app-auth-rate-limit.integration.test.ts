import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { sealData } from 'iron-session';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, users } from '@hushbox/db';
import { toBase64 } from '@hushbox/shared';
import { createApp } from './app.js';
import { SESSION_COOKIE_NAME } from './middleware/pipeline-session.js';
import { hashRateLimitId } from './middleware/rate-limit.js';
import {
  loginIpRateLimit,
  recoveryGetKeyIpRateLimit,
  recoveryResetIpRateLimit,
  registerIpRateLimit,
  resendVerifyIpRateLimit,
  verifyEmailIpRateLimit,
} from './slices/identity/index.js';
import { shareCreateRateLimit } from './slices/conversations/index.js';
import type { WindowLimitDefinition } from './middleware/rate-limit.js';
import type { Bindings } from './lib/context/index.js';
import type { TelemetryEnv } from './lib/telemetry/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`auth rate-limit tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');
const UPSTASH_REDIS_REST_URL = requiredEnv('UPSTASH_REDIS_REST_URL');
const UPSTASH_REDIS_REST_TOKEN = requiredEnv('UPSTASH_REDIS_REST_TOKEN');

const SECRET = 'secret-at-least-32-characters-long!!';
const devEnv: Bindings &
  TelemetryEnv & { FRONTEND_URL: string; MARKETING_URL: string; FRONTEND_PREVIEW_URL: string } = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
  // The composed pipeline runs CORS first; it fail-fasts on absent web origins.
  FRONTEND_URL: requiredEnv('FRONTEND_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
};

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

// Unique per invocation so a concurrent suite never shares a window.
function octet(): string {
  return String(Math.floor(Math.random() * 255));
}
function uniqueIp(): string {
  return `10.${octet()}.${octet()}.${octet()}`;
}

const ipKeysToClean: string[] = [];
const createdUserIds: string[] = [];
const sessionKeysToClean: string[] = [];
const shareKeysToClean: string[] = [];

afterAll(async () => {
  for (const key of [...ipKeysToClean, ...sessionKeysToClean, ...shareKeysToClean]) {
    await redis.del(key);
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

const jsonHeaders = (ip: string): Record<string, string> => ({
  'cf-connecting-ip': ip,
  'content-type': 'application/json',
});

// The auth per-IP caps mount at the composition root (app.ts), not the slice
// manifest, so only a request through the real composed app proves the mounted
// path matches the route. Each request carries an empty body: the edge IP
// limiter runs ahead of the manifest's zValidator, so an admitted request
// answers a non-429 (400 invalid body), and the over-cap request answers 429.
async function assertIpCap(path: string, definition: WindowLimitDefinition): Promise<void> {
  const app = createApp();
  const ip = uniqueIp();
  ipKeysToClean.push(definition.buildKey(await hashRateLimitId(ip)));
  const headers = jsonHeaders(ip);
  const { maxAttempts } = definition.rateLimitConfig;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await app.request(path, { method: 'POST', headers, body: '{}' }, devEnv);
    expect(res.status).not.toBe(429);
  }
  const refused = await app.request(path, { method: 'POST', headers, body: '{}' }, devEnv);
  expect(refused.status).toBe(429);
}

describe('composed app: auth per-IP abuse throttles', () => {
  it('caps login start per IP (20/900)', async () => {
    await assertIpCap('/auth/login/init', loginIpRateLimit);
  });

  it('caps registration start per IP (10/3600)', async () => {
    await assertIpCap('/auth/register/init', registerIpRateLimit);
  });

  it('caps recovery reset start per IP (10/3600)', async () => {
    await assertIpCap('/auth/recovery/reset/init', recoveryResetIpRateLimit);
  });

  it('caps recovery wrapped-key retrieval per IP (10/3600)', async () => {
    await assertIpCap('/auth/recovery/get-wrapped-key', recoveryGetKeyIpRateLimit);
  });

  it('caps email-verification consume per IP (30/3600)', async () => {
    await assertIpCap('/auth/verify-email', verifyEmailIpRateLimit);
  });

  it('caps verification-email resend per IP (5/60)', async () => {
    await assertIpCap('/auth/verify-email/resend', resendVerifyIpRateLimit);
  });
});

describe('composed app: shared-message creation per-caller cap', () => {
  it('caps authenticated share creation at 20/60 by caller, then 429s', async () => {
    // A live full session: seed the user, mark the session active in Redis
    // (the composed app runs the revocation check), and seal the cookie.
    const username = `zzshare${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const bytes = new Uint8Array([3, 3, 3]);
    const [row] = await db
      .insert(users)
      .values({
        email: `${username}@auth-ratelimit.test`,
        username,
        opaqueRegistration: bytes,
        publicKey: crypto.getRandomValues(new Uint8Array(32)),
        passwordWrappedPrivateKey: bytes,
        recoveryWrappedPrivateKey: bytes,
      })
      .returning({ id: users.id });
    const userId = row?.id;
    if (userId === undefined) throw new Error('user seed failed');
    createdUserIds.push(userId);

    const sessionId = `session-${userId}`;
    const sessionKey = `sessions:user:active:${userId}:${sessionId}`;
    await redis.set(sessionKey, '1', { ex: 3600 });
    sessionKeysToClean.push(sessionKey);
    shareKeysToClean.push(shareCreateRateLimit.buildKey(userId));

    const sealed = await sealData(
      { userId, sessionId, createdAt: Date.now(), pending2FA: false, pending2FAExpiresAt: 0 },
      { password: SECRET }
    );
    const cookie = `${SESSION_COOKIE_NAME}=${sealed}`;

    const app = createApp();
    const path = `/conversations/${crypto.randomUUID()}/shares`;
    const body = JSON.stringify({
      messageId: crypto.randomUUID(),
      wrappedContentKey: toBase64(new Uint8Array([1, 2, 3])),
    });
    const { maxAttempts } = shareCreateRateLimit.rateLimitConfig;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const res = await app.request(
        path,
        {
          method: 'POST',
          headers: {
            cookie,
            'content-type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body,
        },
        devEnv
      );
      // Admitted past the limiter (the fake conversation refuses), never 429.
      expect(res.status).not.toBe(429);
    }
    const refused = await app.request(
      path,
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body,
      },
      devEnv
    );
    expect(refused.status).toBe(429);
  });
});
