import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { securityHeaders } from './security-headers.js';
import type { AppEnv } from '../lib/context/index.js';

const EXPECTED_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
} as const;

/** Mirrors the app assembly's shape: middleware + notFound + onError. */
function buildApp(): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', securityHeaders())
    .get('/ok', (c) => c.json({ ok: true }))
    .get('/boom', () => {
      throw new Error('defect');
    })
    .notFound((c) => c.json({ code: 'NOT_FOUND' }, 404))
    .onError((_error, c) => c.json({ code: 'INTERNAL' }, 500));
}

function assertHeaders(res: Response): void {
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    expect(res.headers.get(name)).toBe(value);
  }
}

describe('securityHeaders', () => {
  it('sets every security header on a success response', async () => {
    const res = await buildApp().request('/ok');
    expect(res.status).toBe(200);
    assertHeaders(res);
  });

  it('sets every security header on an error (500) response', async () => {
    const res = await buildApp().request('/boom');
    expect(res.status).toBe(500);
    assertHeaders(res);
  });

  it('sets every security header on a 404 response', async () => {
    const res = await buildApp().request('/nowhere');
    expect(res.status).toBe(404);
    assertHeaders(res);
  });

  it('does not set HSTS or Permissions-Policy (legacy parity)', async () => {
    const res = await buildApp().request('/ok');
    expect(res.headers.get('Strict-Transport-Security')).toBeNull();
    expect(res.headers.get('Permissions-Policy')).toBeNull();
  });
});
