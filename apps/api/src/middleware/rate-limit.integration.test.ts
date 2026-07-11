import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { CHAT_STREAM_USER_RATE_LIMIT } from '../slices/chat/index.js';
import { MEDIA_RATE_LIMITS } from '../slices/media/index.js';
import { publicShareReadRateLimit } from '../slices/conversations/index.js';
import {
  hashRateLimitId,
  rateLimitByCaller,
  rateLimitByIp,
  rateLimitByUser,
} from './rate-limit.js';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Principal } from '../lib/context/index.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for rate-limit integration tests'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

// A client whose every call fails fast: nothing listens on the discard port.
const unreachableRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });

const refusalBodySchema = z.object({
  code: z.string(),
  details: z.object({ retryAfterSeconds: z.number() }),
});

const createdKeys: string[] = [];
function trackKey(key: string): string {
  createdKeys.push(key);
  return key;
}

afterAll(async () => {
  if (createdKeys.length > 0) {
    await redis.del(...createdKeys);
  }
});

function fullPrincipal(userId: string): Principal {
  return {
    kind: 'full',
    claims: {
      userId,
      sessionId: crypto.randomUUID(),
      createdAt: Date.now(),
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
  };
}

function buildApp(
  limiter: MiddlewareHandler<AppEnv>,
  options: { principal?: Principal; redisClient?: Redis } = {}
): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('redis', options.redisClient ?? redis);
      c.set('principal', options.principal ?? { kind: 'none' });
      await next();
    })
    .all('/guarded', limiter, (c) => c.json({ ok: true }));
}

function randomIp(prefix: string): string {
  const octet = (): string => String(Math.floor(Math.random() * 255));
  return `${prefix}.${octet()}.${octet()}`;
}

const LINK_HEADER = 'x-link-public-key';

interface EdgeEntryCase {
  readonly name: string;
  readonly maxAttempts: number;
  readonly windowSeconds: number;
  readonly setup: () => {
    app: Hono<AppEnv>;
    headers: Record<string, string>;
    key: () => Promise<string>;
  };
  /** Simulates window expiry for this mechanism. */
  readonly expire: (key: string) => Promise<void>;
}

async function expireWindow(key: string): Promise<void> {
  await redis.set(key, { count: 999, firstAttempt: Date.now() - 61_000 }, { ex: 60 });
}

const CASES: EdgeEntryCase[] = [
  {
    name: 'chat send per-user (CHAT_STREAM_USER_RATE_LIMIT, reservation)',
    maxAttempts: CHAT_STREAM_USER_RATE_LIMIT.rateLimitConfig.maxAttempts,
    windowSeconds: CHAT_STREAM_USER_RATE_LIMIT.rateLimitConfig.windowSeconds,
    setup: () => {
      const userId = crypto.randomUUID();
      return {
        app: buildApp(rateLimitByUser(CHAT_STREAM_USER_RATE_LIMIT), {
          principal: fullPrincipal(userId),
        }),
        headers: {},
        key: () => Promise.resolve(CHAT_STREAM_USER_RATE_LIMIT.buildKey(userId)),
      };
    },
    // A reservation counter's window IS its Redis TTL: expiry deletes the key.
    expire: async (key) => {
      await redis.del(key);
    },
  },
  {
    name: 'media download per-caller (mediaDownloadUserRateLimit, window)',
    maxAttempts: MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit.rateLimitConfig.maxAttempts,
    windowSeconds: MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit.rateLimitConfig.windowSeconds,
    setup: () => {
      const userId = crypto.randomUUID();
      return {
        app: buildApp(
          rateLimitByCaller(MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit, {
            credentialHeader: LINK_HEADER,
          }),
          { principal: fullPrincipal(userId) }
        ),
        headers: {},
        key: () => Promise.resolve(MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit.buildKey(userId)),
      };
    },
    expire: expireWindow,
  },
  {
    name: 'share presign per-IP (sharePresignIpRateLimit, window)',
    maxAttempts: MEDIA_RATE_LIMITS.sharePresignIpRateLimit.rateLimitConfig.maxAttempts,
    windowSeconds: MEDIA_RATE_LIMITS.sharePresignIpRateLimit.rateLimitConfig.windowSeconds,
    setup: () => {
      const ip = randomIp('10.0');
      return {
        app: buildApp(rateLimitByIp(MEDIA_RATE_LIMITS.sharePresignIpRateLimit)),
        headers: { 'cf-connecting-ip': ip },
        key: async () =>
          MEDIA_RATE_LIMITS.sharePresignIpRateLimit.buildKey(await hashRateLimitId(ip)),
      };
    },
    expire: expireWindow,
  },
  {
    name: 'public share read per-IP (publicShareReadRateLimit, window)',
    maxAttempts: publicShareReadRateLimit.rateLimitConfig.maxAttempts,
    windowSeconds: publicShareReadRateLimit.rateLimitConfig.windowSeconds,
    setup: () => {
      const ip = randomIp('10.1');
      return {
        app: buildApp(rateLimitByIp(publicShareReadRateLimit)),
        headers: { 'cf-connecting-ip': ip },
        key: async () => publicShareReadRateLimit.buildKey(await hashRateLimitId(ip)),
      };
    },
    expire: expireWindow,
  },
];

