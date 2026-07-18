import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { cors } from './cors.js';
import { routeClass } from './pipeline-markers.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';

const FRONTEND_URL = 'https://app.hushbox.ai';
const FRONTEND_PREVIEW_URL = 'https://preview.hushbox.ai';
const MARKETING_DEV_ORIGIN = 'http://localhost:4321';

const env: Bindings & { FRONTEND_URL?: string; FRONTEND_PREVIEW_URL?: string } = {
  NODE_ENV: 'development',
  FRONTEND_URL,
  FRONTEND_PREVIEW_URL,
};

function buildApp(): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', cors())
    .get('/resource', routeClass('session'), (c) => c.json({ ok: true }))
    .get('/admin/ops', routeClass('admin'), (c) => c.json({ ok: true }))
    .get('/announcements/banner', routeClass('public'), (c) => c.json({ ok: true }))
    .get('/unclassed', (c) => c.json({ ok: true }));
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

  it('grants no CORS headers to a disallowed origin on a session route', async () => {
    const res = await buildApp().request(
      '/resource',
      { headers: { Origin: 'https://evil.example' } },
      env
    );
    // CORS does not block server-side; it just withholds the grant.
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('denies the marketing dev origin on a session route', async () => {
    const res = await buildApp().request(
      '/resource',
      { headers: { Origin: MARKETING_DEV_ORIGIN } },
      env
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('keeps the admin route on the strict allowlist branch', async () => {
    const allowed = await buildApp().request(
      '/admin/ops',
      { headers: { Origin: FRONTEND_URL } },
      env
    );
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(FRONTEND_URL);
    expect(allowed.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    const denied = await buildApp().request(
      '/admin/ops',
      { headers: { Origin: MARKETING_DEV_ORIGIN } },
      env
    );
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('keeps the credentialed grant on a public-classed route for an allowlisted origin', async () => {
    // The web client sends credentials on EVERY call; browsers hard-reject
    // ACAO '*' on credentialed requests, so allowlisted origins must keep the
    // echo + credentials grant even on public-classed routes.
    const res = await buildApp().request(
      '/announcements/banner',
      { headers: { Origin: FRONTEND_URL } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(FRONTEND_URL);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('grants the wildcard to a public-classed route for the marketing dev origin, without credentials', async () => {
    const res = await buildApp().request(
      '/announcements/banner',
      { headers: { Origin: MARKETING_DEV_ORIGIN } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('grants the wildcard to a public-classed route for any non-allowlisted origin', async () => {
    const res = await buildApp().request(
      '/announcements/banner',
      { headers: { Origin: 'https://evil.example' } },
      env
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('varies the public wildcard branch by Origin (caches must not serve it to app origins)', async () => {
    const res = await buildApp().request(
      '/announcements/banner',
      { headers: { Origin: MARKETING_DEV_ORIGIN } },
      env
    );
    expect(res.headers.get('Vary') ?? '').toContain('Origin');
  });

  it('varies the allowlisted grant on a public-classed route by Origin', async () => {
    // Pins hono/cors's Vary emission on the allowlist branch: the public
    // route's response differs by request Origin (echo+credentials vs
    // '*'-no-credentials), so a cache must key on Origin for BOTH branches.
    const res = await buildApp().request(
      '/announcements/banner',
      { headers: { Origin: FRONTEND_URL } },
      env
    );
    expect(res.headers.get('Vary') ?? '').toContain('Origin');
  });

  it('takes the wildcard branch on a public-classed route when Origin is absent', async () => {
    const res = await buildApp().request('/announcements/banner', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(res.headers.get('Vary') ?? '').toContain('Origin');
  });

  it('grants no CORS headers to a foreign-origin preflight on a public route', async () => {
    // OPTIONS matches no classed handler, so the preflight rides the strict
    // allowlist branch and fails — the public surface is simple-requests-only.
    const res = await buildApp().request(
      '/announcements/banner',
      {
        method: 'OPTIONS',
        headers: {
          Origin: MARKETING_DEV_ORIGIN,
          'Access-Control-Request-Method': 'GET',
        },
      },
      env
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('falls to the strict branch for a non-allowlisted origin on a route with no declared class', async () => {
    const res = await buildApp().request(
      '/unclassed',
      { headers: { Origin: MARKETING_DEV_ORIGIN } },
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
