import { describe, it, expect } from 'vitest';
import { handleCrawl, handleSitemap } from './handlers';
import type { CrawlView } from '@/engine';

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string | undefined;
  ended: boolean;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

function makeRes(): FakeRes {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string): void {
      this.body = chunk;
      this.ended = true;
    },
  };
}

function makeReq(
  url: string,
  options: { method?: string; origin?: string } = {}
): {
  url: string;
  method: string;
  headers: { origin?: string };
} {
  return {
    url,
    method: options.method ?? 'GET',
    headers: options.origin === undefined ? {} : { origin: options.origin },
  };
}

function parseBody(res: FakeRes): unknown {
  return JSON.parse(res.body ?? '');
}

const STUB_VIEW = { url: 'http://localhost:1/', http: { status: 200 } } as unknown as CrawlView;

describe('handleCrawl', () => {
  it('returns 200 with the CrawlView JSON for a valid url', async () => {
    const res = makeRes();
    let seen = '';
    await handleCrawl(makeReq('/?url=http%3A%2F%2Flocalhost%3A1%2F'), res, {
      analyzeImpl: (url) => {
        seen = url;
        return Promise.resolve(STUB_VIEW);
      },
    });

    expect(seen).toBe('http://localhost:1/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(parseBody(res)).toEqual(STUB_VIEW);
  });

  it('returns 400 invalid_url when the url param is missing', async () => {
    const res = makeRes();
    await handleCrawl(makeReq('/'), res, {
      analyzeImpl: () => Promise.resolve(STUB_VIEW),
    });

    expect(res.statusCode).toBe(400);
    expect(parseBody(res)).toMatchObject({ error: { code: 'invalid_url' } });
  });

  it('returns 400 invalid_url for a non-http protocol', async () => {
    const res = makeRes();
    let called = false;
    await handleCrawl(makeReq('/?url=ftp%3A%2F%2Fexample.com'), res, {
      analyzeImpl: () => {
        called = true;
        return Promise.resolve(STUB_VIEW);
      },
    });

    expect(called).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res)).toMatchObject({ error: { code: 'invalid_url' } });
  });

  it('returns 400 invalid_url for a relative (non-absolute) url', async () => {
    const res = makeRes();
    await handleCrawl(makeReq('/?url=%2Fjust%2Fa%2Fpath'), res, {
      analyzeImpl: () => Promise.resolve(STUB_VIEW),
    });

    expect(res.statusCode).toBe(400);
    expect(parseBody(res)).toMatchObject({ error: { code: 'invalid_url' } });
  });

  it('returns 502 analyze_failed without leaking a stack when the engine throws', async () => {
    const res = makeRes();
    await handleCrawl(makeReq('/?url=http%3A%2F%2Flocalhost%3A1%2F'), res, {
      analyzeImpl: () => Promise.reject(new Error('boom: secret stack detail at line 42')),
    });

    expect(res.statusCode).toBe(502);
    const body = parseBody(res) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('analyze_failed');
    expect(body.error.message).not.toContain('secret stack detail');
    expect(res.body).not.toContain('secret stack detail');
  });

  it('reflects a localhost Origin in Access-Control-Allow-Origin', async () => {
    const res = makeRes();
    await handleCrawl(
      makeReq('/?url=http%3A%2F%2Flocalhost%3A1%2F', { origin: 'http://localhost:4321' }),
      res,
      {
        analyzeImpl: () => Promise.resolve(STUB_VIEW),
      }
    );

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4321');
    expect(res.headers['vary']).toBe('Origin');
  });

  it('reflects a 127.0.0.1 Origin', async () => {
    const res = makeRes();
    await handleCrawl(
      makeReq('/?url=http%3A%2F%2Flocalhost%3A1%2F', { origin: 'http://127.0.0.1:5173' }),
      res,
      {
        analyzeImpl: () => Promise.resolve(STUB_VIEW),
      }
    );

    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
  });

  it('does not reflect a non-localhost Origin', async () => {
    const res = makeRes();
    await handleCrawl(
      makeReq('/?url=http%3A%2F%2Flocalhost%3A1%2F', { origin: 'https://evil.example.com' }),
      res,
      {
        analyzeImpl: () => Promise.resolve(STUB_VIEW),
      }
    );

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });

  it('answers an OPTIONS preflight with 204 and no body', async () => {
    const res = makeRes();
    let called = false;
    await handleCrawl(
      makeReq('/?url=http%3A%2F%2Flocalhost%3A1%2F', {
        method: 'OPTIONS',
        origin: 'http://localhost:4321',
      }),
      res,
      {
        analyzeImpl: () => {
          called = true;
          return Promise.resolve(STUB_VIEW);
        },
      }
    );

    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.body).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4321');
    expect(called).toBe(false);
  });
});

