import { describe, it, expect, vi } from 'vitest';
import { analyzeUrl } from './analyze';
import { getPersona } from './personas';
import { mockFetch } from './__test-fixtures-mocks__/mock-fetch';
import {
  HEALTHY_PAGE,
  SPA_SHELL,
  PAGE_WITH_MISSING_IMAGE,
  CLOAKED_TO_BOT,
  CLOAKED_TO_BROWSER,
  NOINDEX_TARGET_PAGE,
} from './__fixtures__/pages';

const GPTBOT_UA = getPersona('gptbot').userAgent;

function html(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });
}

const ROBOTS_ALLOW_ALL = 'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml';
const SITEMAP = '<urlset><url><loc>https://example.com/</loc></url></urlset>';

describe('analyzeUrl — scenario 1: healthy static page', () => {
  it('passes every audience', async () => {
    const fetchImpl = mockFetch(({ url }) => {
      if (url.pathname === '/robots.txt') return new Response(ROBOTS_ALLOW_ALL, { status: 200 });
      if (url.pathname === '/sitemap.xml') return new Response(SITEMAP, { status: 200 });
      if (url.pathname === '/og.png' || url.pathname === '/tw.png')
        return new Response(null, { status: 200 });
      if (url.pathname === '/') return html(HEALTHY_PAGE);
      return new Response('', { status: 404 });
    });
    const view = await analyzeUrl('https://example.com/', { fetchImpl });

    expect(view.http.status).toBe(200);
    expect(view.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(view.content.wordCount).toBeGreaterThan(40);
    expect(view.jsonLd[0]?.types).toEqual(['Article']);
    expect(view.openGraph.imageStatus).toEqual({ checked: true, reachable: true, status: 200 });
    expect(view.robots.fetched).toBe(true);
    expect(view.sitemap.urlListed).toBe(true);
    expect(view.verdict.ai.every((finding) => finding.level === 'pass')).toBe(true);
    expect(view.verdict.search.every((finding) => finding.level === 'pass')).toBe(true);
    expect(view.verdict.social.every((finding) => finding.level === 'pass')).toBe(true);
  });
});

describe('analyzeUrl — scenario 2: empty SPA shell', () => {
  it('fails ai and search with a near-empty page', async () => {
    const fetchImpl = mockFetch(({ url }) => {
      if (url.pathname === '/robots.txt') return new Response(ROBOTS_ALLOW_ALL, { status: 200 });
      if (url.pathname === '/') return html(SPA_SHELL);
      return new Response('', { status: 404 });
    });
    const view = await analyzeUrl('https://example.com/', { fetchImpl });

    expect(view.content.wordCount).toBe(0);
    expect(view.verdict.ai.some((finding) => finding.level === 'fail')).toBe(true);
    expect(view.verdict.search.some((finding) => finding.level === 'fail')).toBe(true);
    expect(view.verdict.ai.find((finding) => finding.level === 'fail')?.message).toMatch(/words/i);
  });
});

describe('analyzeUrl — scenario 3: robots-blocked path', () => {
  it('blocks only the disallowed persona and fails its audience', async () => {
    const robots = 'User-agent: GPTBot\nDisallow: /x\n\nUser-agent: *\nAllow: /';
    const fetchImpl = mockFetch(({ url }) => {
      if (url.pathname === '/robots.txt') return new Response(robots, { status: 200 });
      if (url.pathname === '/og.png') return new Response(null, { status: 200 });
      if (url.pathname === '/x') return html(HEALTHY_PAGE);
      return new Response('', { status: 404 });
    });
    const view = await analyzeUrl('https://example.com/x', { fetchImpl });

    const gptbot = view.robots.perPersona.find((entry) => entry.personaId === 'gptbot');
    const claudebot = view.robots.perPersona.find((entry) => entry.personaId === 'claudebot');
    expect(gptbot?.allowed).toBe(false);
    expect(claudebot?.allowed).toBe(true);
    const aiFail = view.verdict.ai.find((finding) => finding.level === 'fail');
    expect(aiFail?.bots).toContain('GPTBot');
    expect(aiFail?.bots).not.toContain('ClaudeBot');
  });
});

describe('analyzeUrl — scenario 4: unreachable og:image', () => {
  it('fails social on a 404 preview image', async () => {
    const fetchImpl = mockFetch(({ url }) => {
      if (url.pathname === '/robots.txt') return new Response(ROBOTS_ALLOW_ALL, { status: 200 });
      if (url.pathname === '/missing.png') return new Response('', { status: 404 });
      if (url.pathname === '/broken-image') return html(PAGE_WITH_MISSING_IMAGE);
      return new Response('', { status: 404 });
    });
    const view = await analyzeUrl('https://example.com/broken-image', { fetchImpl });

    expect(view.openGraph.imageStatus).toEqual({ checked: true, reachable: false, status: 404 });
    expect(
      view.verdict.social.some(
        (finding) => finding.level === 'fail' && /unreachable/i.test(finding.message)
      )
    ).toBe(true);
  });
});

describe('analyzeUrl — scenario 5: cloaked response', () => {
  it('detects divergent bot vs browser HTML and warns all audiences', async () => {
    const fetchImpl = mockFetch(({ url, userAgent }) => {
      if (url.pathname === '/robots.txt') return new Response(ROBOTS_ALLOW_ALL, { status: 200 });
      if (url.pathname === '/') {
        return html(userAgent === GPTBOT_UA ? CLOAKED_TO_BOT : CLOAKED_TO_BROWSER);
      }
      return new Response('', { status: 404 });
    });
    const view = await analyzeUrl('https://example.com/', { fetchImpl });

    expect(view.cloaking.divergent).toBe(true);
    expect(view.verdict.ai.some((finding) => /cloaking/i.test(finding.message))).toBe(true);
    expect(view.verdict.search.some((finding) => /cloaking/i.test(finding.message))).toBe(true);
    expect(view.verdict.social.some((finding) => /cloaking/i.test(finding.message))).toBe(true);
  });
});

describe('analyzeUrl — scenario 6: redirect chain and X-Robots-Tag noindex', () => {
  it('captures the chain and honors the noindex header', async () => {
    const fetchImpl = mockFetch(({ url }) => {
      if (url.pathname === '/robots.txt') return new Response(ROBOTS_ALLOW_ALL, { status: 200 });
      if (url.pathname === '/old') {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://example.com/new' },
        });
      }
      if (url.pathname === '/new') return html(NOINDEX_TARGET_PAGE, { 'x-robots-tag': 'noindex' });
      return new Response('', { status: 404 });
    });
    const view = await analyzeUrl('https://example.com/old', { fetchImpl });

    expect(view.http.redirectChain).toEqual([
      { from: 'https://example.com/old', to: 'https://example.com/new', status: 301 },
    ]);
    expect(view.http.finalUrl).toBe('https://example.com/new');
    expect(view.http.xRobotsTag).toBe('noindex');
    expect(
      view.verdict.search.some(
        (finding) => finding.level === 'fail' && /noindex/i.test(finding.message)
      )
    ).toBe(true);
  });
});

describe('analyzeUrl — input validation', () => {
  it('rejects a malformed url', async () => {
    await expect(analyzeUrl('not a url')).rejects.toThrow();
  });

  it('rejects a non-http(s) protocol', async () => {
    await expect(analyzeUrl('ftp://example.com/file')).rejects.toThrow(/http/i);
  });

  it('defaults to global fetch when no impl is injected', () => {
    const originalFetch = globalThis.fetch;
    const spy = vi.fn(() => Promise.resolve(html('<html><body></body></html>')));
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      void analyzeUrl('https://example.com/');
      expect(spy).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
