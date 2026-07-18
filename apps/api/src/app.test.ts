import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { Redis } from '@upstash/redis';
import { ERROR_CODES } from '@hushbox/shared';
import { adminApiAliasPath, createApp, createEvictUserPort } from './app.js';
import { defineSliceManifest, routeClass } from './middleware/pipeline-manifest.js';
import { SESSION_COOKIE_NAME } from './middleware/pipeline-session.js';
import { issueSession } from './slices/identity/index.js';
import type { AppEnv } from './middleware/pipeline-manifest.js';
import type { Bindings } from './lib/context/index.js';
import type { TelemetryEnv } from './lib/telemetry/index.js';

const SECRET = 'secret-at-least-32-characters-long!!';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `app tests: missing ${name}. Run via the package test script ` +
        '(with-env loads apps/api/.dev.vars) with the local dev stack up (pnpm db:up).'
    );
  }
  return value;
}

// Real local Redis creds: the session-revocation check consults Redis for any
// request that presents a parseable cookie, so cookie-bearing tests need the
// live emulator, not placeholder values.
const devEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

async function fullSessionCookie(): Promise<string> {
  const sealed = await sealData(
    {
      userId: 'user-1',
      sessionId: 'session-1',
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

/**
 * A fixture slice exercising the manifest contract exactly as a real slice
 * would — including the deliberately inferred return type (a bare
 * `Hono<AppEnv>` annotation widens the routes to `BlankSchema`).
 */
function createFixtureManifest(deps: { greeting: string }) {
  return defineSliceManifest({
    basePath: '/fixture',
    routes: new Hono<AppEnv>()
      .get('/public', routeClass('public'), (c) => c.json({ greeting: deps.greeting }))
      .get('/session', routeClass('session'), (c) => c.json({ ok: true }))
      .get('/dev', routeClass('dev-only'), (c) => c.json({ route: 'dev' }))
      .get('/defect', routeClass('public'), () => {
        throw new Error('secret defect detail');
      })
      .get('/unmarked', (c) => c.json({ leaked: true })),
  });
}

describe('createApp', () => {
  it('serves the public health route at the root path', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const res = await createApp().request('/health', {}, devEnv);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', timestamp: '2026-01-01T00:00:00.000Z' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves the public health route end-to-end in production mode', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const productionEnv: Bindings = { ...devEnv, NODE_ENV: 'production' };
      const res = await createApp().request('/health', {}, productionEnv);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', timestamp: '2026-01-01T00:00:00.000Z' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 404 for an unknown path', async () => {
    const res = await createApp().request('/no-such-route', {}, devEnv);
    expect(res.status).toBe(404);
  });

  it('answers an unknown path with the uniform {code} body', async () => {
    const res = await createApp().request('/no-such-route', {}, devEnv);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('serializes the not-found body as exactly {"code":...} (no details key, no message)', async () => {
    const res = await createApp().request('/no-such-route', {}, devEnv);
    expect(await res.text()).toBe('{"code":"NOT_FOUND"}');
  });

  it('fails fast with a 500 when a required binding is missing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const incomplete = { ...devEnv };
      delete incomplete.DATABASE_URL;
      const res = await createApp().request('/health', {}, incomplete);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ code: ERROR_CODES.INTERNAL });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('createApp: defect handling', () => {
  function appWithDefectRoute(): ReturnType<typeof createApp> {
    const manifest = createFixtureManifest({ greeting: 'unused' });
    const app = createApp();
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  it('answers a thrown defect with the uniform {code: INTERNAL} body', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await appWithDefectRoute().request('/fixture/defect', {}, devEnv);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ code: ERROR_CODES.INTERNAL });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('never echoes the thrown message in the defect response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await appWithDefectRoute().request('/fixture/defect', {}, devEnv);
      expect(await res.text()).not.toContain('secret defect detail');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('serializes the defect body as exactly {"code":...} (no details key, no message)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await appWithDefectRoute().request('/fixture/defect', {}, devEnv);
      expect(await res.text()).toBe('{"code":"INTERNAL"}');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('captures the defect through telemetry without the thrown message on stderr', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await appWithDefectRoute().request('/fixture/defect', {}, devEnv);
      const lines = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('"errorCode":"INTERNAL"'))).toBe(true);
      expect(lines.every((line) => !line.includes('secret defect detail'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('createApp: slice manifest contract', () => {
  function appWithFixture(): ReturnType<typeof createApp> {
    const manifest = createFixtureManifest({ greeting: 'hello from fixture' });
    const app = createApp();
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  it('mounts a fixture slice at its real path with its declared classes honored', async () => {
    const res = await appWithFixture().request('/fixture/public', {}, devEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ greeting: 'hello from fixture' });
  });

  it('applies the pipeline to fixture session routes (401 anonymous)', async () => {
    const res = await appWithFixture().request('/fixture/session', {}, devEnv);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('serves fixture session routes to a live full session', async () => {
    const redis = new Redis({
      url: devEnv.UPSTASH_REDIS_REST_URL ?? '',
      token: devEnv.UPSTASH_REDIS_REST_TOKEN ?? '',
    });
    const response = new Response();
    const userId = crypto.randomUUID();
    const issued = await issueSession({
      request: new Request('http://localhost/'),
      response,
      redis,
      secret: SECRET,
      isProduction: false,
      userId,
      kind: 'full',
      now: Date.now(),
    });
    if (issued.isErr()) throw new Error('session issue failed');
    const app = appWithFixture();
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const res = await app.request('/fixture/session', { headers: { cookie } }, devEnv);
    // Real logout through the mounted identity slice cleans the session up
    // (before the assertion, so a failing expectation cannot leak the key).
    const bye = await app.request('/auth/logout', { method: 'POST', headers: { cookie } }, devEnv);
    expect(bye.status).toBe(200);
    expect(res.status).toBe(200);
  });

  it('logs out with 200 even when the realtime binding is absent (best-effort eviction degrades)', async () => {
    // devEnv carries no CONVERSATION_ROOM binding. Logout must ALWAYS succeed
    // so a user can always terminate a session: the security-critical
    // revocation (sessionActive delete + passwordChangedAt watermark) runs
    // synchronously; only the best-effort push-eviction is skipped — it must
    // not 500 the route (ARCHITECTURE §15).
    const redis = new Redis({
      url: devEnv.UPSTASH_REDIS_REST_URL ?? '',
      token: devEnv.UPSTASH_REDIS_REST_TOKEN ?? '',
    });
    const response = new Response();
    const userId = crypto.randomUUID();
    const issued = await issueSession({
      request: new Request('http://localhost/'),
      response,
      redis,
      secret: SECRET,
      isProduction: false,
      userId,
      kind: 'full',
      now: Date.now(),
    });
    if (issued.isErr()) throw new Error('session issue failed');
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const bye = await createApp().request(
      '/auth/logout',
      { method: 'POST', headers: { cookie } },
      devEnv
    );
    expect(bye.status).toBe(200);
  });

  it('refuses a full-session cookie whose session is not active in Redis (revocation enforced)', async () => {
    const res = await appWithFixture().request(
      '/fixture/session',
      { headers: { cookie: await fullSessionCookie() } },
      devEnv
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('makes a production-hidden dev-only route indistinguishable from an unknown path', async () => {
    const productionEnv: Bindings = { ...devEnv, NODE_ENV: 'production' };
    const app = appWithFixture();
    const hidden = await app.request('/fixture/dev', {}, productionEnv);
    const unmatched = await app.request('/no-such-route', {}, productionEnv);
    expect(hidden.status).toBe(404);
    expect(unmatched.status).toBe(404);
    expect(await hidden.json()).toEqual(await unmatched.json());
  });

  it('default-denies an undeclared fixture route', async () => {
    const res = await appWithFixture().request('/fixture/unmarked', {}, devEnv);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });
});

describe('createEvictUserPort', () => {
  function fakeRoomNamespace(): unknown {
    return {
      idFromName: (name: string) => name,
      get: () => ({ fetch: () => Promise.resolve(Response.json({ closed: 1 })) }),
    };
  }

  it('fans eviction over the user active-room set when the realtime binding is present', async () => {
    const smembersKeys: string[] = [];
    const redis = {
      smembers: (key: string) => {
        smembersKeys.push(key);
        return Promise.resolve(['conv-a', 'conv-b']);
      },
    } as unknown as Redis;
    const env = { ...devEnv, CONVERSATION_ROOM: fakeRoomNamespace() } as unknown as Bindings;

    const port = createEvictUserPort(redis, env);
    await expect(port.evictUser('user-1')).resolves.toBeUndefined();
    expect(smembersKeys).toHaveLength(1);
  });

  it('degrades to a no-op when the realtime binding is absent', async () => {
    const redis = { smembers: () => Promise.resolve([]) } as unknown as Redis;
    const port = createEvictUserPort(redis, { ...devEnv } as Bindings);
    await expect(port.evictUser('user-1')).resolves.toBeUndefined();
  });
});

describe('adminApiAliasPath', () => {
  it('strips the /api prefix off /api/admin/ requests', () => {
    expect(adminApiAliasPath(new Request('https://admin.example/api/admin/users/overview'))).toBe(
      '/admin/users/overview'
    );
  });

  it('leaves non-/api/admin paths unchanged', () => {
    expect(adminApiAliasPath(new Request('https://example/health'))).toBe('/health');
    expect(adminApiAliasPath(new Request('https://example/api/models'))).toBe('/api/models');
  });
});
