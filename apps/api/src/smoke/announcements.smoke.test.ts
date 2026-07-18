import { describe, expect, expectTypeOf, it } from 'vitest';
import { BANNER_VARIANTS, ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../lib/errors/index.js';
import { createSmokeHarness } from './harness.js';

describe('announcements smoke', () => {
  it('exposes the announcements routes on the typed client (schema survives into AppType)', () => {
    const { client } = createSmokeHarness();
    // Type-level pin: an annotation on the manifest factory that widens its
    // routes to bare `Hono<AppEnv>` erases the route schema from `AppType`;
    // this assertion turns that erasure into a typecheck failure here.
    expectTypeOf(client).toHaveProperty('announcements');
    expectTypeOf(client.announcements).toHaveProperty('banner');
    expectTypeOf(client.announcements.banner).toHaveProperty('$get');
  });

  it('mounts the announcements slice (anonymous probe of GET /announcements/banner is not 404)', async () => {
    const { client } = createSmokeHarness();
    const res = await client.announcements.banner.$get();
    expect(res.status).not.toBe(404);
  });

  it('serves the public banner route anonymously (200 with the banner payload shape)', async () => {
    const { client } = createSmokeHarness();
    const res = await client.announcements.banner.$get();
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(typeof body).toBe('object');
    expect(body).not.toBeNull();
    // Wire-shape pin: severity lives per message, never at the top level.
    const payload = body as { hash: string | null; messages: unknown[] };
    expect(Object.keys(payload).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'hash',
      'messages',
    ]);
    expect(payload).not.toHaveProperty('variant');
    expect(Array.isArray(payload.messages)).toBe(true);
    for (const message of payload.messages) {
      expect(message).toHaveProperty('text');
      const { variant } = message as { variant: unknown };
      expect(BANNER_VARIANTS).toContain(variant);
    }
  });

  it('guards the session-class route (anonymous PUT /announcements/banner/dismissal answers 401 {code})', async () => {
    const { client } = createSmokeHarness();
    const res = await client.announcements.banner.dismissal.$put({
      json: { hash: 'smoke-probe-hash' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
  });
});
