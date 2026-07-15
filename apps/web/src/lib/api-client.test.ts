import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useAppVersionStore } from '@/stores/app-version';

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type FetchCallWithInit = [Request | string | URL, RequestInit | undefined];

vi.mock('./api.js', () => ({
  getApiUrl: () => 'http://localhost:8787',
  ApiError,
}));

vi.mock('@/capacitor/platform.js', () => ({
  getPlatform: () => 'web',
}));

describe('api-client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports a client object', async () => {
    const { client } = await import('./api-client.js');
    expect(client).toBeDefined();
  });

  it('makes requests to the correct API URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json(
        { status: 'ok', timestamp: '2024-01-01T00:00:00.000Z' },
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const { client } = await import('./api-client.js');
    await client.health.$get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    type FetchCallArgs = [Request | string | URL];
    const callArgs = fetchSpy.mock.calls[0] as FetchCallArgs;
    const requestUrl = callArgs[0] instanceof Request ? callArgs[0].url : String(callArgs[0]);
    expect(requestUrl).toContain('http://localhost:8787/health');
  });

  it('uses credentials omit and sets header when link guest auth is active', async () => {
    const { setLinkGuestAuth, clearLinkGuestAuth } = await import('./link-guest-auth.js');
    setLinkGuestAuth('test-public-key-base64');

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          { status: 'ok', timestamp: '2024-01-01T00:00:00.000Z' },
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const { client } = await import('./api-client.js');
    await client.health.$get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy.mock.calls[0] as FetchCallWithInit;
    const requestInit = callArgs[1];
    expect(requestInit?.credentials).toBe('omit');
    const headers = new Headers(requestInit?.headers);
    expect(headers.get('X-Link-Public-Key')).toBe('test-public-key-base64');

    clearLinkGuestAuth();
  });

  it('includes credentials include in requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json(
        { status: 'ok', timestamp: '2024-01-01T00:00:00.000Z' },
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const { client } = await import('./api-client.js');
    await client.health.$get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy.mock.calls[0] as FetchCallWithInit;
    const requestInit = callArgs[1];
    expect(requestInit?.credentials).toBe('include');
  });
});

