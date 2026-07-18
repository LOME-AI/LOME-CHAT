import { describe, it, expect } from 'vitest';
import { detectCloaking, BROWSER_USER_AGENT } from './cloaking';
import { getPersona } from './personas';
import { mockFetch } from './__test-fixtures-mocks__/mock-fetch';

const BOT_UA = getPersona('gptbot').userAgent;

describe('detectCloaking', () => {
  it('reports no divergence when bot and browser get identical responses', async () => {
    const fetchImpl = mockFetch(() => new Response('<html>same</html>', { status: 200 }));
    const result = await detectCloaking('https://example.com/', fetchImpl);
    expect(result).toEqual({ checked: true, divergent: false, detail: null });
  });

  it('sends both the bot and browser user agents', async () => {
    const seen: string[] = [];
    const fetchImpl = mockFetch(({ userAgent }) => {
      seen.push(userAgent);
      return new Response('<html>same</html>', { status: 200 });
    });
    await detectCloaking('https://example.com/', fetchImpl);
    expect(seen).toContain(BOT_UA);
    expect(seen).toContain(BROWSER_USER_AGENT);
  });

  it('flags a divergent status code', async () => {
    const fetchImpl = mockFetch(({ userAgent }) =>
      userAgent === BOT_UA
        ? new Response('blocked', { status: 403 })
        : new Response('<html>ok</html>', { status: 200 })
    );
    const result = await detectCloaking('https://example.com/', fetchImpl);
    expect(result.divergent).toBe(true);
    expect(result.detail).toMatch(/status/i);
  });

  it('flags a divergent final redirect target', async () => {
    const fetchImpl = mockFetch(({ url, userAgent }) => {
      if (userAgent === BOT_UA && url.pathname === '/') {
        return new Response(null, { status: 302, headers: { location: '/bot-only' } });
      }
      return new Response('<html>ok</html>', { status: 200 });
    });
    const result = await detectCloaking('https://example.com/', fetchImpl);
    expect(result.divergent).toBe(true);
    expect(result.detail).toMatch(/redirect|url/i);
  });

  it('flags divergent HTML with matching status and url', async () => {
    const fetchImpl = mockFetch(({ userAgent }) =>
      userAgent === BOT_UA
        ? new Response('<html>bot content here</html>', { status: 200 })
        : new Response('<html>totally different browser markup</html>', { status: 200 })
    );
    const result = await detectCloaking('https://example.com/', fetchImpl);
    expect(result.divergent).toBe(true);
    expect(result.detail).toMatch(/html/i);
  });

  it('reports unchecked when a fetch fails', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error('offline');
    });
    const result = await detectCloaking('https://example.com/', fetchImpl);
    expect(result).toEqual({ checked: false, divergent: false, detail: null });
  });
});
