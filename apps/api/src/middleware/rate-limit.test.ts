import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { defineRateLimitKey } from '../lib/redis/index.js';
import {
  hashRateLimitId,
  rateLimitByAdminActor,
  rateLimitByCaller,
  rateLimitByIp,
  rateLimitByUser,
  resolveClientIp,
} from './rate-limit.js';
import type { Redis } from '@upstash/redis';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Principal } from '../lib/context/index.js';

function headersOf(record: Record<string, string>): (name: string) => string | undefined {
  const lowered = new Map(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string): string | undefined => lowered.get(name.toLowerCase());
}

describe('resolveClientIp', () => {
  it('ignores an empty cf-connecting-ip and falls through to x-forwarded-for', () => {
    const ip = resolveClientIp(headersOf({ 'cf-connecting-ip': '', 'x-forwarded-for': '2.2.2.2' }));
    expect(ip).toBe('2.2.2.2');
  });

  it("ignores an empty x-real-ip and answers 'unknown'", () => {
    expect(resolveClientIp(headersOf({ 'x-real-ip': '' }))).toBe('unknown');
  });

  it('prefers cf-connecting-ip over every other header', () => {
    const ip = resolveClientIp(
      headersOf({
        'cf-connecting-ip': '1.1.1.1',
        'x-forwarded-for': '2.2.2.2, 3.3.3.3',
        'x-real-ip': '4.4.4.4',
      })
    );
    expect(ip).toBe('1.1.1.1');
  });

  it('takes the FIRST x-forwarded-for hop when cf-connecting-ip is absent', () => {
    const ip = resolveClientIp(
      headersOf({ 'x-forwarded-for': ' 2.2.2.2 , 3.3.3.3', 'x-real-ip': '4.4.4.4' })
    );
    expect(ip).toBe('2.2.2.2');
  });

  it('falls back to x-real-ip', () => {
    expect(resolveClientIp(headersOf({ 'x-real-ip': '4.4.4.4' }))).toBe('4.4.4.4');
  });

  it("answers 'unknown' when no IP header is present", () => {
    expect(resolveClientIp(headersOf({}))).toBe('unknown');
  });

  it("treats an empty x-forwarded-for as absent and answers 'unknown'", () => {
    expect(resolveClientIp(headersOf({ 'x-forwarded-for': ' ' }))).toBe('unknown');
  });
});

const counterDefinition = defineRateLimitKey({
  schema: z.coerce.number(),
  ttlSeconds: 60,
  buildKey: (id: string) => `test:edge:counter:${id}`,
  rateLimitConfig: { maxAttempts: 2, windowSeconds: 60 },
});

const windowDefinition = defineRateLimitKey({
  schema: z.object({ count: z.number(), firstAttempt: z.number() }),
  ttlSeconds: 60,
  buildKey: (id: string) => `test:edge:window:${id}`,
  rateLimitConfig: { maxAttempts: 2, windowSeconds: 60 },
});

function fullPrincipal(userId: string): Principal {
  return {
    kind: 'full',
    claims: {
      userId,
      sessionId: 'session',
      createdAt: 0,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
  };
}

function buildApp(limiter: MiddlewareHandler<AppEnv>, redis: Redis): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('redis', redis);
      c.set('principal', fullPrincipal('user-1'));
      await next();
    })
    .all('/guarded', limiter, (c) => c.json({ ok: true }));
}

describe('reservation failure surfaces (stubbed Redis)', () => {
  it('answers the full window when the over-limit counter carries no expiry', async () => {
    const redis = {
      incr: () => Promise.resolve(3),
      expire: () => Promise.resolve(1),
      ttl: () => Promise.resolve(-1),
    } as unknown as Redis;
    const res = await buildApp(rateLimitByUser(counterDefinition), redis).request('/guarded');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 60 },
    });
  });

  it('fails closed (503) when the TTL read fails after an over-limit increment', async () => {
    const redis = {
      incr: () => Promise.resolve(3),
      expire: () => Promise.resolve(1),
      ttl: () => Promise.reject(new Error('down')),
    } as unknown as Redis;
    const res = await buildApp(rateLimitByUser(counterDefinition), redis).request('/guarded');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});

describe('window failure surfaces (stubbed Redis)', () => {
  it('fails closed (503) when opening a fresh window cannot be persisted', async () => {
    const redis = {
      get: () => Promise.resolve(null),
      set: () => Promise.reject(new Error('down')),
    } as unknown as Redis;
    const res = await buildApp(rateLimitByIp(windowDefinition), redis).request('/guarded');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });

  it('fails closed (503) when advancing an open window cannot be persisted', async () => {
    const redis = {
      get: () => Promise.resolve({ count: 1, firstAttempt: Date.now() }),
      set: () => Promise.reject(new Error('down')),
    } as unknown as Redis;
    const res = await buildApp(
      rateLimitByCaller(windowDefinition, { credentialHeader: 'x-cred' }),
      redis
    ).request('/guarded');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});

describe('rateLimitByAdminActor', () => {
  const adminActor: Principal = {
    kind: 'admin-actor',
    email: 'founder@hushbox.ai',
    audience: 'aud',
  };

  function adminApp(redis: Redis, principal: Principal = adminActor): Hono<AppEnv> {
    return new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('redis', redis);
        c.set('principal', principal);
        await next();
      })
      .all('/guarded', rateLimitByAdminActor(windowDefinition), (c) => c.json({ ok: true }));
  }

  /** Map-backed window store: real consumeWindow semantics without Redis. */
  function windowRedis(store: Map<string, unknown>): Redis {
    return {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve('OK');
      },
    } as unknown as Redis;
  }

  it('admits under the window and refuses over it with the standard error shape', async () => {
    const store = new Map<string, unknown>();
    const app = adminApp(windowRedis(store));

    const first = await app.request('/guarded');
    const second = await app.request('/guarded');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const third = await app.request('/guarded');
    expect(third.status).toBe(429);
    const body = z
      .object({ code: z.string(), details: z.object({ retryAfterSeconds: z.number() }) })
      .parse(await third.json());
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keys the window by the hashed actor email — the raw email never enters Redis', async () => {
    const store = new Map<string, unknown>();
    await adminApp(windowRedis(store)).request('/guarded');

    const keys = [...store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(await hashRateLimitId('founder@hushbox.ai'));
    expect(keys[0]).not.toContain('founder@hushbox.ai');
  });

  it('treats a non-admin principal reaching it as a composition defect', async () => {
    const store = new Map<string, unknown>();
    const res = await adminApp(windowRedis(store), fullPrincipal('user-1')).request('/guarded');
    // Hono surfaces the thrown defect as a 500 — the authorizer must refuse
    // first on admin-classed routes; this middleware never masks that.
    expect(res.status).toBe(500);
  });
});

describe('hashRateLimitId', () => {
  it('produces the SHA-256 hex of the identifier (never a raw IP in a key)', async () => {
    // sha256('1.1.1.1') — fixed vector so a digest change cannot slip by.
    expect(await hashRateLimitId('1.1.1.1')).toBe(
      'f1412386aa8db2579aff2636cb9511cacc5fd9880ecab60c048508fbe26ee4d9'
    );
  });

  it('is deterministic', async () => {
    expect(await hashRateLimitId('abc')).toBe(await hashRateLimitId('abc'));
  });
});