describe('fetchJson', () => {
  beforeEach(() => {
    useAppVersionStore.setState({
      upgradeRequired: false,
      currentVersion: null,
      updateUrl: null,
    });
  });

  it('returns parsed JSON on successful response', async () => {
    const { fetchJson } = await import('./api-client.js');
    const data = { id: '1', name: 'test' };
    const response = Promise.resolve(
      Response.json(data, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await fetchJson<{ id: string; name: string }>(response);

    expect(result).toEqual(data);
  });

  it('returns undefined on 204 No Content without trying to parse JSON', async () => {
    const { fetchJson } = await import('./api-client.js');
    const response = Promise.resolve(new Response(null, { status: 204 }));

    const result = await fetchJson(response);

    expect(result).toBeUndefined();
  });

  it('throws ApiError on non-ok response with error field', async () => {
    const { fetchJson } = await import('./api-client.js');
    const errorBody = { code: 'NOT_FOUND' };
    const response = Promise.resolve(
      Response.json(errorBody, {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(fetchJson(response)).rejects.toThrow(ApiError);
    await expect(
      fetchJson(
        Promise.resolve(
          Response.json(errorBody, {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      )
    ).rejects.toThrow('NOT_FOUND');
  });

  it('throws ApiError with "Request failed" when response has no error field', async () => {
    const { fetchJson } = await import('./api-client.js');
    const body = { something: 'else' };
    const response = Promise.resolve(
      Response.json(body, {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(fetchJson(response)).rejects.toThrow('INTERNAL');
  });

  it('throws ApiError when response body is not valid JSON', async () => {
    const { fetchJson } = await import('./api-client.js');
    const response = Promise.resolve(
      new Response('not json', {
        status: 502,
      })
    );

    await expect(fetchJson(response)).rejects.toThrow(ApiError);
    await expect(
      fetchJson(
        Promise.resolve(
          new Response('not json', {
            status: 502,
          })
        )
      )
    ).rejects.toThrow('INTERNAL');
  });

  it('preserves status code in ApiError', async () => {
    const { fetchJson } = await import('./api-client.js');
    const response = Promise.resolve(
      Response.json(
        { code: 'FORBIDDEN' },
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    try {
      await fetchJson(response);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(403);
    }
  });

  it('preserves response body data in ApiError', async () => {
    const { fetchJson } = await import('./api-client.js');
    const errorBody = { code: 'VALIDATION', details: ['field required'] };
    const response = Promise.resolve(
      Response.json(errorBody, {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    try {
      await fetchJson(response);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).data).toEqual(errorBody);
    }
  });

  it('sets upgradeRequired in store on 426 response', async () => {
    const { fetchJson } = await import('./api-client.js');
    const errorBody = { code: 'UPGRADE_REQUIRED', currentVersion: 'abc123' };
    const response = Promise.resolve(
      Response.json(errorBody, {
        status: 426,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(fetchJson(response)).rejects.toThrow('UPGRADE_REQUIRED');
    expect(useAppVersionStore.getState().upgradeRequired).toBe(true);
  });

  it('still throws ApiError on 426 after setting store', async () => {
    const { fetchJson } = await import('./api-client.js');
    const errorBody = { code: 'UPGRADE_REQUIRED', currentVersion: 'abc123' };
    const response = Promise.resolve(
      Response.json(errorBody, {
        status: 426,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    try {
      await fetchJson(response);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(426);
    }
  });

  it('stashes currentVersion and updateUrl from a 426 body', async () => {
    const { fetchJson } = await import('./api-client.js');
    const errorBody = {
      code: 'VERSION_MISMATCH',
      currentVersion: 'srv-9',
      updateUrl: '/updates/download/ios/srv-9',
    };
    const response = Promise.resolve(
      Response.json(errorBody, {
        status: 426,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(fetchJson(response)).rejects.toThrow('VERSION_MISMATCH');

    const state = useAppVersionStore.getState();
    expect(state.upgradeRequired).toBe(true);
    expect(state.currentVersion).toBe('srv-9');
    expect(state.updateUrl).toBe('/updates/download/ios/srv-9');
  });

  it('nulls updateUrl on a web-platform 426 body carrying only currentVersion', async () => {
    const { fetchJson } = await import('./api-client.js');
    const errorBody = { code: 'VERSION_MISMATCH', currentVersion: 'web-3' };
    const response = Promise.resolve(
      Response.json(errorBody, {
        status: 426,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(fetchJson(response)).rejects.toThrow('VERSION_MISMATCH');

    const state = useAppVersionStore.getState();
    expect(state.currentVersion).toBe('web-3');
    expect(state.updateUrl).toBeNull();
  });

  it('falls back to the boolean flag on a 426 with no parseable body', async () => {
    const { fetchJson } = await import('./api-client.js');
    const response = Promise.resolve(new Response('not json', { status: 426 }));

    await expect(fetchJson(response)).rejects.toThrow(ApiError);

    const state = useAppVersionStore.getState();
    expect(state.upgradeRequired).toBe(true);
    expect(state.currentVersion).toBeNull();
    expect(state.updateUrl).toBeNull();
  });
});

describe('platform and version headers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function getHeaderFromFetchCall(fetchCall: unknown[], headerName: string): string | null {
    const [req, init] = fetchCall as [Request | string | URL, RequestInit | undefined];
    if (req instanceof Request) {
      return req.headers.get(headerName);
    }
    if (init?.headers) {
      return new Headers(init.headers).get(headerName);
    }
    return null;
  }

  it('sends X-HushBox-Platform header with every request', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          { status: 'ok', timestamp: '2024-01-01T00:00:00.000Z' },
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    vi.resetModules();
    const { client } = await import('./api-client.js');
    await client.health.$get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const platform = getHeaderFromFetchCall(fetchSpy.mock.calls[0]!, 'X-HushBox-Platform');
    expect(platform).toBe('web');
  });

  it('sends X-App-Version header with every request', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          { status: 'ok', timestamp: '2024-01-01T00:00:00.000Z' },
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    vi.resetModules();
    const { client } = await import('./api-client.js');
    await client.health.$get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const version = getHeaderFromFetchCall(fetchSpy.mock.calls[0]!, 'X-App-Version');
    expect(version).toBe('dev-local');
  });

  it('reads X-App-Version from the registry env, not a hardcoded default', async () => {
    vi.stubEnv('VITE_APP_VERSION', 'srv-42');
    vi.resetModules();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          { status: 'ok', timestamp: '2024-01-01T00:00:00.000Z' },
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const { client } = await import('./api-client.js');
    await client.health.$get();

    const version = getHeaderFromFetchCall(fetchSpy.mock.calls[0]!, 'X-App-Version');
    expect(version).toBe('srv-42');
  });

  it('fails fast (throws on import) when VITE_APP_VERSION is missing/empty', async () => {
    vi.stubEnv('VITE_APP_VERSION', '');
    vi.resetModules();
    await expect(import('./api-client.js')).rejects.toThrow();
  });
});
