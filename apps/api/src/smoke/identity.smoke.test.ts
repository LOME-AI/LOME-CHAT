import { describe, expect, expectTypeOf, it } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../lib/errors/index.js';
import { createSmokeHarness } from './harness.js';

describe('identity smoke', () => {
  it('exposes the identity routes on the typed client (schema survives into AppType)', () => {
    const { client } = createSmokeHarness();
    // Type-level pin: an annotation on the manifest factory that widens its
    // routes to bare `Hono<AppEnv>` erases the route schema from `AppType`;
    // this assertion turns that erasure into a typecheck failure here.
    expectTypeOf(client).toHaveProperty('auth');
    expectTypeOf(client.auth).toHaveProperty('verify-email');
    expectTypeOf(client.auth['verify-email']).toHaveProperty('$post');
  });

  it('mounts the identity slice (probe of POST /auth/verify-email is not 404)', async () => {
    const { client } = createSmokeHarness();
    const res = await client.auth['verify-email'].$post({
      json: { token: crypto.randomUUID() },
    });
    expect(res.status).not.toBe(404);
  });

  it('rejects an unknown verification token (POST /auth/verify-email answers 400 {code})', async () => {
    const { client } = createSmokeHarness();
    const res = await client.auth['verify-email'].$post({
      json: { token: crypto.randomUUID() },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(createErrorResponse(ERROR_CODES.INVALID_VERIFICATION_TOKEN));
  });

  it('guards the session-class route (anonymous POST /auth/2fa/setup answers 401 {code})', async () => {
    const { client } = createSmokeHarness();
    const res = await client.auth['2fa'].setup.$post();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
  });
});
