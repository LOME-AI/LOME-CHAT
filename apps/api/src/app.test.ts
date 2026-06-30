import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { ERROR_CODES } from '@hushbox/shared';
import { createApp } from './app.js';
import { defineSliceManifest, routeClass } from './middleware/pipeline-manifest.js';
import { SESSION_COOKIE_NAME } from './middleware/pipeline-session.js';
import type { AppEnv } from './middleware/pipeline-manifest.js';
import type { Bindings } from './lib/context/index.js';
import type { TelemetryEnv } from './lib/telemetry/index.js';

const SECRET = 'secret-at-least-32-characters-long!!';

const devEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
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

/** A fixture slice exercising the manifest contract exactly as a real slice would. */
function createFixtureManifest(deps: {
  greeting: string;
}): ReturnType<typeof defineSliceManifest<'/fixture', Hono<AppEnv>>> {
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
    const res = await createApp().request('/health', {}, devEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('serves the public health route end-to-end in production mode', async () => {
    const productionEnv: Bindings = { ...devEnv, NODE_ENV: 'production' };
    const res = await createApp().request('/health', {}, productionEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
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

  it('serves fixture session routes to a full session', async () => {
    const res = await appWithFixture().request(
      '/fixture/session',
      { headers: { cookie: await fullSessionCookie() } },
      devEnv
    );
    expect(res.status).toBe(200);
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
