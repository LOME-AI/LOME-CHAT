import type { SitemapInfo } from './types';

const LOC_PATTERN = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
/** Cap child sitemaps followed from an index — enough to answer "is it listed?". */
const MAX_CHILD_SITEMAPS = 5;

interface SitemapDocument {
  ok: boolean;
  isIndex: boolean;
  locs: string[];
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/$/, '');
}

async function fetchSitemap(url: string, fetchImpl: typeof fetch): Promise<SitemapDocument> {
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      return { ok: false, isIndex: false, locs: [] };
    }
    const body = await response.text();
    const locs = [...body.matchAll(LOC_PATTERN)]
      .map((match) => match[1])
      .filter((loc): loc is string => loc !== undefined);
    return { ok: true, isIndex: body.includes('<sitemapindex'), locs };
  } catch {
    return { ok: false, isIndex: false, locs: [] };
  }
}

function listsTarget(locs: string[], target: string): boolean {
  return locs.some((loc) => normalizeUrl(loc) === target);
}

/** Does this sitemap (following one level of index) list the target URL? */
async function documentListsTarget(
  document: SitemapDocument,
  target: string,
  fetchImpl: typeof fetch
): Promise<boolean> {
  if (!document.isIndex) {
    return listsTarget(document.locs, target);
  }
  for (const child of document.locs.slice(0, MAX_CHILD_SITEMAPS)) {
    const childDocument = await fetchSitemap(child, fetchImpl);
    if (childDocument.ok && listsTarget(childDocument.locs, target)) {
      return true;
    }
  }
  return false;
}

/**
 * Discover the sitemap(s) for an origin — robots `Sitemap:` directives first,
 * else the conventional `/sitemap.xml` and `/sitemap-index.xml` — and report
 * whether the target URL is listed, following one level of sitemap index.
 */
export async function checkSitemap(
  origin: string,
  targetUrl: string,
  declaredSitemaps: string[],
  fetchImpl: typeof fetch = fetch
): Promise<SitemapInfo> {
  const candidates =
    declaredSitemaps.length > 0
      ? declaredSitemaps
      : [
          new URL('/sitemap.xml', origin).toString(),
          new URL('/sitemap-index.xml', origin).toString(),
        ];
  const target = normalizeUrl(targetUrl);
  let found = false;

  for (const candidate of candidates) {
    const document = await fetchSitemap(candidate, fetchImpl);
    if (!document.ok) {
      continue;
    }
    found = true;
    if (await documentListsTarget(document, target, fetchImpl)) {
      return { checked: true, found: true, urlListed: true };
    }
  }

  return { checked: true, found, urlListed: false };
}
