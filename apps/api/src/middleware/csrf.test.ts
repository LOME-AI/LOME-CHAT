import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { ERROR_CODES, errorResponseSchema } from '@hushbox/shared';
import { CSRF_EXEMPT_PATH_PREFIXES, csrfProtection } from './csrf.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';

const FRONTEND_URL = 'https://app.hushbox.ai';
const FRONTEND_PREVIEW_URL = 'https://preview.hushbox.ai';
const ADMIN_URL = 'https://admin.hushbox.ai';

const env: Bindings & {
  FRONTEND_URL?: string;
  FRONTEND_PREVIEW_URL?: string;
  ADMIN_URL?: string;
} = {
  NODE_ENV: 'development',
  FRONTEND_URL,
  FRONTEND_PREVIEW_URL,
  ADMIN_URL,
};

function buildApp(): Hono<AppEnv> {
  return new Hono<AppEnv>().use('*', csrfProtection()).all('*', (c) => c.json({ ok: true }));
}

async function post(path: string, origin?: string, testEnv = env): Promise<Response> {
  return buildApp().request(
    path,
    { method: 'POST', ...(origin === undefined ? {} : { headers: { Origin: origin } }) },
    testEnv
  );
}

describe('csrfProtection', () => {
  it('allows a mutating request without an Origin header (same-origin)', async () => {
    const res = await post('/conversations');
    expect(res.status).toBe(200);
  });

  it.each(['capacitor://localhost', 'http://localhost'])(
    'allows the Capacitor origin %s',
    async (origin) => {
      const res = await post('/conversations', origin);
      expect(res.status).toBe(200);
    }
  );

  it('allows the configured FRONTEND_URL origin', async () => {
    const res = await post('/conversations', FRONTEND_URL);
    expect(res.status).toBe(200);
  });

  it('allows the configured FRONTEND_PREVIEW_URL origin', async () => {
    const res = await post('/conversations', FRONTEND_PREVIEW_URL);
    expect(res.status).toBe(200);
  });

  it('allows the configured ADMIN_URL origin (admin SPA same-origin mutations carry it)', async () => {
    const res = await post('/conversations', ADMIN_URL);
    expect(res.status).toBe(200);
  });

  it('allows the local dev admin origin when ADMIN_URL is configured to it', async () => {
    const res = await post('/conversations', 'http://localhost:7000', {
      NODE_ENV: 'development',
      ADMIN_URL: 'http://localhost:7000',
    });
    expect(res.status).toBe(200);
  });

  it('rejects a mismatched Origin even with ADMIN_URL configured', async () => {
    const res = await post('/conversations', 'https://evil.example', {
      NODE_ENV: 'development',
      ADMIN_URL,
    });
    expect(res.status).toBe(403);
    const body = errorResponseSchema.parse(await res.json());
    expect(body).toEqual({ code: ERROR_CODES.CSRF_REJECTED });
  });

  it('rejects a mismatched Origin with 403 CSRF_REJECTED', async () => {
    const res = await post('/conversations', 'https://evil.example');
    expect(res.status).toBe(403);
    const body = errorResponseSchema.parse(await res.json());
    expect(body).toEqual({ code: ERROR_CODES.CSRF_REJECTED });
  });

  it('rejects an unparseable Origin with 403 CSRF_REJECTED', async () => {
    const res = await post('/conversations', 'not-a-url');
    expect(res.status).toBe(403);
    const body = errorResponseSchema.parse(await res.json());
    expect(body).toEqual({ code: ERROR_CODES.CSRF_REJECTED });
  });

  it('rejects a cross-origin mutation when no frontend URLs are configured', async () => {
    const res = await post('/conversations', FRONTEND_URL, { NODE_ENV: 'development' });
    expect(res.status).toBe(403);
    const body = errorResponseSchema.parse(await res.json());
    expect(body).toEqual({ code: ERROR_CODES.CSRF_REJECTED });
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('never blocks a %s request', async (method) => {
    const res = await buildApp().request(
      '/conversations',
      { method, headers: { Origin: 'https://evil.example' } },
      env
    );
    expect(res.status).toBe(200);
  });

  it.each([...CSRF_EXEMPT_PATH_PREFIXES])(
    'exempts mutating requests under %s from Origin validation',
    async (prefix) => {
      const res = await post(prefix, 'https://evil.example');
      expect(res.status).toBe(200);
    }
  );

  it('exempts the Helcim payment webhook route', async () => {
    const res = await post('/billing/webhooks/payment', 'https://evil.example');
    expect(res.status).toBe(200);
  });

  it('exempts token-login', async () => {
    const res = await post('/auth/token-login', 'https://evil.example');
    expect(res.status).toBe(200);
  });

  it.each([
    '/conversations/abc/websocket',
    '/chat/trial/websocket',
    '/health',
    '/conversations/shared/some-link',
  ])('never blocks the GET surface %s (WS upgrades, health, public share read)', async (path) => {
    const res = await buildApp().request(
      path,
      { headers: { Origin: 'https://evil.example' } },
      env
    );
    expect(res.status).toBe(200);
  });

  it.each(['PUT', 'DELETE', 'PATCH'])('guards the %s method', async (method) => {
    const res = await buildApp().request(
      '/conversations',
      { method, headers: { Origin: 'https://evil.example' } },
      env
    );
    expect(res.status).toBe(403);
  });
});
