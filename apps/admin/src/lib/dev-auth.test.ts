import { describe, it, expect, vi } from 'vitest';
import { requestUrl } from '@/test-utils/request-url';
import { CF_ACCESS_JWT_HEADER, createDevAuthFetch } from './dev-auth.js';

const MINT_PATH = '/api/dev/admin-token';

interface FetchCall {
  url: string;
  headers: Headers;
}

function createBackend(options?: { rejectToken?: string }): {
  baseFetch: typeof fetch;
  calls: FetchCall[];
  mints: string[];
} {
  const calls: FetchCall[] = [];
  const mints: string[] = [];
  let mintCounter = 0;
  const baseFetch: typeof fetch = (input, init) => {
    const url = requestUrl(input);
    if (url.startsWith(MINT_PATH)) {
      const email = new URL(url, 'http://localhost').searchParams.get('email') ?? '';
      mintCounter += 1;
      const token = `token-${email}-${String(mintCounter)}`;
      mints.push(token);
      return Promise.resolve(
        Response.json({ token, header: CF_ACCESS_JWT_HEADER }, { status: 200 })
      );
    }
    const headers = new Headers(init?.headers);
    calls.push({ url, headers });
    if (
      options?.rejectToken !== undefined &&
      headers.get(CF_ACCESS_JWT_HEADER) === options.rejectToken
    ) {
      return Promise.resolve(new Response(null, { status: 401 }));
    }
    return Promise.resolve(Response.json({ ok: true }, { status: 200 }));
  };
  return { baseFetch, calls, mints };
}

describe('createDevAuthFetch', () => {
  it('attaches nothing outside local dev (production posture)', async () => {
    const { baseFetch, calls } = createBackend();
    const wrapped = createDevAuthFetch({
      baseFetch,
      isLocalDev: false,
      getActor: () => 'admin@hushbox.test',
    });

    await wrapped('/api/admin/dashboard');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.has(CF_ACCESS_JWT_HEADER)).toBe(false);
  });

  it('mints a token for the current actor and attaches it in local dev', async () => {
    const { baseFetch, calls, mints } = createBackend();
    const wrapped = createDevAuthFetch({
      baseFetch,
      isLocalDev: true,
      getActor: () => 'admin@hushbox.test',
    });

    await wrapped('/api/admin/dashboard');

    expect(mints).toHaveLength(1);
    expect(calls[0]?.headers.get(CF_ACCESS_JWT_HEADER)).toBe(mints[0]);
  });

  it('reuses the in-memory token across requests for the same actor', async () => {
    const { baseFetch, calls, mints } = createBackend();
    const wrapped = createDevAuthFetch({
      baseFetch,
      isLocalDev: true,
      getActor: () => 'admin@hushbox.test',
    });

    await wrapped('/api/admin/dashboard');
    await wrapped('/api/admin/jobs');

    expect(mints).toHaveLength(1);
    expect(calls[1]?.headers.get(CF_ACCESS_JWT_HEADER)).toBe(mints[0]);
  });

  it('re-mints when the actor switches', async () => {
    const { baseFetch, calls, mints } = createBackend();
    let actor = 'admin@hushbox.test';
    const wrapped = createDevAuthFetch({
      baseFetch,
      isLocalDev: true,
      getActor: () => actor,
    });

    await wrapped('/api/admin/dashboard');
    actor = 'ops@hushbox.test';
    await wrapped('/api/admin/dashboard');

    expect(mints).toHaveLength(2);
    expect(mints[0]).toContain('admin@hushbox.test');
    expect(mints[1]).toContain('ops@hushbox.test');
    expect(calls[1]?.headers.get(CF_ACCESS_JWT_HEADER)).toBe(mints[1]);
  });

  it('re-mints once and retries on a 401', async () => {
    const backend = createBackend({ rejectToken: 'token-admin@hushbox.test-1' });
    const wrapped = createDevAuthFetch({
      baseFetch: backend.baseFetch,
      isLocalDev: true,
      getActor: () => 'admin@hushbox.test',
    });

    const res = await wrapped('/api/admin/dashboard');

    expect(res.status).toBe(200);
    expect(backend.mints).toHaveLength(2);
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[1]?.headers.get(CF_ACCESS_JWT_HEADER)).toBe(backend.mints[1]);
  });

  it('does not retry more than once on repeated 401s', async () => {
    const calls: FetchCall[] = [];
    let mintCount = 0;
    const baseFetch: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      if (url.startsWith(MINT_PATH)) {
        mintCount += 1;
        return Promise.resolve(Response.json({ token: 't' }, { status: 200 }));
      }
      calls.push({ url, headers: new Headers(init?.headers) });
      return Promise.resolve(new Response(null, { status: 401 }));
    };
    const wrapped = createDevAuthFetch({
      baseFetch,
      isLocalDev: true,
      getActor: () => 'admin@hushbox.test',
    });

    const res = await wrapped('/api/admin/dashboard');

    expect(res.status).toBe(401);
    expect(mintCount).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('throws when the mint route fails', async () => {
    const baseFetch: typeof fetch = () => Promise.resolve(new Response(null, { status: 404 }));
    const wrapped = createDevAuthFetch({
      baseFetch,
      isLocalDev: true,
      getActor: () => 'admin@hushbox.test',
    });

    await expect(wrapped('/api/admin/dashboard')).rejects.toThrow('dev admin token mint failed');
  });

  it('never touches localStorage or sessionStorage', async () => {
    const setItemLocal = vi.spyOn(Storage.prototype, 'setItem');
    const { baseFetch } = createBackend();
    const wrapped = createDevAuthFetch({
      baseFetch,
      isLocalDev: true,
      getActor: () => 'admin@hushbox.test',
    });

    await wrapped('/api/admin/dashboard');

    expect(setItemLocal).not.toHaveBeenCalled();
    setItemLocal.mockRestore();
  });
});
