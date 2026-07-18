import { describe, it, expect } from 'vitest';
import { checkSitemap } from './sitemap';
import { mockFetch } from './__test-fixtures-mocks__/mock-fetch';

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/xml' } });
}

const urlEntries = (locs: string[]): string =>
  locs.map((loc) => `<url><loc>${loc}</loc></url>`).join('');
const urlset = (locs: string[]): string => `<urlset>${urlEntries(locs)}</urlset>`;

const TARGET = 'https://example.com/target';

describe('checkSitemap', () => {
  it('finds the target url in a robots-declared sitemap', async () => {
    const fetchImpl = mockFetch(() => xml(urlset(['https://example.com/a', TARGET])));
    const result = await checkSitemap(
      'https://example.com',
      TARGET,
      ['https://example.com/sitemap.xml'],
      fetchImpl
    );
    expect(result).toEqual({ checked: true, found: true, urlListed: true });
  });

  it('falls back to /sitemap.xml when robots declares none', async () => {
    const fetchImpl = mockFetch(({ url }) =>
      url.pathname === '/sitemap.xml' ? xml(urlset(['https://example.com/other'])) : xml('', 404)
    );
    const result = await checkSitemap('https://example.com', TARGET, [], fetchImpl);
    expect(result).toEqual({ checked: true, found: true, urlListed: false });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.com/sitemap.xml');
  });

  it('follows a sitemap index one level to find the target', async () => {
    const fetchImpl = mockFetch(({ url }) => {
      if (url.pathname === '/sitemap.xml') {
        return xml(
          '<sitemapindex><sitemap><loc>https://example.com/child.xml</loc></sitemap></sitemapindex>'
        );
      }
      if (url.pathname === '/child.xml') {
        return xml(urlset([TARGET]));
      }
      return xml('', 404);
    });
    const result = await checkSitemap(
      'https://example.com',
      TARGET,
      ['https://example.com/sitemap.xml'],
      fetchImpl
    );
    expect(result.urlListed).toBe(true);
    expect(result.found).toBe(true);
  });

  it('reports found-but-unlisted when index children lack the target', async () => {
    const fetchImpl = mockFetch(({ url }) => {
      if (url.pathname === '/sitemap.xml') {
        return xml(
          '<sitemapindex><sitemap><loc>https://example.com/dead.xml</loc></sitemap><sitemap><loc>https://example.com/child.xml</loc></sitemap></sitemapindex>'
        );
      }
      if (url.pathname === '/child.xml') {
        return xml(urlset(['https://example.com/other']));
      }
      return xml('', 404);
    });
    const result = await checkSitemap(
      'https://example.com',
      TARGET,
      ['https://example.com/sitemap.xml'],
      fetchImpl
    );
    expect(result).toEqual({ checked: true, found: true, urlListed: false });
  });

  it('matches ignoring a trailing slash difference', async () => {
    const fetchImpl = mockFetch(() => xml(urlset(['https://example.com/target/'])));
    const result = await checkSitemap(
      'https://example.com',
      TARGET,
      ['https://example.com/sitemap.xml'],
      fetchImpl
    );
    expect(result.urlListed).toBe(true);
  });

  it('reports not-found when every candidate is missing', async () => {
    const fetchImpl = mockFetch(() => xml('', 404));
    const result = await checkSitemap('https://example.com', TARGET, [], fetchImpl);
    expect(result).toEqual({ checked: true, found: false, urlListed: false });
  });

  it('survives a network error on a candidate', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error('offline');
    });
    const result = await checkSitemap('https://example.com', TARGET, [], fetchImpl);
    expect(result.found).toBe(false);
  });
});