interface FetchRoute {
  ok: boolean;
  text: string;
}

function fakeResponse(ok: boolean, body: string): Response {
  return {
    ok,
    status: ok ? 200 : 404,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Build a fake `fetch` from a URL→response map; unknown urls 404, listed urls throw when `throwFor` matches. */
function fakeFetch(routes: Record<string, FetchRoute>, throwFor: string[] = []): typeof fetch {
  return ((input: string | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (throwFor.some((prefix) => url.startsWith(prefix))) {
      return Promise.reject(new TypeError('fetch failed'));
    }
    const route = routes[url];
    return Promise.resolve(
      route === undefined ? fakeResponse(false, '') : fakeResponse(route.ok, route.text)
    );
  }) as unknown as typeof fetch;
}

const MKT = 'http://localhost:4321';
const WEB = 'http://localhost:5173';

describe('handleSitemap', () => {
  it('parses a sitemap-index and its child into a page-url list for marketing', async () => {
    const routes: Record<string, FetchRoute> = {
      [`${MKT}/robots.txt`]: { ok: true, text: `Sitemap: ${MKT}/sitemap-index.xml\n` },
      [`${MKT}/sitemap-index.xml`]: {
        ok: true,
        text: `<?xml version="1.0"?><sitemapindex><sitemap><loc>${MKT}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
      },
      [`${MKT}/sitemap-0.xml`]: {
        ok: true,
        text: `<?xml version="1.0"?><urlset><url><loc>${MKT}/</loc></url><url><loc>${MKT}/blog/</loc></url></urlset>`,
      },
    };
    const res = makeRes();
    await handleSitemap(makeReq('/'), res, {
      fetchImpl: fakeFetch(routes),
      marketingOrigin: MKT,
      webOrigin: WEB,
    });

    expect(res.statusCode).toBe(200);
    const body = parseBody(res) as {
      targets: { label: string; origin: string; urls: string[]; unreachable?: boolean }[];
    };
    const marketing = body.targets.find((t) => t.label === 'marketing');
    expect(marketing?.origin).toBe(MKT);
    expect(marketing?.urls).toEqual([`${MKT}/`, `${MKT}/blog/`]);
    expect(marketing?.unreachable).toBeUndefined();
  });

  it('returns web reachable with empty urls when the server is up but has no sitemap', async () => {
    // Web dev server responds (404 for sitemap paths) → reachable, just no urls.
    const routes: Record<string, FetchRoute> = {
      [`${MKT}/robots.txt`]: { ok: true, text: '' },
      [`${MKT}/sitemap.xml`]: { ok: true, text: '<urlset></urlset>' },
    };
    const res = makeRes();
    await handleSitemap(makeReq('/'), res, {
      fetchImpl: fakeFetch(routes),
      marketingOrigin: MKT,
      webOrigin: WEB,
    });

    const body = parseBody(res) as {
      targets: { label: string; urls: string[]; unreachable?: boolean }[];
    };
    const web = body.targets.find((t) => t.label === 'web');
    expect(web?.urls).toEqual([]);
    expect(web?.unreachable).toBeUndefined();
  });

  it('flags an unreachable target with urls:[] without failing the other target', async () => {
    const routes: Record<string, FetchRoute> = {
      [`${WEB}/robots.txt`]: { ok: true, text: '' },
      [`${WEB}/sitemap.xml`]: { ok: true, text: '<urlset></urlset>' },
    };
    const res = makeRes();
    await handleSitemap(makeReq('/'), res, {
      fetchImpl: fakeFetch(routes, [MKT]),
      marketingOrigin: MKT,
      webOrigin: WEB,
    });

    const body = parseBody(res) as {
      targets: { label: string; urls: string[]; unreachable?: boolean }[];
    };
    const marketing = body.targets.find((t) => t.label === 'marketing');
    const web = body.targets.find((t) => t.label === 'web');
    expect(marketing?.unreachable).toBe(true);
    expect(marketing?.urls).toEqual([]);
    expect(web).toBeDefined();
  });

  it('degrades to empty targets when both origins are unset', async () => {
    const res = makeRes();
    await handleSitemap(makeReq('/'), res, {
      fetchImpl: fakeFetch({}),
      marketingOrigin: null,
      webOrigin: null,
    });

    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toEqual({ targets: [] });
  });

  it('answers an OPTIONS preflight with 204', async () => {
    const res = makeRes();
    await handleSitemap(makeReq('/', { method: 'OPTIONS', origin: 'http://localhost:4321' }), res, {
      fetchImpl: fakeFetch({}),
      marketingOrigin: MKT,
      webOrigin: WEB,
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4321');
  });
});
