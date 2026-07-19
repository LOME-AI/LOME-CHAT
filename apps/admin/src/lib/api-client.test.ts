import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestUrl } from '@/test-utils/request-url';

type FetchInput = string | URL | Request;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function importClient(): Promise<typeof import('./api-client.js')> {
  return import('./api-client.js');
}

describe('api client base', () => {
  it('exposes the relative /api base', async () => {
    const { ADMIN_API_BASE } = await importClient();
    expect(ADMIN_API_BASE).toBe('/api');
  });

  it('builds typed-client requests under /api (path mapping proof)', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(Response.json({}, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const { client } = await importClient();

    await client.admin.dashboard.$get();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain('/api/admin/dashboard');
  });

  it('production-leak guard: with dev auth disabled, no token is minted and no Access header is attached', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(Response.json({}, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);
    // Plain vitest env (MODE 'test', no E2E/CI flags) computes disabled — the
    // same shape a production build takes (isProduction additionally pins it).
    const { client } = await importClient();

    await client.admin.dashboard.$get();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    const request = call[0];
    const headers = request instanceof Request ? request.headers : new Headers(call[1]?.headers);
    expect(headers.has('Cf-Access-Jwt-Assertion')).toBe(false);
    expect(requestUrl(request)).not.toContain('/api/dev/admin-token');
  });
  it('with dev auth enabled, mints a dev token and attaches the Access header', async () => {
    // The CI-e2e shape (same as env.test.ts): baked E2E enables dev auth.
    vi.stubEnv('VITE_CI', 'true');
    vi.stubEnv('VITE_E2E', 'true');
    const fetchMock = vi.fn((input: FetchInput, _init?: RequestInit) => {
      if (requestUrl(input).includes('/api/dev/admin-token')) {
        return Promise.resolve(Response.json({ token: 'dev-jwt' }, { status: 200 }));
      }
      return Promise.resolve(Response.json({}, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { client } = await importClient();

    await client.admin.dashboard.$get();

    const urls = fetchMock.mock.calls.map((call) => requestUrl(call[0]));
    expect(urls.some((url) => url.includes('/api/dev/admin-token'))).toBe(true);
    const dashboardCall = fetchMock.mock.calls.find((call) =>
      requestUrl(call[0]).includes('/api/admin/dashboard')
    );
    expect(dashboardCall).toBeDefined();
    const headers =
      dashboardCall![0] instanceof Request
        ? dashboardCall![0].headers
        : new Headers(dashboardCall![1]?.headers);
    expect(headers.get('Cf-Access-Jwt-Assertion')).toBe('dev-jwt');
  });
});

describe('ApiError', () => {
  it('carries code, status, and body', async () => {
    const { ApiError } = await importClient();
    const error = new ApiError('UNAUTHORIZED', 401, { code: 'UNAUTHORIZED' });
    expect(error.message).toBe('UNAUTHORIZED');
    expect(error.status).toBe(401);
    expect(error.body).toEqual({ code: 'UNAUTHORIZED' });
    expect(error.name).toBe('ApiError');
  });
});

describe('fetchJson', () => {
  it('returns parsed JSON on success', async () => {
    const { fetchJson } = await importClient();
    const result = await fetchJson<{ ok: boolean }>(
      Promise.resolve(Response.json({ ok: true }, { status: 200 }))
    );
    expect(result).toEqual({ ok: true });
  });

  it('returns undefined for 204 No Content', async () => {
    const { fetchJson } = await importClient();
    await expect(
      fetchJson<unknown>(Promise.resolve(new Response(null, { status: 204 })))
    ).resolves.toBeUndefined();
  });

  it('throws ApiError with the body code on failure', async () => {
    const { fetchJson, ApiError } = await importClient();
    const failing = fetchJson(
      Promise.resolve(Response.json({ code: 'FORBIDDEN' }, { status: 403 }))
    );
    await expect(failing).rejects.toThrow(ApiError);
    await expect(
      fetchJson(Promise.resolve(Response.json({ code: 'FORBIDDEN' }, { status: 403 })))
    ).rejects.toMatchObject({ message: 'FORBIDDEN', status: 403 });
  });

  it('falls back to INTERNAL when the failure body is not JSON', async () => {
    const { fetchJson } = await importClient();
    await expect(
      fetchJson(Promise.resolve(new Response('not json', { status: 500 })))
    ).rejects.toMatchObject({ message: 'INTERNAL', status: 500 });
  });

  it('falls back to INTERNAL when the failure body has no string code', async () => {
    const { fetchJson } = await importClient();
    await expect(
      fetchJson(Promise.resolve(Response.json({ code: 42 }, { status: 500 })))
    ).rejects.toMatchObject({ message: 'INTERNAL', status: 500 });
  });

  it('throws AccessExpiredError on a 401 (Access rejected the assertion)', async () => {
    const { fetchJson, AccessExpiredError } = await importClient();
    await expect(
      fetchJson(Promise.resolve(Response.json({ code: 'UNAUTHORIZED' }, { status: 401 })))
    ).rejects.toBeInstanceOf(AccessExpiredError);
  });

  it('throws AccessExpiredError on a 200 that is HTML (the Access login page)', async () => {
    const { fetchJson, AccessExpiredError } = await importClient();
    await expect(
      fetchJson(
        Promise.resolve(
          new Response('<!doctype html><title>login</title>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        )
      )
    ).rejects.toBeInstanceOf(AccessExpiredError);
  });

  it('throws AccessExpiredError on a followed redirect', async () => {
    const { fetchJson, AccessExpiredError } = await importClient();
    const res = Response.json({ ok: true }, { status: 200 });
    Object.defineProperty(res, 'redirected', { value: true });
    await expect(fetchJson(Promise.resolve(res))).rejects.toBeInstanceOf(AccessExpiredError);
  });

  it('does NOT treat a real ApiError as an Access expiry (no reload signal)', async () => {
    const { fetchJson, ApiError, AccessExpiredError } = await importClient();
    const failing = fetchJson(
      Promise.resolve(Response.json({ code: 'FORBIDDEN' }, { status: 403 }))
    );
    await expect(failing).rejects.toBeInstanceOf(ApiError);
    await expect(
      fetchJson(Promise.resolve(Response.json({ code: 'FORBIDDEN' }, { status: 403 })))
    ).rejects.not.toBeInstanceOf(AccessExpiredError);
  });
});

describe('isAccessExpirySignature', () => {
  it('flags an opaque redirect', async () => {
    const { isAccessExpirySignature } = await importClient();
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'type', { value: 'opaqueredirect' });
    expect(isAccessExpirySignature(res)).toBe(true);
  });

  it('flags a followed redirect', async () => {
    const { isAccessExpirySignature } = await importClient();
    const res = Response.json({ ok: true }, { status: 200 });
    Object.defineProperty(res, 'redirected', { value: true });
    expect(isAccessExpirySignature(res)).toBe(true);
  });

  it('flags a 401', async () => {
    const { isAccessExpirySignature } = await importClient();
    expect(isAccessExpirySignature(new Response(null, { status: 401 }))).toBe(true);
  });

  it('flags a non-JSON 200', async () => {
    const { isAccessExpirySignature } = await importClient();
    expect(
      isAccessExpirySignature(
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      )
    ).toBe(true);
  });

  it('does not flag a JSON 200', async () => {
    const { isAccessExpirySignature } = await importClient();
    expect(isAccessExpirySignature(Response.json({ ok: true }, { status: 200 }))).toBe(false);
  });

  it('does not flag a non-JSON 500 (a normal server error, not an expiry)', async () => {
    const { isAccessExpirySignature } = await importClient();
    expect(isAccessExpirySignature(new Response('boom', { status: 500 }))).toBe(false);
  });

  it('does not flag a 204 No Content', async () => {
    const { isAccessExpirySignature } = await importClient();
    expect(isAccessExpirySignature(new Response(null, { status: 204 }))).toBe(false);
  });
});

describe('AccessExpiredError', () => {
  it('is a distinguishable named error', async () => {
    const { AccessExpiredError } = await importClient();
    const error = new AccessExpiredError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AccessExpiredError');
  });
});
