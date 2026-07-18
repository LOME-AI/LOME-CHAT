/**
 * Lists the page URLs a dev origin publishes in its sitemap, to populate the
 * dashboard's page picker. This is intentionally separate from the engine's
 * `checkSitemap` (which only tests membership) — the engine is frozen and does
 * not enumerate URLs. XML is scanned with the same `<loc>` regex the engine uses;
 * a full parser buys nothing for this well-formed, self-produced input.
 */

const LOC_PATTERN = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
const SITEMAP_DIRECTIVE = /^\s*sitemap:\s*(\S+)/i;
/** Cap child sitemaps followed from an index — one level, enough for a dev picker. */
const MAX_CHILD_SITEMAPS = 5;
const FETCH_TIMEOUT_MS = 8000;

export interface SitemapListing {
  urls: string[];
  /** False only when the origin itself never returned an HTTP response (server down). */
  reachable: boolean;
}

interface FetchOutcome {
  /** A response was received (any status), so the origin is reachable. */
  responded: boolean;
  ok: boolean;
  body: string;
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<FetchOutcome> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { responded: true, ok: false, body: '' };
    }
    return { responded: true, ok: true, body: await response.text() };
  } catch {
    return { responded: false, ok: false, body: '' };
  }
}

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(LOC_PATTERN)]
    .map((match) => match[1])
    .filter((loc): loc is string => loc !== undefined);
}

function extractDeclaredSitemaps(robotsTxt: string): string[] {
  return robotsTxt
    .split('\n')
    .map((line) => SITEMAP_DIRECTIVE.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
}

interface CollectResult {
  urls: string[];
  responded: boolean;
}

/** Follow one level of sitemap-index, collecting each child's page `<loc>`s. */
async function collectFromIndex(
  childSitemaps: string[],
  fetchImpl: typeof fetch
): Promise<CollectResult> {
  const urls: string[] = [];
  let responded = false;
  for (const child of childSitemaps.slice(0, MAX_CHILD_SITEMAPS)) {
    const document = await fetchText(child, fetchImpl);
    responded ||= document.responded;
    if (document.ok) {
      urls.push(...extractLocs(document.body));
    }
  }
  return { urls, responded };
}

/** Collect page URLs from one sitemap candidate (a urlset directly, or via its index). */
async function collectFromCandidate(
  candidate: string,
  fetchImpl: typeof fetch
): Promise<CollectResult> {
  const document = await fetchText(candidate, fetchImpl);
  if (!document.ok) {
    return { urls: [], responded: document.responded };
  }
  const locs = extractLocs(document.body);
  if (document.body.includes('<sitemapindex')) {
    const index = await collectFromIndex(locs, fetchImpl);
    return { urls: index.urls, responded: document.responded || index.responded };
  }
  return { urls: locs, responded: document.responded };
}

/**
 * Discover an origin's sitemap(s) — robots `Sitemap:` directives first, else the
 * conventional `/sitemap-index.xml` and `/sitemap.xml` — and collect every page URL,
 * following one level of sitemap index. Returns `reachable: false` only when the
 * origin never produced an HTTP response (e.g. the dev server is not running).
 */
export async function listSitemapUrls(
  origin: string,
  fetchImpl: typeof fetch = fetch
): Promise<SitemapListing> {
  let responded = false;
  const urls = new Set<string>();

  const robots = await fetchText(new URL('/robots.txt', origin).toString(), fetchImpl);
  responded ||= robots.responded;
  const declared = robots.ok ? extractDeclaredSitemaps(robots.body) : [];

  const candidates =
    declared.length > 0
      ? declared
      : [
          new URL('/sitemap-index.xml', origin).toString(),
          new URL('/sitemap.xml', origin).toString(),
        ];

  for (const candidate of candidates) {
    const result = await collectFromCandidate(candidate, fetchImpl);
    responded ||= result.responded;
    for (const loc of result.urls) {
      urls.add(loc);
    }
  }

  return { urls: [...urls], reachable: responded };
}
