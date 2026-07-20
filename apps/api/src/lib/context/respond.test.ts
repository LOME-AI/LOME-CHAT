import { Hono } from 'hono';
import { hc } from 'hono/client';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { respondOk } from './respond.js';

describe('respondOk', () => {
  it('answers 200 with the JSON body unchanged', async () => {
    const app = new Hono().get('/thing', (c) => respondOk(c, { value: 7 }));
    const res = await app.request('/thing');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 7 });
  });

  it('preserves the body type so hc infers the 200 response', async () => {
    const app = new Hono().get('/thing', (c) => respondOk(c, { value: 7 as const }));
    // The client is constructed (a value use of `hc`, no request is made — the
    // base URL is never dereferenced) purely as a `typeof` anchor. The assertion
    // proves `hc<typeof app>` recovers the concrete 200 body type rather than the
    // `unknown` a bare-`Response` tail would leave.
    const _typeClient = hc<typeof app>('http://demo.invalid');
    type Body = Awaited<ReturnType<Awaited<ReturnType<typeof _typeClient.thing.$get>>['json']>>;
    expectTypeOf<Body>().toEqualTypeOf<{ value: 7 }>();
    const res = await app.request('/thing');
    expect(await res.json()).toEqual({ value: 7 });
  });
});
