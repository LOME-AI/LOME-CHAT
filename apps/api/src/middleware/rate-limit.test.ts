import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { defineRateLimitKey } from '../lib/redis/index.js';
import {
  hashRateLimitId,
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
