import { describe, it, expect, afterEach } from 'vitest';
import { Hono } from 'hono';
import { versionCheck } from './version-check.js';
import { platformMiddleware } from './platform.js';
import { setVersionOverride, clearVersionOverride } from '../lib/version-override.js';
import type { Platform } from '@hushbox/shared';

async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface VersionCheckEnv {
  Bindings: { APP_VERSION: string };
  Variables: { platform: Platform };
}

function createApp(appVersion: string): Hono<VersionCheckEnv> {
  const app = new Hono<VersionCheckEnv>();
  app.use('*', async (c, next) => {
    c.env = { ...c.env, APP_VERSION: appVersion } as VersionCheckEnv['Bindings'];
    return next();
  });
  app.use('*', platformMiddleware());
  app.use('*', versionCheck());
  app.get('/api/test', (c) => c.json({ ok: true }));
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/webhooks/payment', (c) => c.json({ ok: true }));
  app.post('/api/auth/token-login', (c) => c.json({ ok: true }));
  app.get('/api/updates/current', (c) => c.json({ ok: true }));
  return app;
}

describe('versionCheck', () => {
  afterEach(() => {
    clearVersionOverride();
  });
  it('allows requests when no X-App-Version header is present', async () => {
    const app = createApp('abc123');

    const res = await app.request('/api/test');

    expect(res.status).toBe(200);
  });

  it('allows requests when versions match', async () => {
    const app = createApp('abc123');

    const res = await app.request('/api/test', {
      headers: { 'X-App-Version': 'abc123' },
    });

    expect(res.status).toBe(200);
  });

  it('returns 426 when web client version mismatches', async () => {
    const app = createApp('def456');

    const res = await app.request('/api/test', {
      headers: {
        'X-App-Version': 'abc123',
        'X-HushBox-Platform': 'web',
      },
    });

    expect(res.status).toBe(426);
    const body = await jsonBody<{ code: string; currentVersion: string; updateUrl?: string }>(res);
    expect(body.code).toBe('UPGRADE_REQUIRED');
    expect(body.currentVersion).toBe('def456');
    expect(body.updateUrl).toBeUndefined();
  });

  it('returns 426 with platform-specific updateUrl for ios client', async () => {
    const app = createApp('def456');

    const res = await app.request('/api/test', {
      headers: {
        'X-App-Version': 'abc123',
        'X-HushBox-Platform': 'ios',
      },
    });

    expect(res.status).toBe(426);
    const body = await jsonBody<{ code: string; currentVersion: string; updateUrl: string }>(res);
    expect(body.code).toBe('UPGRADE_REQUIRED');
    expect(body.currentVersion).toBe('def456');
    expect(body.updateUrl).toBe('/api/updates/download/ios/def456');
  });

  it('returns 426 with platform-specific updateUrl for android client', async () => {
    const app = createApp('def456');

    const res = await app.request('/api/test', {
      headers: {
        'X-App-Version': 'abc123',
        'X-HushBox-Platform': 'android',
      },
    });

    expect(res.status).toBe(426);
    const body = await jsonBody<{ updateUrl: string }>(res);
    expect(body.updateUrl).toBe('/api/updates/download/android/def456');
  });

  it('returns 426 with platform-specific updateUrl for android-direct client', async () => {
    const app = createApp('def456');

    const res = await app.request('/api/test', {
      headers: {
        'X-App-Version': 'abc123',
        'X-HushBox-Platform': 'android-direct',
      },
    });

    expect(res.status).toBe(426);
    const body = await jsonBody<{ updateUrl: string }>(res);
    expect(body.updateUrl).toBe('/api/updates/download/android-direct/def456');
  });

  it('skips check when server version is dev-local', async () => {
    const app = createApp('dev-local');

    const res = await app.request('/api/test', {
      headers: { 'X-App-Version': 'different-version' },
    });

    expect(res.status).toBe(200);
  });

  it('skips check when server version is test', async () => {
    const app = createApp('test');

    const res = await app.request('/api/test', {
      headers: { 'X-App-Version': 'different-version' },
    });

    expect(res.status).toBe(200);
  });

  it('skips check for /api/health route', async () => {
    const app = createApp('def456');

    const res = await app.request('/api/health', {
      headers: { 'X-App-Version': 'abc123' },
    });

    expect(res.status).toBe(200);
  });

  it('skips check for /api/webhooks route', async () => {
    const app = createApp('def456');

    const res = await app.request('/api/webhooks/payment', {
      headers: { 'X-App-Version': 'abc123' },
    });

    expect(res.status).toBe(200);
  });

  it('skips check for /api/auth/token-login route', async () => {
    const app = createApp('def456');

    const res = await app.request('/api/auth/token-login', {
      method: 'POST',
      headers: { 'X-App-Version': 'abc123' },
    });

    expect(res.status).toBe(200);
  });

  it('skips check for /api/updates route', async () => {
    const app = createApp('def456');

    const res = await app.request('/api/updates/current', {
      headers: { 'X-App-Version': 'abc123' },
    });

    expect(res.status).toBe(200);
  });

  it('uses version override instead of APP_VERSION when set', async () => {
    const app = createApp('original-version');
    setVersionOverride('overridden-version');

    const res = await app.request('/api/test', {
      headers: { 'X-App-Version': 'overridden-version' },
    });

    expect(res.status).toBe(200);
  });

  it('returns 426 when client does not match the override', async () => {
    const app = createApp('original-version');
    setVersionOverride('overridden-version');

    const res = await app.request('/api/test', {
      headers: { 'X-App-Version': 'original-version' },
    });

    expect(res.status).toBe(426);
    const body = await jsonBody<{ currentVersion: string }>(res);
    expect(body.currentVersion).toBe('overridden-version');
  });
});
