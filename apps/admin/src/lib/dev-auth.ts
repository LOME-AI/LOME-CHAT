/** The header Cloudflare Access injects at the edge in production. */
export const CF_ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';

/** Relative mint path — rides the same `/api` proxy as every other call. */
const DEV_TOKEN_MINT_PATH = '/api/dev/admin-token';

export interface DevAuthFetchDeps {
  readonly baseFetch: typeof fetch;
  readonly isLocalDev: boolean;
  readonly getActor: () => string;
}

interface CachedToken {
  readonly actor: string;
  readonly token: string;
}

/**
 * Fetch wrapper supplying admin authentication in local dev.
 *
 * In local dev it lazily mints a dev Access JWT for the CURRENT actor from
 * the dev-only mint route, caches it in memory only (never localStorage or
 * sessionStorage — a persisted admin credential outlives the tab), attaches
 * it as `Cf-Access-Jwt-Assertion`, and on a 401 re-mints once and retries
 * (dev tokens are short-lived). Switching actor changes the cache key, so the
 * next request mints for the new identity.
 *
 * In production it attaches nothing: Cloudflare Access injects the header at
 * the edge before the request reaches the Worker.
 */
export function createDevAuthFetch(deps: DevAuthFetchDeps): typeof fetch {
  let cached: CachedToken | null = null;

  async function mint(actor: string): Promise<string> {
    const res = await deps.baseFetch(`${DEV_TOKEN_MINT_PATH}?email=${encodeURIComponent(actor)}`);
    if (!res.ok) {
      throw new Error(`dev admin token mint failed: ${String(res.status)}`);
    }
    const body = (await res.json()) as { token: string };
    return body.token;
  }

  return async (input, init) => {
    if (!deps.isLocalDev) {
      return deps.baseFetch(input, init);
    }

    const actor = deps.getActor();
    if (cached?.actor !== actor) {
      cached = { actor, token: await mint(actor) };
    }

    const send = (token: string): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set(CF_ACCESS_JWT_HEADER, token);
      return deps.baseFetch(input, { ...init, headers });
    };

    let res = await send(cached.token);
    if (res.status === 401) {
      cached = { actor, token: await mint(actor) };
      res = await send(cached.token);
    }
    return res;
  };
}
