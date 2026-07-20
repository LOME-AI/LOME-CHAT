import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { toBase64 } from '@hushbox/shared';
import { requireLinkGuest } from './require-link-guest.js';
import type { AppEnv } from '../types.js';

const TEST_CONVERSATION_ID = 'conv-lg-123';
const TEST_LINK_ID = 'link-lg-456';
const TEST_LINK_PUBLIC_KEY = new Uint8Array([5, 10, 15, 20, 25]);
const TEST_MEMBER_ID = 'member-lg-789';

/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createMockDbForLinkGuest(
  sharedLinkRow: { id: string } | null,
  memberRow: { id: string; privilege: string; visibleFromEpoch: number } | null
): unknown {
  let queryCount = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            then: (resolve: (v: unknown[]) => unknown) => {
              queryCount++;
              if (queryCount === 1) {
                const result = sharedLinkRow ? [sharedLinkRow] : [];
                return Promise.resolve(resolve(result));
              }
              const result = memberRow ? [memberRow] : [];
              return Promise.resolve(resolve(result));
            },
          }),
        }),
      }),
    }),
  };
}
/* eslint-enable unicorn/no-thenable */

function createTestApp(options: {
  sharedLinkRow?: { id: string } | null;
  memberRow?: { id: string; privilege: string; visibleFromEpoch: number } | null;
}): Hono<AppEnv> {
  const { sharedLinkRow = null, memberRow = null } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('user', null);
    c.set('session', null);
    c.set('sessionData', null);
    c.set('linkGuest', null);
    const db = createMockDbForLinkGuest(sharedLinkRow, memberRow);
    c.set('db', db as AppEnv['Variables']['db']);
    await next();
  });

  app.get('/:conversationId/test', requireLinkGuest(), (c) => {
    const members = c.get('members');
    const member = members.get(TEST_CONVERSATION_ID);
    const linkGuest = c.get('linkGuest');
    return c.json(
      {
        member,
        linkGuest: linkGuest ? { linkId: linkGuest.linkId } : null,
      },
      200
    );
  });

  return app;
}

describe('requireLinkGuest middleware', () => {
  it('returns 401 when x-link-public-key header is missing', async () => {
    const app = createTestApp({});

    const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

    expect(res.status).toBe(401);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 when shared link is not found', async () => {
    const app = createTestApp({ sharedLinkRow: null });

    const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
      headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
    });

    expect(res.status).toBe(404);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('LINK_NOT_FOUND');
  });

  it('returns 404 when member row is not found for the shared link', async () => {
    const app = createTestApp({
      sharedLinkRow: { id: TEST_LINK_ID },
      memberRow: null,
    });

    const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
      headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
    });

    expect(res.status).toBe(404);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('LINK_NOT_FOUND');
  });

  it('sets member and linkGuest on context when link guest resolves', async () => {
    const memberRow = { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 3 };
    const app = createTestApp({
      sharedLinkRow: { id: TEST_LINK_ID },
      memberRow,
    });

    const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
      headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
    });

    expect(res.status).toBe(200);
    const body = await res.json<{
      member: { id: string; privilege: string; visibleFromEpoch: number };
      linkGuest: { linkId: string } | null;
    }>();
    expect(body.member).toEqual(memberRow);
    expect(body.linkGuest).toEqual({ linkId: TEST_LINK_ID });
  });
});