describe.each(CASES)('edge rate limit: $name', (entry) => {
  it('admits under the limit, refuses over it with retryAfterSeconds, admits again after expiry', async () => {
    const { app, headers, key } = entry.setup();
    trackKey(await key());

    for (let attempt = 0; attempt < entry.maxAttempts; attempt += 1) {
      const res = await app.request('/guarded', { headers });
      expect(res.status).toBe(200);
    }

    const refused = await app.request('/guarded', { headers });
    expect(refused.status).toBe(429);
    const body = refusalBodySchema.parse(await refused.json());
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.details.retryAfterSeconds).toBeLessThanOrEqual(entry.windowSeconds);

    await entry.expire(await key());
    const readmitted = await app.request('/guarded', { headers });
    expect(readmitted.status).toBe(200);
  });
});

describe('window arithmetic', () => {
  const definition = MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit;

  it('refuses with the remaining window from firstAttempt, rounded up', async () => {
    const userId = crypto.randomUUID();
    const key = trackKey(definition.buildKey(userId));
    // 30s into the 60s window, at the cap: 30s remain.
    await redis.set(
      key,
      { count: definition.rateLimitConfig.maxAttempts, firstAttempt: Date.now() - 30_000 },
      { ex: 120 }
    );
    const app = buildApp(rateLimitByCaller(definition, { credentialHeader: LINK_HEADER }), {
      principal: fullPrincipal(userId),
    });
    const res = await app.request('/guarded');
    expect(res.status).toBe(429);
    const body = refusalBodySchema.parse(await res.json());
    expect(body.details.retryAfterSeconds).toBeGreaterThanOrEqual(29);
    expect(body.details.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it('a denied attempt does not extend the window', async () => {
    const userId = crypto.randomUUID();
    const key = trackKey(definition.buildKey(userId));
    const firstAttempt = Date.now() - 30_000;
    await redis.set(
      key,
      { count: definition.rateLimitConfig.maxAttempts, firstAttempt },
      { ex: 120 }
    );
    const app = buildApp(rateLimitByCaller(definition, { credentialHeader: LINK_HEADER }), {
      principal: fullPrincipal(userId),
    });
    await app.request('/guarded');
    const stored = await redis.get<{ count: number; firstAttempt: number }>(key);
    expect(stored?.firstAttempt).toBe(firstAttempt);
    expect(stored?.count).toBe(definition.rateLimitConfig.maxAttempts);
  });
});

describe('caller keying', () => {
  const definition = MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit;

  it('keys an authenticated caller by userId', async () => {
    const userId = crypto.randomUUID();
    trackKey(definition.buildKey(userId));
    const app = buildApp(rateLimitByCaller(definition, { credentialHeader: LINK_HEADER }), {
      principal: fullPrincipal(userId),
    });
    await app.request('/guarded');
    expect(await redis.get(definition.buildKey(userId))).not.toBeNull();
  });

  it('keys a link-credential caller by the hashed credential under the link: prefix', async () => {
    const credential = crypto.randomUUID();
    const callerId = `link:${await hashRateLimitId(credential)}`;
    trackKey(definition.buildKey(callerId));
    const app = buildApp(rateLimitByCaller(definition, { credentialHeader: LINK_HEADER }));
    await app.request('/guarded', { headers: { [LINK_HEADER]: credential } });
    expect(await redis.get(definition.buildKey(callerId))).not.toBeNull();
  });

  it('keys an anonymous caller by hashed IP under the ip: prefix', async () => {
    const ip = randomIp('10.2');
    const callerId = `ip:${await hashRateLimitId(ip)}`;
    trackKey(definition.buildKey(callerId));
    const app = buildApp(rateLimitByCaller(definition, { credentialHeader: LINK_HEADER }));
    await app.request('/guarded', { headers: { 'cf-connecting-ip': ip } });
    expect(await redis.get(definition.buildKey(callerId))).not.toBeNull();
  });
});

describe('per-identifier isolation', () => {
  it('one user exhausting the chat limit does not affect another', async () => {
    const limited = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    trackKey(CHAT_STREAM_USER_RATE_LIMIT.buildKey(limited));
    trackKey(CHAT_STREAM_USER_RATE_LIMIT.buildKey(fresh));
    await redis.set(CHAT_STREAM_USER_RATE_LIMIT.buildKey(limited), 30, { ex: 60 });

    const limitedApp = buildApp(rateLimitByUser(CHAT_STREAM_USER_RATE_LIMIT), {
      principal: fullPrincipal(limited),
    });
    const freshApp = buildApp(rateLimitByUser(CHAT_STREAM_USER_RATE_LIMIT), {
      principal: fullPrincipal(fresh),
    });
    const limitedRes = await limitedApp.request('/guarded');
    const freshRes = await freshApp.request('/guarded');
    expect(limitedRes.status).toBe(429);
    expect(freshRes.status).toBe(200);
  });
});

describe('fail-closed on Redis down', () => {
  it('refuses a user-keyed request with 503 UNAVAILABLE', async () => {
    const app = buildApp(rateLimitByUser(CHAT_STREAM_USER_RATE_LIMIT), {
      principal: fullPrincipal(crypto.randomUUID()),
      redisClient: unreachableRedis,
    });
    const res = await app.request('/guarded');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });

  it('refuses an IP-keyed request with 503 UNAVAILABLE', async () => {
    const app = buildApp(rateLimitByIp(publicShareReadRateLimit), {
      redisClient: unreachableRedis,
    });
    const res = await app.request('/guarded');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });

  it('treats a user-keyed limiter on a non-full principal as a composition defect', async () => {
    const app = buildApp(rateLimitByUser(CHAT_STREAM_USER_RATE_LIMIT)).onError((_error, c) =>
      c.json({ code: 'INTERNAL' }, 500)
    );
    const res = await app.request('/guarded');
    expect(res.status).toBe(500);
  });
});
