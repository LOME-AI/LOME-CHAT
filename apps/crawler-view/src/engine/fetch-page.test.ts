import { describe, it, expect } from 'vitest';
import { fetchRaw, MAX_REDIRECTS } from './fetch-page';
import { mockFetch } from './__test-fixtures-mocks__/mock-fetch';

function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
}

describe('fetchRaw', () => {
  it('returns the body, status, content-type and an empty redirect chain for a 200', async () => {
    const fetchImpl = mockFetch(() => htmlResponse('<html>hi</html>'));
    const result = await fetchRaw('https://example.com/', 'TestBot/1.0', fetchImpl);
    expect(result.status).toBe(200);
    expect(result.html).toBe('<html>hi</html>');
    expect(result.finalUrl).toBe('https://example.com/');
    expect(result.redirectChain).toEqual([]);
    expect(result.headers.get('content-type')).toBe('text/html');
  });

  it('sends the user-agent and an html accept header', async () => {
    const fetchImpl = mockFetch(() => htmlResponse('<html></html>'));
    await fetchRaw('https://example.com/', 'TestBot/1.0', fetchImpl);
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get('user-agent')).toBe('TestBot/1.0');
    expect(headers.get('accept')).toContain('text/html');
    expect(init?.redirect).toBe('manual');
  });

  it('follows and records a redirect chain, resolving relative locations', async () => {
    const fetchImpl = mockFetch(({ url }) =>
      url.pathname === '/old'
        ? new Response(null, { status: 301, headers: { location: '/new' } })
        : htmlResponse('<html>final</html>')
    );
    const result = await fetchRaw('https://example.com/old', 'TestBot/1.0', fetchImpl);
    expect(result.redirectChain).toEqual([
      { from: 'https://example.com/old', to: 'https://example.com/new', status: 301 },
    ]);
    expect(result.finalUrl).toBe('https://example.com/new');
    expect(result.status).toBe(200);
  });

  it('stops after MAX_REDIRECTS on a redirect loop and returns the last 3xx', async () => {
    const fetchImpl = mockFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } })
    );
    const result = await fetchRaw('https://example.com/loop', 'TestBot/1.0', fetchImpl);
    expect(result.redirectChain.length).toBe(MAX_REDIRECTS);
    expect(result.status).toBe(302);
  });

  it('treats a 3xx with no location header as the final response', async () => {
    const fetchImpl = mockFetch(() => new Response(null, { status: 302 }));
    const result = await fetchRaw('https://example.com/', 'TestBot/1.0', fetchImpl);
    expect(result.redirectChain).toEqual([]);
    expect(result.status).toBe(302);
  });
});
