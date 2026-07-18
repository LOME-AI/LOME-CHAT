import type { CrawlView } from '../engine';

/** The error envelope both crawl error statuses (400 / 502) share. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

export type CrawlOutcome =
  | { ok: true; view: CrawlView }
  | { ok: false; code: string; message: string };

export interface SitemapTarget {
  label: 'marketing' | 'web';
  origin: string;
  urls: string[];
  unreachable?: true;
}

export interface SitemapResponse {
  targets: SitemapTarget[];
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const { error } = value as { error: unknown };
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as ApiErrorBody['error']).code === 'string'
  );
}

function toOutcome(status: number, ok: boolean, body: unknown): CrawlOutcome {
  if (ok) {
    return { ok: true, view: body as CrawlView };
  }
  if (isErrorBody(body)) {
    return { ok: false, code: body.error.code, message: body.error.message };
  }
  return {
    ok: false,
    code: 'unexpected_response',
    message: `Server returned status ${String(status)}.`,
  };
}

/**
 * `GET /api/crawl` served from the same origin as this dashboard. Both the 400
 * (invalid_url) and 502 (analyze_failed) envelopes are surfaced verbatim; a
 * transport failure is reported under a synthetic `network_error` code so the
 * UI always has a code + message to render.
 */
export async function fetchCrawl(url: string, signal?: AbortSignal): Promise<CrawlOutcome> {
  let response: Response;
  try {
    response = await fetch(`/api/crawl?url=${encodeURIComponent(url)}`, signal ? { signal } : {});
  } catch (error) {
    return {
      ok: false,
      code: 'network_error',
      message:
        error instanceof Error ? error.message : 'Request failed before reaching the server.',
    };
  }
  const body: unknown = await response.json().catch(() => null);
  return toOutcome(response.status, response.ok, body);
}

/** `GET /api/sitemap` — populates the page picker and the page x audience matrix. */
export async function fetchSitemap(signal?: AbortSignal): Promise<SitemapResponse> {
  const response = await fetch('/api/sitemap', signal ? { signal } : {});
  if (!response.ok) {
    throw new Error(`sitemap request failed with status ${String(response.status)}`);
  }
  return (await response.json()) as SitemapResponse;
}
