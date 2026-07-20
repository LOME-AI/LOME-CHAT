import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { toBase64 } from '@hushbox/shared';
import { websocketRoute } from './websocket.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

const TEST_USER_ID = 'user-ws-123';
const TEST_CONVERSATION_ID = 'conv-ws-456';
const TEST_LINK_ID = 'link-ws-789';
const TEST_LINK_PUBLIC_KEY = new Uint8Array([10, 20, 30, 40, 50]);
const TEST_LINK_DISPLAY_NAME = 'Guest 1';

interface MockStub {
  fetch: ReturnType<typeof vi.fn>;
}

interface MockNamespace {
  idFromName: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

interface MockMemberRow {
  id: string;
  privilege: string;
}

function createMockDONamespace(): {
  namespace: MockNamespace;
  stub: MockStub;
} {
  const id = { toString: () => 'mock-do-id' };
  const stub: MockStub = {
    fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
  };
  const namespace: MockNamespace = {
    idFromName: vi.fn().mockReturnValue(id),
    get: vi.fn().mockReturnValue(stub),
  };

  return { namespace, stub };
}

interface MockLinkGuestConfig {
  sharedLink: { id: string; displayName: string } | null;
  member: MockMemberRow | null;
}

/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder */
function createMockDb(members: MockMemberRow[], linkGuest?: MockLinkGuestConfig): unknown {
  let queryCount = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            then: (resolve: (v: unknown[]) => unknown) => {
              queryCount++;
              if (linkGuest) {
                // Link guest path: 1st query = sharedLinks, 2nd query = conversationMembers
                if (queryCount === 1) {
                  return Promise.resolve(
                    resolve(linkGuest.sharedLink ? [linkGuest.sharedLink] : [])
                  );
                }
                return Promise.resolve(resolve(linkGuest.member ? [linkGuest.member] : []));
              }
              // Auth user path: single member query
              return Promise.resolve(resolve(members));
            },
          }),
        }),
      }),
    }),
  };
}
/* eslint-enable unicorn/no-thenable */

function createMockSession(): SessionData {
  return {
    sessionId: `session-${TEST_USER_ID}`,
    userId: TEST_USER_ID,
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
    pending2FA: false,
    pending2FAExpiresAt: 0,
    createdAt: Date.now(),
  };
}

function createMockUser(): AppEnv['Variables']['user'] {
  return {
    id: TEST_USER_ID,
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
    publicKey: new Uint8Array(32),
  };
}

interface TestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  members?: MockMemberRow[];
  doNamespace?: MockNamespace | undefined;
  linkGuest?: MockLinkGuestConfig;
}

function createTestApp(options: TestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), members = [], doNamespace, linkGuest } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = {
      NODE_ENV: 'development',
      ...(doNamespace !== undefined && { CONVERSATION_ROOM: doNamespace }),
    } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createMockDb(members, linkGuest) as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', websocketRoute);
  return app;
}

describe('websocket route', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createTestApp({ user: null });

    const res = await app.request(`/${TEST_CONVERSATION_ID}`);

    expect(res.status).toBe(401);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 when user is not a member of conversation', async () => {
    const app = createTestApp({ members: [] });

    const res = await app.request(`/${TEST_CONVERSATION_ID}`);

    expect(res.status).toBe(404);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('returns 503 when CONVERSATION_ROOM binding is unavailable', async () => {
    const app = createTestApp({
      members: [{ id: 'member-1', privilege: 'owner' }],
      doNamespace: undefined,
    });

    const res = await app.request(`/${TEST_CONVERSATION_ID}`);

    expect(res.status).toBe(503);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('forwards to DO with userId query param when authorized', async () => {
    const { namespace, stub } = createMockDONamespace();
    const app = createTestApp({
      members: [{ id: 'member-1', privilege: 'owner' }],
      doNamespace: namespace,
    });

    await app.request(`/${TEST_CONVERSATION_ID}`);

    expect(namespace.idFromName).toHaveBeenCalledWith(TEST_CONVERSATION_ID);
    expect(stub.fetch).toHaveBeenCalledOnce();

    const fetchCall = stub.fetch.mock.calls[0] as [Request];
    const request = fetchCall[0];
    const url = new URL(request.url);
    expect(url.pathname).toBe('/websocket');
    expect(url.searchParams.get('userId')).toBe(TEST_USER_ID);
  });

  it('accesses conversationId through validated param', async () => {
    const { namespace } = createMockDONamespace();
    const app = createTestApp({
      members: [{ id: 'member-1', privilege: 'owner' }],
      doNamespace: namespace,
    });

    await app.request(`/${TEST_CONVERSATION_ID}`);

    // Verified by checking DO was called with the correct conversation ID
    expect(namespace.idFromName).toHaveBeenCalledWith(TEST_CONVERSATION_ID);
  });

  it('passes request headers to DO for WebSocket upgrade', async () => {
    const { namespace, stub } = createMockDONamespace();
    const app = createTestApp({
      members: [{ id: 'member-1', privilege: 'owner' }],
      doNamespace: namespace,
    });

    await app.request(`/${TEST_CONVERSATION_ID}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'test-key',
      },
    });

    const fetchCall = stub.fetch.mock.calls[0] as [Request];
    const request = fetchCall[0];
    expect(request.headers.get('Upgrade')).toBe('websocket');
    expect(request.headers.get('Connection')).toBe('Upgrade');
    expect(request.headers.get('Sec-WebSocket-Key')).toBe('test-key');
  });

  it('forwards link guest to DO with userId=linkId and guest=true query params', async () => {
    const { namespace, stub } = createMockDONamespace();
    const app = createTestApp({
      user: null,
      doNamespace: namespace,
      linkGuest: {
        sharedLink: { id: TEST_LINK_ID, displayName: TEST_LINK_DISPLAY_NAME },
        member: { id: 'member-guest-1', privilege: 'write' },
      },
    });

    const keyBase64 = toBase64(TEST_LINK_PUBLIC_KEY);
    const res = await app.request(
      `/${TEST_CONVERSATION_ID}?linkPublicKey=${encodeURIComponent(keyBase64)}`
    );

    expect(res.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalledOnce();

    const fetchCall = stub.fetch.mock.calls[0] as [Request];
    const request = fetchCall[0];
    const url = new URL(request.url);
    expect(url.searchParams.get('userId')).toBe(TEST_LINK_ID);
    expect(url.searchParams.get('guest')).toBe('true');
    expect(url.searchParams.get('name')).toBe(TEST_LINK_DISPLAY_NAME);
  });

  it('returns 401 when neither session user nor link guest can be resolved', async () => {
    const app = createTestApp({
      user: null,
      linkGuest: {
        sharedLink: null,
        member: null,
      },
    });

    const keyBase64 = toBase64(TEST_LINK_PUBLIC_KEY);
    const res = await app.request(
      `/${TEST_CONVERSATION_ID}?linkPublicKey=${encodeURIComponent(keyBase64)}`
    );

    expect(res.status).toBe(401);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('UNAUTHORIZED');
  });
});
