import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { updatesRoute } from './updates.js';
import { setVersionOverride, clearVersionOverride } from '../lib/version-override.js';
import type { AppEnv } from '../types.js';

async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function createTestApp(options?: {
  appVersion?: string;
  r2Object?: { body: ReadableStream; size: number } | null;
}): Hono<AppEnv> {
  const appVersion = options?.appVersion ?? '1.0.0';
  const r2Object = options?.r2Object === undefined ? null : options.r2Object;

  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = {
      APP_VERSION: appVersion,
      APP_BUILDS: {
        get: vi.fn().mockResolvedValue(r2Object),
        put: vi.fn().mockResolvedValue(null),
      },
    } as unknown as AppEnv['Bindings'];
    await next();
  });

  app.route('/updates', updatesRoute);
  return app;
}

describe('GET /updates/current', () => {
  it('returns the current version from APP_VERSION', async () => {
    const app = createTestApp({ appVersion: 'abc123' });

    const res = await app.request('/updates/current');

    expect(res.status).toBe(200);
    const data = await jsonBody<{ version: string }>(res);
    expect(data.version).toBe('abc123');
  });

  afterEach(() => {
    clearVersionOverride();
  });

  it('returns version override when set', async () => {
    setVersionOverride('ota-v2');
    const app = createTestApp({ appVersion: 'dev-local' });

    const res = await app.request('/updates/current');

    expect(res.status).toBe(200);
    const data = await jsonBody<{ version: string }>(res);
    expect(data.version).toBe('ota-v2');
  });

  it('returns version for dev-local', async () => {
    const app = createTestApp({ appVersion: 'dev-local' });

    const res = await app.request('/updates/current');

    expect(res.status).toBe(200);
    const data = await jsonBody<{ version: string }>(res);
    expect(data.version).toBe('dev-local');
  });
});

describe('GET /updates/download/:platform/:version', () => {
  function createZipStream(): { body: ReadableStream; size: number } {
    const zipContent = new TextEncoder().encode('fake-zip-content');
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(zipContent);
          controller.close();
        },
      }),
      size: zipContent.length,
    };
  }

  it('returns 200 with zip for ios platform', async () => {
    const r2Object = createZipStream();
    const app = createTestApp({ r2Object });

    const res = await app.request('/updates/download/ios/1.0.0');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(r2Object.size);
  });

  it('returns 200 with zip for android platform', async () => {
    const r2Object = createZipStream();
    const app = createTestApp({ r2Object });

    const res = await app.request('/updates/download/android/1.0.0');

    expect(res.status).toBe(200);
  });

  it('returns 200 with zip for android-direct platform', async () => {
    const r2Object = createZipStream();
    const app = createTestApp({ r2Object });

    const res = await app.request('/updates/download/android-direct/1.0.0');

    expect(res.status).toBe(200);
  });

  it('uses platform-prefixed R2 key', async () => {
    const mockGet = vi.fn().mockResolvedValue(createZipStream());
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.env = {
        APP_VERSION: '1.0.0',
        APP_BUILDS: { get: mockGet, put: vi.fn() },
      } as unknown as AppEnv['Bindings'];
      await next();
    });
    app.route('/updates', updatesRoute);

    await app.request('/updates/download/ios/1.0.0');

    expect(mockGet).toHaveBeenCalledWith('builds/ios/1.0.0.zip');
  });

  it('returns 400 for web platform', async () => {
    const app = createTestApp({ r2Object: createZipStream() });

    const res = await app.request('/updates/download/web/1.0.0');

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid platform', async () => {
    const app = createTestApp({ r2Object: createZipStream() });

    const res = await app.request('/updates/download/invalid/1.0.0');

    expect(res.status).toBe(400);
  });

  it('returns 404 when version not found in R2', async () => {
    const app = createTestApp({ r2Object: null });

    const res = await app.request('/updates/download/ios/nonexistent');

    expect(res.status).toBe(404);
    const data = await jsonBody<{ code: string }>(res);
    expect(data.code).toBe('BUILD_NOT_FOUND');
  });

  it('returns 404 when APP_BUILDS binding is not configured', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.env = { APP_VERSION: '1.0.0' } as unknown as AppEnv['Bindings'];
      await next();
    });
    app.route('/updates', updatesRoute);

    const res = await app.request('/updates/download/ios/1.0.0');

    expect(res.status).toBe(404);
  });

  it('returns correct cache headers', async () => {
    const app = createTestApp({ r2Object: createZipStream() });

    const res = await app.request('/updates/download/android/1.0.0');

    expect(res.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
    expect(res.headers.get('content-type')).toBe('application/zip');
  });
});
