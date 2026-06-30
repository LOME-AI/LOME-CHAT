import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { ERROR_CODES } from '@hushbox/shared';
import { okAsync } from '../lib/result/index.js';
import { SESSION_COOKIE_NAME } from '../lib/context/index.js';
import { applyPipeline } from './pipeline.js';
import { routeClass } from './pipeline-markers.js';
import { idempotencyExempt } from '../lib/idempotency/index.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

const env: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
};

describe('applyPipeline', () => {
  it('returns the same app instance for further chaining', () => {
    const app = new Hono<AppEnv>();
    expect(applyPipeline(app)).toBe(app);
  });

  it('wires the five stages in working order (declared public route responds)', async () => {
    const app = applyPipeline(new Hono<AppEnv>()).get('/public', routeClass('public'), (c) =>
      c.json({ ok: true })
    );
    const res = await app.request('/public', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('default-denies an undeclared route through the composed chain', async () => {
    const app = applyPipeline(new Hono<AppEnv>()).get('/unmarked', (c) => c.json({ ok: true }));
    const res = await app.request('/unmarked', {}, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('enforces authentication on session routes through the composed chain', async () => {
    const app = applyPipeline(new Hono<AppEnv>()).get('/me', routeClass('session'), (c) =>
      c.json({ ok: true })
    );
    const res = await app.request('/me', {}, env);
    expect(res.status).toBe(401);
  });

  it('authorizes before the idempotency-key check (anonymous keyless POST gets 401, never 400)', async () => {
    const app = applyPipeline(new Hono<AppEnv>()).post('/mutate', routeClass('session'), (c) =>
      c.json({ ok: true })
    );
    const res = await app.request('/mutate', { method: 'POST' }, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('rejects a non-exempt mutating route without an Idempotency-Key through the composed chain', async () => {
    const app = applyPipeline(new Hono<AppEnv>()).post('/mutate', routeClass('public'), (c) =>
      c.json({ ok: true })
    );
    const res = await app.request('/mutate', { method: 'POST' }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('passes an exempted mutating route without an Idempotency-Key through the composed chain', async () => {
    const app = applyPipeline(new Hono<AppEnv>()).post(
      '/exempted',
      routeClass('public'),
      idempotencyExempt('naturally-idempotent'),
      (c) => c.json({ ok: true })
    );
    const res = await app.request('/exempted', { method: 'POST' }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('falls through to 404 for an unmatched path through the composed chain', async () => {
    const app = applyPipeline(new Hono<AppEnv>());
    const res = await app.request('/no-such-route', {}, env);
    expect(res.status).toBe(404);
  });

  it('threads the injected revocation check into the session stage (revoked cookie gets 401)', async () => {
    const app = applyPipeline(new Hono<AppEnv>(), {
      session: { revocation: () => okAsync('revoked') },
    }).get('/me', routeClass('session'), (c) => c.json({ ok: true }));
    const sealed = await sealData(
      {
        userId: 'user-1',
        sessionId: 'session-1',
        createdAt: Date.now() - 1000,
        pending2FA: false,
        pending2FAExpiresAt: 0,
      },
      { password: env.IRON_SESSION_SECRET ?? '' }
    );
    const res = await app.request(
      '/me',
      { headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}` } },
      env
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('passes a GET route without an Idempotency-Key through the composed chain', async () => {
    const app = applyPipeline(new Hono<AppEnv>()).get('/read', routeClass('public'), (c) =>
      c.json({ ok: true })
    );
    const res = await app.request('/read', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
