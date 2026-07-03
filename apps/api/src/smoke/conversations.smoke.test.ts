import { describe, expect, expectTypeOf, it } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../lib/errors/index.js';
import { createSmokeHarness } from './harness.js';

describe('conversations smoke', () => {
  it('exposes the conversations routes on the typed client (schema survives into AppType)', () => {
    const { client } = createSmokeHarness();
    // Type-level pin: an annotation on the manifest factory that widens its
    // routes to bare `Hono<AppEnv>` erases the route schema from `AppType`;
    // this assertion turns that erasure into a typecheck failure here.
    expectTypeOf(client).toHaveProperty('conversations');
    expectTypeOf(client.conversations).toHaveProperty('$get');
    expectTypeOf(client.conversations).toHaveProperty('$post');
  });

  it('mounts the conversations slice (anonymous probe of GET /conversations is not 404)', async () => {
    const { client } = createSmokeHarness();
    const res = await client.conversations.$get({ query: {} });
    expect(res.status).not.toBe(404);
  });

  it('guards the session-class route (anonymous GET /conversations answers 401 {code})', async () => {
    const { client } = createSmokeHarness();
    const res = await client.conversations.$get({ query: {} });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
  });
});
