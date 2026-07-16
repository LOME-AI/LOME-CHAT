import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { PER_FLOW_MEDIA_CAP_BYTES } from '@hushbox/crypto';
import { MAX_REQUEST_BODY_BYTES, requestBodyLimit } from './body-limit.js';
import type { AppEnv } from '../lib/context/index.js';

/** Mirrors the app assembly: the guard runs ahead of the routes it protects. */
function buildApp(): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', requestBodyLimit())
    .post('/echo', async (c) => {
      const body = await c.req.text();
      return c.json({ length: body.length }, 200);
    })
    .notFound((c) => c.json({ code: 'NOT_FOUND' }, 404))
    .onError((_error, c) => c.json({ code: 'INTERNAL' }, 500));
}

function postBody(bytes: number): Request {
  const payload = 'a'.repeat(bytes);
  return new Request('http://local.test/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Content-Length': String(bytes) },
    body: payload,
  });
}

describe('MAX_REQUEST_BODY_BYTES', () => {
  it('sits above the per-flow media cap so no legitimate flow is rejected', () => {
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(PER_FLOW_MEDIA_CAP_BYTES);
  });

  it('stays well under the Cloudflare 100 MB zone request-body cap', () => {
    expect(MAX_REQUEST_BODY_BYTES).toBeLessThan(100 * 1024 * 1024);
  });
});

describe('requestBodyLimit', () => {
  it('rejects an over-limit body with 413 and the uniform {code} shape', async () => {
    const res = await buildApp().request(postBody(MAX_REQUEST_BODY_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('passes an at-limit body through to the handler', async () => {
    const res = await buildApp().request(postBody(MAX_REQUEST_BODY_BYTES));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ length: MAX_REQUEST_BODY_BYTES });
  });

  it('passes an ordinary small body through to the handler', async () => {
    const res = await buildApp().request(postBody(64));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ length: 64 });
  });

  it('passes a bodyless request through untouched', async () => {
    const res = await buildApp().request(new Request('http://local.test/echo', { method: 'POST' }));
    expect(res.status).toBe(200);
  });
});
