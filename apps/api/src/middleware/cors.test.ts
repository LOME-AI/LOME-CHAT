import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { cors } from './cors.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';

const FRONTEND_URL = 'https://app.hushbox.ai';
const FRONTEND_PREVIEW_URL = 'https://preview.hushbox.ai';

const env: Bindings & { FRONTEND_URL?: string; FRONTEND_PREVIEW_URL?: string } = {
  NODE_ENV: 'development',
  FRONTEND_URL,
  FRONTEND_PREVIEW_URL,
};

function buildApp(): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', cors())
    .get('/resource', (c) => c.json({ ok: true }))
    .get('/announcements/banner', (c) => c.json({ ok: true }));
}

describe('cors', () => {
  it('allows a simple request from the configured frontend origin with credentials', async () => {
    const res = await buildApp().request('/resource', { headers: { Origin: FRONTEND_URL } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(FRONTEND_URL);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('answers a preflight for the configured frontend origin', async () => {
    const res = await buildApp().request(
      '/resource',
      {
        method: 'OPTIONS',
        headers: {
          Origin: FRONTEND_URL,
          'Access-Control-Request-Method': 'POST',
        },
      },
      env
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(FRONTEND_URL);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('allows the preview origin when configured', async () => {
    const res = await buildApp().request(
      '/resource',
      { headers: { Origin: FRONTEND_PREVIEW_URL } },
      env
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(FRONTEND_PREVIEW_URL);
  });

  it.each(['capacitor://localhost', 'http://localhost'])(
    'allows the Capacitor WebView origin %s',
    async (origin) => {
      const res = await buildApp().request('/resource', { headers: { Origin: origin } }, env);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }
  );

  it('grants no CORS headers to a disallowed origin', async () => {
    const res = await buildApp().request(
      '/resource',
      { headers: { Origin: 'https://evil.example' } },
      env
    );
    // CORS does not block server-side; it just withholds the grant.
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('has no wildcard public carve-out: public read paths still require an allowed origin', async () => {
    // The legacy '/api/public/' wildcard prefix has no new-tree equivalent, so
    // the wildcard rule applies to nothing — every path uses the allowlist.
    const res = await buildApp().request(
      '/announcements/banner',
      { headers: { Origin: 'https://evil.example' } },
      env
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('omits the preview origin from the allowlist when not configured', async () => {
    const withoutPreview: typeof env = { NODE_ENV: 'development', FRONTEND_URL };
    const res = await buildApp().request(
      '/resource',
      { headers: { Origin: FRONTEND_PREVIEW_URL } },
      withoutPreview
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('still allows Capacitor origins when no frontend URLs are configured (legacy tolerance)', async () => {
    const bare: typeof env = { NODE_ENV: 'development' };
    const res = await buildApp().request(
      '/resource',
      { headers: { Origin: 'capacitor://localhost' } },
      bare
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost');
  });
});
