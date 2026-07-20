import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { toBase64 } from '@hushbox/shared';
import { resolveLinkGuest } from './resolve-link-guest.js';
import type { AppEnv } from '../types.js';

const TEST_CONVERSATION_ID = 'conv-link-123';
const TEST_LINK_ID = 'link-456';
const TEST_LINK_PUBLIC_KEY = new Uint8Array([1, 2, 3, 4, 5]);
const TEST_MEMBER_ID = 'member-link-789';

/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createMockDbForLinkGuest(
  sharedLinkRow: { id: string; displayName?: string } | null,
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
                // First query: sharedLinks (findActiveSharedLink)
                const result = sharedLinkRow ? [sharedLinkRow] : [];
                return Promise.resolve(resolve(result));
              }
              // Second query: conversationMembers by linkId
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

function createTestApp(db: unknown): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('db', db as AppEnv['Variables']['db']);
    await next();
  });

  app.get('/:conversationId/test', async (c) => {
    const result = await resolveLinkGuest(c);
    if (!result) {
      return c.json({ resolved: false }, 200);
    }
    return c.json(
      {
        resolved: true,
        linkId: result.linkId,
        publicKeyLength: result.publicKey.length,
        member: result.member,
        displayName: result.displayName,
      },
      200
    );
  });

  return app;
}

describe('resolveLinkGuest', () => {
  it('returns null when x-link-public-key header is missing', async () => {
    const db = createMockDbForLinkGuest(null, null);
    const app = createTestApp(db);

    const res = await app.request(`/${TEST_CONVERSATION_ID}/test`);

    expect(res.status).toBe(200);
    const body = await res.json<{ resolved: boolean }>();
    expect(body.resolved).toBe(false);
  });

  it('returns null when shared link is not found', async () => {
    const db = createMockDbForLinkGuest(null, null);
    const app = createTestApp(db);

    const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
      headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ resolved: boolean }>();
    expect(body.resolved).toBe(false);
  });

  it('returns null when member row is not found for the shared link', async () => {
    const db = createMockDbForLinkGuest({ id: TEST_LINK_ID }, null);
    const app = createTestApp(db);

    const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
      headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ resolved: boolean }>();
    expect(body.resolved).toBe(false);
  });

  it('returns linkId, publicKey, and member when link guest resolves', async () => {
    const memberRow = { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 2 };
    const db = createMockDbForLinkGuest({ id: TEST_LINK_ID }, memberRow);
    const app = createTestApp(db);

    const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
      headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
    });

    expect(res.status).toBe(200);
    const body = await res.json<{
      resolved: boolean;
      linkId: string;
      publicKeyLength: number;
      member: { id: string; privilege: string; visibleFromEpoch: number };
    }>();
    expect(body.resolved).toBe(true);
    expect(body.linkId).toBe(TEST_LINK_ID);
    expect(body.publicKeyLength).toBe(TEST_LINK_PUBLIC_KEY.length);
    expect(body.member).toEqual(memberRow);
  });

  it('returns displayName in resolved result', async () => {
    const memberRow = { id: TEST_MEMBER_ID, privilege: 'write', visibleFromEpoch: 1 };
    const db = createMockDbForLinkGuest(
      { id: TEST_LINK_ID, displayName: 'Alice Guest' },
      memberRow
    );
    const app = createTestApp(db);

    const res = await app.request(`/${TEST_CONVERSATION_ID}/test`, {
      headers: { 'x-link-public-key': toBase64(TEST_LINK_PUBLIC_KEY) },
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ resolved: boolean; displayName: string }>();
    expect(body.resolved).toBe(true);
    expect(body.displayName).toBe('Alice Guest');
  });

  it('resolves link guest from linkPublicKey query param when header is missing', async () => {
    const memberRow = { id: TEST_MEMBER_ID, privilege: 'read', visibleFromEpoch: 1 };
    const db = createMockDbForLinkGuest({ id: TEST_LINK_ID }, memberRow);
    const app = createTestApp(db);

    const keyBase64 = toBase64(TEST_LINK_PUBLIC_KEY);
    const res = await app.request(
      `/${TEST_CONVERSATION_ID}/test?linkPublicKey=${encodeURIComponent(keyBase64)}`
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      resolved: boolean;
      linkId: string;
      publicKeyLength: number;
      member: { id: string; privilege: string; visibleFromEpoch: number };
    }>();
    expect(body.resolved).toBe(true);
    expect(body.linkId).toBe(TEST_LINK_ID);
    expect(body.publicKeyLength).toBe(TEST_LINK_PUBLIC_KEY.length);
    expect(body.member).toEqual(memberRow);
  });
});
