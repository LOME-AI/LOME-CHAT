import type { RedirectHop } from './types';

/** Hard cap on redirect hops followed manually, guarding against loops. */
export const MAX_REDIRECTS = 10;

/** Default per-request timeout. Overridable for tests that need determinism. */
export const DEFAULT_TIMEOUT_MS = 10_000;

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

export interface RawFetchResult {
  status: number;
  ok: boolean;
  finalUrl: string;
  redirectChain: RedirectHop[];
  headers: Headers;
  html: string;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function finalize(
  response: Response,
  finalUrl: string,
  redirectChain: RedirectHop[]
): Promise<RawFetchResult> {
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    finalUrl,
    redirectChain,
    headers: response.headers,
    html: await response.text(),
  };
}

/**
 * One HTTP GET as a no-JS bot would issue it: a stable accept header, the given
 * user-agent, manual redirect handling so the full chain is observable, and an
 * abort-signal timeout. Redirects are followed up to {@link MAX_REDIRECTS};
 * a loop simply stops at the cap and returns the last 3xx unfollowed.
 */
export async function fetchRaw(
  url: string,
  userAgent: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<RawFetchResult> {
  const redirectChain: RedirectHop[] = [];
  let currentUrl = url;

  const request = (target: string): Promise<Response> =>
    fetchImpl(target, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': userAgent, accept: HTML_ACCEPT },
      signal: AbortSignal.timeout(timeoutMs),
    });

  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    const response = await request(currentUrl);
    const location = response.headers.get('location');
    if (isRedirectStatus(response.status) && location !== null) {
      const resolved = new URL(location, currentUrl).toString();
      redirectChain.push({ from: currentUrl, to: resolved, status: response.status });
      currentUrl = resolved;
      continue;
    }
    return finalize(response, currentUrl, redirectChain);
  }

  // Redirect budget exhausted: return the last hop's response as-is (still 3xx).
  return finalize(await request(currentUrl), currentUrl, redirectChain);
}
