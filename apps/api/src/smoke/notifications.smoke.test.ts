import { describe, expect, expectTypeOf, it } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../lib/errors/index.js';
import { createSmokeHarness } from './harness.js';

describe('notifications smoke', () => {
  it('exposes the notifications routes on the typed client (schema survives into AppType)', () => {
    const { client } = createSmokeHarness();
    // Type-level pin: an annotation on the manifest factory that widens its
    // routes to bare `Hono<AppEnv>` erases the route schema from `AppType`;
    // this assertion turns that erasure into a typecheck failure here.
    expectTypeOf(client).toHaveProperty('notifications');
    expectTypeOf(client.notifications).toHaveProperty('device-tokens');
    expectTypeOf(client.notifications['device-tokens']).toHaveProperty('$post');
  });

  it('mounts the notifications slice (anonymous probe of POST /notifications/device-tokens is not 404)', async () => {
    const { client } = createSmokeHarness();
    const res = await client.notifications['device-tokens'].$post({
      json: { token: 'smoke-probe-token', platform: 'ios' },
    });
    expect(res.status).not.toBe(404);
  });

  it('guards the session-class route (anonymous POST /notifications/device-tokens answers 401 {code})', async () => {
    const { client } = createSmokeHarness();
    const res = await client.notifications['device-tokens'].$post({
      json: { token: 'smoke-probe-token', platform: 'ios' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
  });
});
