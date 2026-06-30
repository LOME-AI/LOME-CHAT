import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  errorResponseSchema,
  friendlyErrorMessage,
} from '@hushbox/shared';
import { pipelineEnv } from './pipeline-env.js';
import { pipelineBindings } from './pipeline-bindings.js';
import { pipelineSession, SESSION_COOKIE_NAME } from './pipeline-session.js';
import { pipelineAuthorize } from './pipeline-authorize.js';
import { routeClass, isPipelineHandler } from './pipeline-markers.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return await res.json();
}

const SECRET = 'secret-at-least-32-characters-long!!';

const devEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const productionEnv: Bindings & TelemetryEnv = { ...devEnv, NODE_ENV: 'production' };

async function cookieFor(overrides: Record<string, unknown> = {}): Promise<string> {
  const sealed = await sealData(
    {
      userId: 'user-1',
      sessionId: 'session-1',
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
      ...overrides,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

interface ProbeState {
  unmarkedHandlerRan: boolean;
}

function createTestApp(state: ProbeState): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', pipelineEnv())
    .use('*', pipelineBindings())
    .use('*', pipelineSession())
    .use('*', pipelineAuthorize())
    .get('/public', routeClass('public'), (c) => c.json({ route: 'public' }))
    .get('/session', routeClass('session'), (c) => c.json({ route: 'session' }))
    .get('/2fa/verify', routeClass('pending-2fa'), (c) => c.json({ route: '2fa' }))
    .get('/billing', routeClass('billing-token'), (c) => c.json({ route: 'billing' }))
    .get('/dev', routeClass('dev-only'), (c) => c.json({ route: 'dev' }))
    .get('/unmarked', (c) => {
      state.unmarkedHandlerRan = true;
      return c.json({ route: 'unmarked' });
    })
    .get('/conflict', routeClass('public'), routeClass('session'), (c) =>
      c.json({ route: 'conflict' })
    )
    .onError((err, c) => c.json({ message: err.message }, 500));
}

function probe(
  path: string,
  options: { cookie?: string; env?: Bindings } = {}
): { app: Hono<AppEnv>; state: ProbeState; res: Response | Promise<Response> } {
  const state: ProbeState = { unmarkedHandlerRan: false };
  const app = createTestApp(state);
  const init = options.cookie === undefined ? {} : { headers: { cookie: options.cookie } };
  return { app, state, res: app.request(path, init, options.env ?? devEnv) };
}

describe('pipelineAuthorize: default-deny', () => {
  it('denies a route with no declared class', async () => {
    const res = await probe('/unmarked').res;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('serializes a denial as exactly {"code":...} (no details key, no message)', async () => {
    const res = await probe('/unmarked').res;
    expect(await res.text()).toBe('{"code":"FORBIDDEN"}');
  });

  it('never runs the handler of an undeclared route', async () => {
    const { state, res } = probe('/unmarked');
    await res;
    expect(state.unmarkedHandlerRan).toBe(false);
  });

  it('denies an undeclared route even with a full session', async () => {
    const res = await probe('/unmarked', { cookie: await cookieFor() }).res;
    expect(res.status).toBe(403);
  });

  it('throws a defect on conflicting class declarations', async () => {
    const res = await probe('/conflict').res;
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/conflicting route classes/);
  });

  it('falls through to 404 when no route matches at all', async () => {
    const res = await probe('/no-such-route').res;
    expect(res.status).toBe(404);
  });
});

describe('pipelineAuthorize: public routes', () => {
  it('serves anonymous requests', async () => {
    const res = await probe('/public').res;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ route: 'public' });
  });
});

describe('pipelineAuthorize: session routes', () => {
  it('serves a full session', async () => {
    const res = await probe('/session', { cookie: await cookieFor() }).res;
    expect(res.status).toBe(200);
  });

  it('answers 401 unauthorized without a session', async () => {
    const res = await probe('/session').res;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('answers 403 forbidden for a pending-2FA session', async () => {
    const cookie = await cookieFor({ pending2FA: true, pending2FAExpiresAt: Date.now() + 60_000 });
    const res = await probe('/session', { cookie }).res;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('answers 403 forbidden for a billing-only session', async () => {
    const res = await probe('/session', { cookie: await cookieFor({ billingOnly: true }) }).res;
    expect(res.status).toBe(403);
  });
});

describe('pipelineAuthorize: pending-2fa routes', () => {
  it('serves a pending-2FA session', async () => {
    const cookie = await cookieFor({ pending2FA: true, pending2FAExpiresAt: Date.now() + 60_000 });
    const res = await probe('/2fa/verify', { cookie }).res;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ route: '2fa' });
  });

  it('serves anonymous requests (login entry points)', async () => {
    const res = await probe('/2fa/verify').res;
    expect(res.status).toBe(200);
  });
});

describe('pipelineAuthorize: billing-token routes', () => {
  it('serves a billing-only session', async () => {
    const res = await probe('/billing', { cookie: await cookieFor({ billingOnly: true }) }).res;
    expect(res.status).toBe(200);
  });

  it('answers 403 forbidden for a pending-2FA session', async () => {
    const cookie = await cookieFor({ pending2FA: true, pending2FAExpiresAt: Date.now() + 60_000 });
    const res = await probe('/billing', { cookie }).res;
    expect(res.status).toBe(403);
  });
});

describe('pipelineAuthorize: dev-only routes', () => {
  it('serves requests outside production', async () => {
    const res = await probe('/dev').res;
    expect(res.status).toBe(200);
  });

  it('answers 404 in production even with a full session', async () => {
    const res = await probe('/dev', { cookie: await cookieFor(), env: productionEnv }).res;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});

describe('pipelineAuthorize: wire contract', () => {
  it('emits a denial body that parses against the shared error-response schema', async () => {
    const res = await probe('/session').res;
    const body = errorResponseSchema.parse(await res.json());
    expect(body.code).toBe(ERROR_CODES.UNAUTHORIZED);
  });

  it('emits a denial code that maps to its specific user-facing copy', async () => {
    const res = await probe('/session').res;
    const { code } = await jsonBody<{ code: string }>(res);
    expect(friendlyErrorMessage(code)).toBe(ERROR_MESSAGES.UNAUTHORIZED);
  });
});

describe('pipelineAuthorize: subtree class declarations', () => {
  it('enforces a class declared via a wildcard use() on the subtree', async () => {
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .use('*', pipelineSession())
      .use('*', pipelineAuthorize())
      .use('/admin/*', routeClass('session'))
      .get('/admin/panel', (c) => c.json({ route: 'panel' }));
    const denied = await app.request('/admin/panel', {}, devEnv);
    expect(denied.status).toBe(401);
    const allowed = await app.request(
      '/admin/panel',
      { headers: { cookie: await cookieFor() } },
      devEnv
    );
    expect(allowed.status).toBe(200);
  });
});

describe('pipelineAuthorize: pipeline order', () => {
  it('fails fast when applied without the session stage', async () => {
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .use('*', pipelineAuthorize())
      .get('/public', routeClass('public'), (c) => c.json({ route: 'public' }))
      .onError((err, c) => c.json({ message: err.message }, 500));
    const res = await app.request('/public', {}, devEnv);
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/pipeline order/);
  });

  it('is marked as a pipeline handler', () => {
    expect(isPipelineHandler(pipelineAuthorize())).toBe(true);
  });
});
