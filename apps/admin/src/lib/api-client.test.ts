import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestUrl } from '@/test-utils/request-url';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
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
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(Response.json({}, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const { client } = await importClient();

    await client.admin.dashboard.$get();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain('/api/admin/dashboard');
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
});
