import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ERROR_CODES } from '@hushbox/shared';
import { createApp } from '../app.js';
import { defineSliceManifest, routeClass } from './pipeline-manifest.js';
import { clearVersionOverride } from './version-override.js';
import type { AppEnv } from './pipeline-manifest.js';
import type { Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

/** A public route that throws, mounted on the composed app to produce a true
 *  thrown-handler 500 that flows through the security-headers finally block. */
function createDefectManifest() {
  return defineSliceManifest({
    basePath: '/fixture',
    routes: new Hono<AppEnv>().get('/defect', routeClass('public'), () => {
      throw new Error('secret defect detail');
    }),
  });
}

/**
 * Edge-middleware behavior through the REAL composed app (`createApp`), not
 * the isolated per-middleware harnesses the unit suites use. This is the
 * only place version-check / CSRF / the security-headers finally-guarantee are
 * proven MOUNTED and firing in the composed pipeline order (edge middleware run
 * ahead of the auth pipeline, so a version/CSRF rejection precedes the 401).
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`edge-middleware tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const SECRET = 'secret-at-least-32-characters-long!!';

/** Baseline env: real infra creds so the bindings stage passes; no cookie is
 *  ever sent, so the session-revocation check never consults Redis. */
const devEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: requiredEnv('DATABASE_URL'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

/** A concrete server version (not a SKIP_VERSIONS value) so the check runs. */
const SERVER_VERSION = '2.4.0';
const versionedEnv: Bindings & TelemetryEnv & { APP_VERSION: string } = {
  ...devEnv,
  APP_VERSION: SERVER_VERSION,
};

const FRONTEND_URL = 'https://app.hushbox.ai';
const csrfEnv: Bindings & TelemetryEnv & { FRONTEND_URL: string } = {
  ...devEnv,
  FRONTEND_URL,
};

async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const SECURITY_HEADER_NAMES = [
  'Content-Security-Policy',
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Referrer-Policy',
  'Strict-Transport-Security',
  'Permissions-Policy',
] as const;

/** Asserts the finally-guarantee held: every security header is present, with
 *  a spot-check of representative values (full-equality lives in the unit suite). */
function assertSecurityHeadersPresent(res: Response): void {
  for (const name of SECURITY_HEADER_NAMES) {
    expect(res.headers.get(name), `missing ${name}`).toBeTruthy();
  }
  expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
  expect(res.headers.get('Permissions-Policy')).toContain('camera=()');
}

describe('version-check through the composed app', () => {
  afterEach(() => {
    clearVersionOverride();
  });

  it('rejects a stale web client with 426 and the current version on a non-exempt route', async () => {
    const res = await createApp().request(
      '/billing/balance',
      { headers: { 'X-App-Version': '1.0.0' } },
      versionedEnv
    );
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.VERSION_MISMATCH,
      currentVersion: SERVER_VERSION,
    });
  });

  it('gives a stale mobile client the OTA updateUrl', async () => {
    const res = await createApp().request(
      '/billing/balance',
      { headers: { 'X-App-Version': '1.0.0', 'X-HushBox-Platform': 'ios' } },
      versionedEnv
    );
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.VERSION_MISMATCH,
      currentVersion: SERVER_VERSION,
      updateUrl: `/updates/download/ios/${SERVER_VERSION}`,
    });
  });

  it('does NOT version-gate an exempt route (/health passes on a stale version)', async () => {
    const res = await createApp().request(
      '/health',
      { headers: { 'X-App-Version': '1.0.0' } },
      versionedEnv
    );
    expect(res.status).toBe(200);
    const body: { status: string; timestamp: string } = await res.json();
    expect(body.status).toBe('ok');
    // Shape assertion, not a frozen instant: this integration test drives the full
    // middleware pipeline against real infra, so freezing Date could perturb it.
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('passes a current-version client through to the auth pipeline (401, never 426)', async () => {
    const res = await createApp().request(
      '/billing/balance',
      { headers: { 'X-App-Version': SERVER_VERSION } },
      versionedEnv
    );
    expect(res.status).not.toBe(426);
    expect(res.status).toBe(401);
  });
});

describe('CSRF through the composed app', () => {
  it('refuses a mutating cross-origin request with 403 CSRF_REJECTED (before auth, no fail-open)', async () => {
    const res = await createApp().request(
      '/chat',
      { method: 'POST', headers: { Origin: 'https://evil.example' } },
      csrfEnv
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CSRF_REJECTED });
  });

  it('refuses a mutating request when no frontend origin is configured (missing config rejects)', async () => {
    const res = await createApp().request(
      '/chat',
      { method: 'POST', headers: { Origin: FRONTEND_URL } },
      devEnv
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CSRF_REJECTED });
  });

  it('passes a matching-origin mutation through to the auth pipeline (401, never 403)', async () => {
    const res = await createApp().request(
      '/chat',
      { method: 'POST', headers: { Origin: FRONTEND_URL } },
      csrfEnv
    );
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(401);
  });

  it('passes a mutation with no Origin header (same-origin fallback) through to auth (401)', async () => {
    const res = await createApp().request('/chat', { method: 'POST' }, csrfEnv);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(401);
  });

  it('exempts a state-changing request under an exempt prefix (token-login) even from an evil origin', async () => {
    const res = await createApp().request(
      '/auth/token-login',
      {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
        body: '{}',
      },
      csrfEnv
    );
    // CSRF let it through: the route exists and answered (not 403, not 404).
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });
});

describe('security headers on all response classes through the composed app', () => {
  it('sets every security header on a 200 (public health)', async () => {
    const res = await createApp().request('/health', {}, devEnv);
    expect(res.status).toBe(200);
    assertSecurityHeadersPresent(res);
  });

  it('sets every security header on a 401 (anonymous session route)', async () => {
    const res = await createApp().request('/billing/balance', {}, devEnv);
    expect(res.status).toBe(401);
    assertSecurityHeadersPresent(res);
  });

  it('sets every security header on a 404 (unknown path)', async () => {
    const res = await createApp().request('/no-such-route', {}, devEnv);
    expect(res.status).toBe(404);
    assertSecurityHeadersPresent(res);
  });

  it('sets every security header on a 500 (thrown handler — the finally-guarantee end-to-end)', async () => {
    const app = createApp();
    const manifest = createDefectManifest();
    app.route(manifest.basePath, manifest.routes);
    // The onError logs the defect through telemetry (console sink); silence it.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await app.request('/fixture/defect', {}, devEnv);
      expect(res.status).toBe(500);
      const body = await jsonBody<{ code: string }>(res);
      expect(body).toEqual({ code: ERROR_CODES.INTERNAL });
      assertSecurityHeadersPresent(res);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
