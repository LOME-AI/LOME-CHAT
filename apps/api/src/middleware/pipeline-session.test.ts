import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { ERROR_CODES } from '@hushbox/shared';
import { errAsync, okAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import { pipelineEnv } from './pipeline-env.js';
import { pipelineBindings } from './pipeline-bindings.js';
import { pipelineSession, SESSION_COOKIE_NAME } from './pipeline-session.js';
import { isPipelineHandler } from './pipeline-markers.js';
import type { AppEnv, Bindings, Principal, SessionRevocationCheck } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return await res.json();
}

const SECRET = 'secret-at-least-32-characters-long!!';

const env: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

function createProbeApp(): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', pipelineEnv())
    .use('*', pipelineBindings())
    .use('*', pipelineSession())
    .get('/probe', (c) => c.json(c.get('principal')))
    .onError((err, c) => c.json({ message: err.message }, 500));
}

async function sealedCookie(data: Record<string, unknown>): Promise<string> {
  const sealed = await sealData(data, { password: SECRET });
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

function sessionData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: 'user-1',
    sessionId: 'session-1',
    createdAt: Date.now() - 1000,
    pending2FA: false,
    pending2FAExpiresAt: 0,
    ...overrides,
  };
}

async function probePrincipal(cookie?: string): Promise<Principal> {
  const init = cookie === undefined ? {} : { headers: { cookie } };
  const res = await createProbeApp().request('/probe', init, env);
  expect(res.status).toBe(200);
  return jsonBody<Principal>(res);
}

describe('pipelineSession', () => {
  it('derives a none principal without a session cookie', async () => {
    expect(await probePrincipal()).toEqual({ kind: 'none' });
  });

  it('derives a full principal from a valid session cookie', async () => {
    const principal = await probePrincipal(await sealedCookie(sessionData()));
    expect(principal.kind).toBe('full');
    if (principal.kind === 'full') {
      expect(principal.claims.userId).toBe('user-1');
    }
  });

  it('derives a pending-2fa principal from an unexpired mid-2FA session', async () => {
    const cookie = await sealedCookie(
      sessionData({ pending2FA: true, pending2FAExpiresAt: Date.now() + 60_000 })
    );
    const principal = await probePrincipal(cookie);
    expect(principal.kind).toBe('pending-2fa');
  });

  it('derives a none principal from an expired mid-2FA session', async () => {
    const cookie = await sealedCookie(
      sessionData({ pending2FA: true, pending2FAExpiresAt: Date.now() - 60_000 })
    );
    expect(await probePrincipal(cookie)).toEqual({ kind: 'none' });
  });

  it('derives a billing-only principal from a billing-restricted session', async () => {
    const cookie = await sealedCookie(sessionData({ billingOnly: true }));
    const principal = await probePrincipal(cookie);
    expect(principal.kind).toBe('billing-only');
  });

  it('derives a none principal from an unreadable cookie', async () => {
    expect(await probePrincipal(`${SESSION_COOKIE_NAME}=garbage`)).toEqual({ kind: 'none' });
  });

  it('fails fast when applied without the bindings stage (pipeline order violated)', async () => {
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineSession())
      .get('/probe', (c) => c.json(c.get('principal')))
      .onError((err, c) => c.json({ message: err.message }, 500));
    const res = await app.request('/probe', {}, env);
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/pipeline order/);
  });

  it('is marked as a pipeline handler', () => {
    expect(isPipelineHandler(pipelineSession())).toBe(true);
  });
});

describe('pipelineSession revocation seam', () => {
  function createRevocationApp(revocation: SessionRevocationCheck): Hono<AppEnv> {
    return new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .use('*', pipelineSession({ revocation }))
      .get('/probe', (c) => c.json(c.get('principal')));
  }

  it('degrades a revoked session to a none principal', async () => {
    const app = createRevocationApp(() => okAsync('revoked'));
    const res = await app.request(
      '/probe',
      { headers: { cookie: await sealedCookie(sessionData()) } },
      env
    );
    expect(res.status).toBe(200);
    expect(await jsonBody<Principal>(res)).toEqual({ kind: 'none' });
  });

  it('keeps an active session as a full principal', async () => {
    const app = createRevocationApp(() => okAsync('active'));
    const res = await app.request(
      '/probe',
      { headers: { cookie: await sealedCookie(sessionData()) } },
      env
    );
    const principal = await jsonBody<Principal>(res);
    expect(principal.kind).toBe('full');
  });

  it('fails closed with 503 when the liveness check cannot be answered', async () => {
    const app = createRevocationApp(() => errAsync(unavailableError('redis get failed')));
    const res = await app.request(
      '/probe',
      { headers: { cookie: await sealedCookie(sessionData()) } },
      env
    );
    expect(res.status).toBe(503);
    expect(await jsonBody(res)).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });

  it('passes the parsed claims to the revocation check', async () => {
    const revocation = vi.fn<SessionRevocationCheck>(() => okAsync('active'));
    const app = createRevocationApp(revocation);
    await app.request('/probe', { headers: { cookie: await sealedCookie(sessionData()) } }, env);
    expect(revocation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'user-1', sessionId: 'session-1' })
    );
  });

  it('never invokes the check for a request without parseable claims', async () => {
    const revocation = vi.fn<SessionRevocationCheck>(() => okAsync('active'));
    const app = createRevocationApp(revocation);
    const res = await app.request('/probe', {}, env);
    expect(res.status).toBe(200);
    expect(await jsonBody<Principal>(res)).toEqual({ kind: 'none' });
    expect(revocation).not.toHaveBeenCalled();
  });
});
