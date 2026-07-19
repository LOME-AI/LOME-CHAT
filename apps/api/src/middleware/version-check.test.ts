import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { VERSION_CHECK_EXEMPT_PREFIXES, versionCheck } from './version-check.js';
import { clearVersionOverride, setVersionOverride } from './version-override.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';

const SERVER_VERSION = '2.4.0';

const env: Bindings & { APP_VERSION?: string } = {
  NODE_ENV: 'development',
  APP_VERSION: SERVER_VERSION,
};

function buildApp(): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', versionCheck())
    .all('*', (c) => c.json({ ok: true }))
    .onError((_error, c) => c.json({ code: 'INTERNAL' }, 500));
}

async function get(
  path: string,
  headers: Record<string, string>,
  testEnv: typeof env = env
): Promise<Response> {
  return buildApp().request(path, { headers }, testEnv);
}

describe('versionCheck', () => {
  it('passes a request without an X-App-Version header (WS upgrades cannot set it)', async () => {
    const res = await get('/chat', {});
    expect(res.status).toBe(200);
  });

  it('passes a matching client version', async () => {
    const res = await get('/chat', { 'X-App-Version': SERVER_VERSION });
    expect(res.status).toBe(200);
  });

  it.each(['dev-local', 'test'])('skips the check entirely for server version %s', async (v) => {
    const res = await get('/chat', { 'X-App-Version': 'anything' }, { ...env, APP_VERSION: v });
    expect(res.status).toBe(200);
  });

  it('rejects a stale web client with 426 and the current version', async () => {
    const res = await get('/chat', { 'X-App-Version': '1.0.0' });
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({
      code: 'VERSION_MISMATCH',
      details: { currentVersion: SERVER_VERSION },
    });
  });

  it.each(['ios', 'android', 'android-direct'])(
    'gives the %s platform an OTA updateUrl on mismatch',
    async (platform) => {
      const res = await get('/chat', {
        'X-App-Version': '1.0.0',
        'X-HushBox-Platform': platform,
      });
      expect(res.status).toBe(426);
      expect(await res.json()).toEqual({
        code: 'VERSION_MISMATCH',
        details: {
          currentVersion: SERVER_VERSION,
          updateUrl: `/updates/download/${platform}/${SERVER_VERSION}`,
        },
      });
    }
  );

  it('treats an unknown platform header as web (no updateUrl)', async () => {
    const res = await get('/chat', {
      'X-App-Version': '1.0.0',
      'X-HushBox-Platform': 'smart-fridge',
    });
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({
      code: 'VERSION_MISMATCH',
      details: { currentVersion: SERVER_VERSION },
    });
  });

  it.each([...VERSION_CHECK_EXEMPT_PREFIXES])(
    'exempts the %s prefix even on mismatch',
    async (prefix) => {
      const res = await get(prefix, { 'X-App-Version': '1.0.0' });
      expect(res.status).toBe(200);
    }
  );

  it('fails fast (500 defect) when APP_VERSION is missing and a client sent a version', async () => {
    const res = await get('/chat', { 'X-App-Version': '1.0.0' }, { NODE_ENV: 'development' });
    expect(res.status).toBe(500);
  });

  it('fails fast (500 defect) when APP_VERSION is empty', async () => {
    const res = await get(
      '/chat',
      { 'X-App-Version': '1.0.0' },
      { NODE_ENV: 'development', APP_VERSION: '' }
    );
    expect(res.status).toBe(500);
  });

  describe('dev version override', () => {
    afterEach(() => {
      clearVersionOverride();
    });

    it('drives a mismatch even when APP_VERSION is a skip version (dev-local)', async () => {
      setVersionOverride('9.9.9');
      const res = await get(
        '/chat',
        { 'X-App-Version': '1.0.0' },
        { ...env, APP_VERSION: 'dev-local' }
      );
      expect(res.status).toBe(426);
      expect(await res.json()).toEqual({
        code: 'VERSION_MISMATCH',
        details: { currentVersion: '9.9.9' },
      });
    });

    it('passes a client that matches the override', async () => {
      setVersionOverride('9.9.9');
      const res = await get('/chat', { 'X-App-Version': '9.9.9' });
      expect(res.status).toBe(200);
    });

    it('falls back to APP_VERSION once the override is cleared', async () => {
      setVersionOverride('9.9.9');
      clearVersionOverride();
      const res = await get('/chat', { 'X-App-Version': SERVER_VERSION });
      expect(res.status).toBe(200);
    });
  });
});
