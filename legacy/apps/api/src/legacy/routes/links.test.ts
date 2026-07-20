import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSubmitRotation = vi.hoisted(() => vi.fn());

const mockBroadcastFireAndForget = vi.hoisted(() => vi.fn());
vi.mock('../lib/broadcast.js', () => ({
  broadcastFireAndForget: (...args: unknown[]) => mockBroadcastFireAndForget(...args),
}));

vi.mock('../services/keys/keys.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/keys/keys.js')>();
  return {
    ...original,
    submitRotation: (...args: unknown[]) => mockSubmitRotation(...args),
  };
});

import { Hono } from 'hono';
import { StaleEpochError, WrapSetMismatchError } from '../services/keys/keys.js';
import { linksRoute } from './links.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

const TEST_USER_ID = 'user-link-123';
const TEST_CONVERSATION_ID = 'conv-link-456';
const TEST_LINK_PUBLIC_KEY_BASE64 =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TEST_MEMBER_WRAP_BASE64 = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

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

/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createQueryChainFactory(
  selectResults: unknown[][],
  indexRef: { value: number }
): () => Record<string, unknown> {
  const createQueryChain = (): Record<string, unknown> => ({
    from: () => createQueryChain(),
    where: () => createQueryChain(),
    leftJoin: () => createQueryChain(),
    innerJoin: () => createQueryChain(),
    orderBy: () => createQueryChain(),
    for: () => createQueryChain(),
    limit: () => ({
      then: (resolve: (v: unknown[]) => unknown) => {
        const result = selectResults[indexRef.value++] ?? [];
        return Promise.resolve(resolve(result));
      },
    }),
    then: (resolve: (v: unknown[]) => unknown) => {
      const result = selectResults[indexRef.value++] ?? [];
      return Promise.resolve(resolve(result));
    },
  });
  return createQueryChain;
}
/* eslint-enable unicorn/no-thenable */

interface ListMockLink {
  id: string;
  conversationId: string;
  linkPublicKey: Uint8Array;
  privilege: string;
  displayName: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

interface ListMockDbConfig {
  requesterMember?: { id: string; privilege: string } | null;
  links?: ListMockLink[];
}

/**
 * Creates a mock Drizzle DB for the list-links route (now with middleware query first):
 * 0. Middleware: requester membership lookup (select→from→where→limit→then)
 * 1. listLinks call: select().from().where().orderBy() → Promise<links[]>
 */
function createListLinksMockDb(config: ListMockDbConfig): unknown {
  const indexRef = { value: 0 };
  const selectResults: unknown[][] = [
    config.requesterMember
      ? [
          {
            conversationId: TEST_CONVERSATION_ID,
            id: config.requesterMember.id,
            privilege: config.requesterMember.privilege,
            visibleFromEpoch: 1,
          },
        ]
      : [],
    config.links ?? [],
  ];
  const createQueryChain = createQueryChainFactory(selectResults, indexRef);

  return {
    select: () => createQueryChain(),
  };
}

interface ListTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: ListMockDbConfig;
}

function createListTestApp(options: ListTestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), dbConfig = {} } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createListLinksMockDb(dbConfig) as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', linksRoute);
  return app;
}

interface CreateMockDbConfig {
  requesterMember?: { id: string; privilege: string } | null;
  currentEpoch?: { id: string; epochNumber: number } | null;
  memberCount?: number;
  /** If set, transaction epoch verification returns this instead — simulates rotation race */
  txCurrentEpoch?: { id: string; epochNumber: number };
  /** When true, mock DB expects rotation path (2 inserts instead of 3) */
  hasRotation?: boolean;
}

/**
 * Creates a mock Drizzle DB for the create-link route (now with middleware query first):
 * 0. Middleware: requester membership lookup (select→from→where→limit→then)
 * 1. Current epoch lookup (select with orderBy+limit+then)
 * 2. createLink: db.transaction
 */
function createCreateLinkMockDb(config: CreateMockDbConfig): unknown {
  const indexRef = { value: 0 };
  const selectResults: unknown[][] = [
    config.requesterMember
      ? [
          {
            conversationId: TEST_CONVERSATION_ID,
            id: config.requesterMember.id,
            privilege: config.requesterMember.privilege,
            visibleFromEpoch: 1,
          },
        ]
      : [],
    config.currentEpoch ? [{ ...config.currentEpoch, memberCount: config.memberCount ?? 1 }] : [],
  ];
  const createQueryChain = createQueryChainFactory(selectResults, indexRef);

  // Transaction-scoped selects: epoch lock (FOR UPDATE) + epoch ID lookup
  const txEpoch = config.txCurrentEpoch ?? config.currentEpoch;
  const txIndexRef = { value: 0 };
  const txSelectResults: unknown[][] = [
    txEpoch ? [{ currentEpoch: txEpoch.epochNumber }] : [],
    txEpoch ? [{ id: txEpoch.id }] : [],
    [{ count: 0 }],
  ];
  const createTxQueryChain = createQueryChainFactory(txSelectResults, txIndexRef);

  let insertCallIndex = 0;
  const txMock = {
    select: () => createTxQueryChain(),
    insert: () => {
      const callIndex = insertCallIndex++;
      if (callIndex === 0) {
        // 1. sharedLinks upsert: insert().values().onConflictDoUpdate().returning()
        return {
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: () => Promise.resolve([{ id: 'new-link-id' }]),
            }),
          }),
        };
      }
      if (callIndex === 1) {
        // 2. conversationMembers upsert: insert().values().onConflictDoUpdate().returning()
        return {
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: () => Promise.resolve([{ id: 'new-member-id' }]),
            }),
          }),
        };
      }
      // 3. epochMembers upsert (full-history only): insert().values().onConflictDoUpdate() (no returning)
      return {
        values: () => ({
          onConflictDoUpdate: () => Promise.resolve(),
        }),
      };
    },
  };

  return {
    select: () => createQueryChain(),
    transaction: async (function_: (tx: unknown) => Promise<unknown>) => function_(txMock),
  };
}

interface CreateTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: CreateMockDbConfig;
}

function createCreateTestApp(options: CreateTestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), dbConfig = {} } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createCreateLinkMockDb(dbConfig) as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', linksRoute);
  return app;
}

function createLinkBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    linkPublicKey: TEST_LINK_PUBLIC_KEY_BASE64,
    memberWrap: TEST_MEMBER_WRAP_BASE64,
    privilege: 'read',
    giveFullHistory: true,
    ...overrides,
  };
}

// ── Revoke link mock infrastructure ──

interface RevokeMockDbConfig {
  requesterMember?: { id: string; privilege: string } | null;
  revokeResult?: { revoked: boolean; memberId: string | null };
}

/**
 * Creates a mock Drizzle DB for the revoke-link route (now with middleware query first):
 * 0. Middleware: requester membership lookup (select→from→where→limit→then)
 * 1. revokeLink: atomic UPDATE...RETURNING inside transaction
 */
function createRevokeLinkMockDb(config: RevokeMockDbConfig): unknown {
  const indexRef = { value: 0 };
  const revokeResult = config.revokeResult ?? { revoked: false, memberId: null };

  const selectResults: unknown[][] = [
    // Query 0: middleware's membership lookup
    config.requesterMember
      ? [
          {
            conversationId: TEST_CONVERSATION_ID,
            id: config.requesterMember.id,
            privilege: config.requesterMember.privilege,
            visibleFromEpoch: 1,
          },
        ]
      : [],
  ];
  const createQueryChain = createQueryChainFactory(selectResults, indexRef);

  let txUpdateCallIndex = 0;
  const txMock = {
    update: () => {
      const callIndex = txUpdateCallIndex++;
      if (callIndex === 0) {
        // First update: atomic UPDATE...RETURNING for revokeLink claim
        return {
          set: () => ({
            where: () => ({
              returning: () =>
                Promise.resolve(
                  revokeResult.revoked
                    ? [{ id: 'link-to-revoke', conversationId: TEST_CONVERSATION_ID }]
                    : []
                ),
            }),
          }),
        };
      }
      // Second update: leftAt on conversationMembers (no returning)
      return {
        set: () => ({
          where: () => Promise.resolve(),
        }),
      };
    },
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(revokeResult.memberId ? [{ id: revokeResult.memberId }] : []),
      }),
    }),
  };

  return {
    select: () => createQueryChain(),
    transaction: async (function_: (tx: unknown) => Promise<unknown>) => function_(txMock),
  };
}

interface RevokeTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: RevokeMockDbConfig;
}

function createRevokeTestApp(options: RevokeTestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), dbConfig = {} } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createRevokeLinkMockDb(dbConfig) as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', linksRoute);
  return app;
}

function createTestRotation(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    expectedEpoch: 1,
    epochPublicKey: 'dGVzdC1lcG9jaC1wdWJsaWMta2V5',
    confirmationHash: 'dGVzdC1jb25maXJtYXRpb24taGFzaA',
    chainLink: 'dGVzdC1jaGFpbi1saW5r',
    memberWraps: [
      {
        memberPublicKey: 'dGVzdC1tZW1iZXItcHVibGlj',
        wrap: 'dGVzdC13cmFw',
      },
    ],
    encryptedTitle: 'dGVzdC1lbmNyeXB0ZWQtdGl0bGU',
    ...overrides,
  };
}

function createRevokeBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    linkId: 'link-to-revoke',
    rotation: createTestRotation(),
    ...overrides,
  };
}

describe('links route', () => {
  describe('GET /:conversationId', () => {
    it('returns 401 when not authenticated', async () => {
      const app = createListTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when not a member', async () => {
      const app = createListTestApp({
        dbConfig: { requesterMember: null },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('allows write-privilege members to list links', async () => {
      const app = createListTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'write' },
          links: [],
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{ links: unknown[] }>();
      expect(body.links).toHaveLength(0);
    });

    it('includes displayName in link response', async () => {
      const testPublicKey = new Uint8Array(32).fill(55);
      const app = createListTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'read' },
          links: [
            {
              id: 'link-display',
              conversationId: TEST_CONVERSATION_ID,
              linkPublicKey: testPublicKey,
              privilege: 'read',
              displayName: 'Team Invite',
              createdAt: new Date('2025-02-01T12:00:00Z'),
              revokedAt: null,
            },
          ],
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        links: {
          id: string;
          displayName: string | null;
        }[];
      }>();
      expect(body.links).toHaveLength(1);
      expect(body.links[0]?.displayName).toBe('Team Invite');
    });

    it('returns list of active links with base64-encoded publicKey', async () => {
      const testPublicKey = new Uint8Array(32).fill(99);
      const app = createListTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          links: [
            {
              id: 'link-1',
              conversationId: TEST_CONVERSATION_ID,
              linkPublicKey: testPublicKey,
              privilege: 'read',
              displayName: null,
              createdAt: new Date('2025-01-15T10:00:00Z'),
              revokedAt: null,
            },
          ],
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        links: {
          id: string;
          linkPublicKey: string;
          privilege: string;
          createdAt: string;
        }[];
      }>();
      expect(body.links).toHaveLength(1);
      const link = body.links[0];
      expect(link).toBeDefined();
      expect(link?.id).toBe('link-1');
      // linkPublicKey should be a base64 string, not raw bytes
      expect(typeof link?.linkPublicKey).toBe('string');
      expect(link?.privilege).toBe('read');
      expect(link?.createdAt).toBe('2025-01-15T10:00:00.000Z');
    });
  });

  describe('POST /:conversationId', () => {
    it('returns 401 when not authenticated', async () => {
      const app = createCreateTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createLinkBody()),
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when not a member', async () => {
      const app = createCreateTestApp({
        dbConfig: { requesterMember: null },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createLinkBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 403 when privilege is below admin', async () => {
      const app = createCreateTestApp({
        dbConfig: { requesterMember: { id: 'member-1', privilege: 'write' } },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createLinkBody()),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('returns 404 when current epoch not found', async () => {
      const app = createCreateTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          currentEpoch: null,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createLinkBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('EPOCH_NOT_FOUND');
    });

    it('returns 400 when conversation has reached member limit', async () => {
      const app = createCreateTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          currentEpoch: { id: 'epoch-1', epochNumber: 1 },
          memberCount: 100,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createLinkBody()),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('MEMBER_LIMIT_REACHED');
    });

    it('creates link and returns 201 with linkId and memberId', async () => {
      const app = createCreateTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          currentEpoch: { id: 'epoch-1', epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createLinkBody()),
      });

      expect(res.status).toBe(201);
      const body = await res.json<{ linkId: string; memberId: string }>();
      expect(body.linkId).toBeDefined();
      expect(body.memberId).toBeDefined();
    });

    it('accepts optional displayName in POST body', async () => {
      const app = createCreateTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          currentEpoch: { id: 'epoch-1', epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createLinkBody({ displayName: 'Guest Reader' })),
      });

      expect(res.status).toBe(201);
    });

    it('returns 400 when displayName is not a string', async () => {
      const app = createCreateTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          currentEpoch: { id: 'epoch-1', epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createLinkBody({ displayName: 123 })),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when displayName is empty string', async () => {
      const app = createCreateTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          currentEpoch: { id: 'epoch-1', epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createLinkBody({ displayName: '' })),
      });

      expect(res.status).toBe(400);
    });

    it('returns 409 when epoch has rotated between query and transaction', async () => {
      const app = createCreateTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          currentEpoch: { id: 'epoch-1', epochNumber: 1 },
          txCurrentEpoch: { id: 'epoch-2', epochNumber: 2 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createLinkBody()),
      });

      expect(res.status).toBe(409);
      const body = await res.json<{
        code: string;
        details: { currentEpoch: number };
      }>();
      expect(body.code).toBe('STALE_EPOCH');
      expect(body.details.currentEpoch).toBe(2);
    });

    it('creates no-history link with rotation and computes visibleFromEpoch', async () => {
      const app = createCreateTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          currentEpoch: { id: 'epoch-1', epochNumber: 1 },
          hasRotation: true,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          linkPublicKey: TEST_LINK_PUBLIC_KEY_BASE64,
          memberWrap: TEST_MEMBER_WRAP_BASE64,
          privilege: 'read',
          giveFullHistory: false,
          rotation: createTestRotation({ expectedEpoch: 1 }),
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json<{ linkId: string; memberId: string }>();
      expect(body.linkId).toBeDefined();
      expect(body.memberId).toBeDefined();
    });

    it('returns 400 when giveFullHistory is false and rotation is missing', async () => {
      const app = createCreateTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          currentEpoch: { id: 'epoch-1', epochNumber: 1 },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          linkPublicKey: TEST_LINK_PUBLIC_KEY_BASE64,
          memberWrap: TEST_MEMBER_WRAP_BASE64,
          privilege: 'read',
          giveFullHistory: false,
        }),
      });

      expect(res.status).toBe(400);
    });

    it('broadcasts rotation:complete when creating no-history link with rotation', async () => {
      mockBroadcastFireAndForget.mockClear();

      const app = createCreateTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          currentEpoch: { id: 'epoch-1', epochNumber: 1 },
          hasRotation: true,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          linkPublicKey: TEST_LINK_PUBLIC_KEY_BASE64,
          memberWrap: TEST_MEMBER_WRAP_BASE64,
          privilege: 'read',
          giveFullHistory: false,
          rotation: createTestRotation({ expectedEpoch: 1 }),
        }),
      });

      expect(res.status).toBe(201);
      expect(mockBroadcastFireAndForget).toHaveBeenCalledWith(
        expect.anything(),
        TEST_CONVERSATION_ID,
        expect.objectContaining({
          type: 'rotation:complete',
          conversationId: TEST_CONVERSATION_ID,
          newEpochNumber: 2,
        })
      );
    });
  });

  describe('POST /:conversationId/revoke', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('returns 401 when not authenticated', async () => {
      const app = createRevokeTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRevokeBody()),
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when not a member', async () => {
      const app = createRevokeTestApp({
        dbConfig: { requesterMember: null },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRevokeBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 403 when privilege is below admin', async () => {
      const app = createRevokeTestApp({
        dbConfig: { requesterMember: { id: 'member-1', privilege: 'write' } },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRevokeBody()),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('revokes link and returns revoked true', async () => {
      const app = createRevokeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          revokeResult: { revoked: true, memberId: 'member-link-1' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRevokeBody()),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ revoked: boolean }>();
      expect(body.revoked).toBe(true);
    });

    it('returns 404 when link not found or already revoked', async () => {
      const app = createRevokeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          revokeResult: { revoked: false, memberId: null },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRevokeBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('LINK_NOT_FOUND');
    });

    it('passes decoded rotation params to revokeLink service', async () => {
      const app = createRevokeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          revokeResult: { revoked: true, memberId: 'member-link-1' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRevokeBody()),
      });

      expect(res.status).toBe(200);
      expect(mockSubmitRotation).toHaveBeenCalledTimes(1);
    });

    it('returns 409 when submitRotation throws StaleEpochError', async () => {
      const app = createRevokeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          revokeResult: { revoked: true, memberId: 'member-link-1' },
        },
      });

      mockSubmitRotation.mockRejectedValueOnce(new StaleEpochError(2));

      const res = await app.request(`/${TEST_CONVERSATION_ID}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRevokeBody()),
      });

      expect(res.status).toBe(409);
      const body = await res.json<{
        code: string;
        details: { currentEpoch: number };
      }>();
      expect(body.code).toBe('STALE_EPOCH');
      expect(body.details.currentEpoch).toBe(2);
    });

    it('returns 400 when submitRotation throws WrapSetMismatchError on revoke', async () => {
      const app = createRevokeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          revokeResult: { revoked: true, memberId: 'member-link-1' },
        },
      });

      mockSubmitRotation.mockRejectedValueOnce(new WrapSetMismatchError(2, 3));

      const res = await app.request(`/${TEST_CONVERSATION_ID}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRevokeBody()),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('WRAP_SET_MISMATCH');
    });

    it('broadcasts rotation:complete when revoking with rotation', async () => {
      mockBroadcastFireAndForget.mockClear();

      const app = createRevokeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          revokeResult: { revoked: true, memberId: 'member-link-1' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRevokeBody()),
      });

      expect(res.status).toBe(200);
      expect(mockBroadcastFireAndForget).toHaveBeenCalledWith(
        expect.anything(),
        TEST_CONVERSATION_ID,
        expect.objectContaining({
          type: 'rotation:complete',
          conversationId: TEST_CONVERSATION_ID,
          newEpochNumber: 2,
        })
      );
    });

    it('returns 400 when rotation is missing', async () => {
      const app = createRevokeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          revokeResult: { revoked: true, memberId: 'member-link-1' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId: 'link-to-revoke' }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /:conversationId/:linkId/privilege', () => {
    interface PrivilegeMockDbConfig {
      requesterMember?: { id: string; privilege: string } | null;
      changeResult?: { changed: boolean; memberId: string | null };
    }

    function createPrivilegeMockDb(config: PrivilegeMockDbConfig): unknown {
      const indexRef = { value: 0 };
      const changeResult = config.changeResult ?? { changed: false, memberId: null };

      const selectResults: unknown[][] = [
        // Query 0: middleware's membership lookup
        config.requesterMember
          ? [
              {
                conversationId: TEST_CONVERSATION_ID,
                id: config.requesterMember.id,
                privilege: config.requesterMember.privilege,
                visibleFromEpoch: 1,
              },
            ]
          : [],
        // Query 1: changeLinkPrivilege's link existence check
        changeResult.changed ? [{ id: 'link-priv' }] : [],
      ];
      const createQueryChain = createQueryChainFactory(selectResults, indexRef);

      return {
        select: () => createQueryChain(),
        update: () => ({
          set: () => ({
            where: () => ({
              returning: () =>
                Promise.resolve(changeResult.memberId ? [{ id: changeResult.memberId }] : []),
            }),
          }),
        }),
      };
    }

    interface PrivilegeTestAppOptions {
      user?: AppEnv['Variables']['user'] | null;
      dbConfig?: PrivilegeMockDbConfig;
    }

    function createPrivilegeTestApp(options: PrivilegeTestAppOptions = {}): Hono<AppEnv> {
      const { user = createMockUser(), dbConfig = {} } = options;
      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
        c.set('user', user);
        c.set('session', user ? createMockSession() : null);
        c.set('sessionData', user ? createMockSession() : null);
        c.set('db', createPrivilegeMockDb(dbConfig) as AppEnv['Variables']['db']);
        await next();
      });

      app.route('/', linksRoute);
      return app;
    }

    const TEST_LINK_ID_PRIV = 'link-priv-update';

    it('returns 200 and changes privilege', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          changeResult: { changed: true, memberId: 'member-link-1' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/${TEST_LINK_ID_PRIV}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privilege: 'write' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ changed: boolean }>();
      expect(body.changed).toBe(true);
    });

    it('returns 401 when not authenticated', async () => {
      const app = createPrivilegeTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/${TEST_LINK_ID_PRIV}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privilege: 'write' }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 403 when privilege is below admin', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: { requesterMember: { id: 'member-1', privilege: 'write' } },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/${TEST_LINK_ID_PRIV}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privilege: 'write' }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 404 when link not found or already revoked', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          changeResult: { changed: false, memberId: null },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/${TEST_LINK_ID_PRIV}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privilege: 'read' }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 400 when privilege is invalid', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/${TEST_LINK_ID_PRIV}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privilege: 'admin' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when privilege is owner', async () => {
      const app = createPrivilegeTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/${TEST_LINK_ID_PRIV}/privilege`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privilege: 'owner' }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /:conversationId/:linkId/name', () => {
    // ── Mock DB for the admin name update route ──

    interface AdminNameMockDbConfig {
      requesterMember?: { id: string; privilege: string } | null;
      linkExists?: boolean;
    }

    /**
     * Creates a mock Drizzle DB for the admin name update route:
     * 0. Middleware: requester membership lookup (select→from→where→limit→then)
     * 1. Link existence check (select→from→where→limit→then)
     * 2. Update query (update→set→where)
     */
    function createAdminNameMockDb(config: AdminNameMockDbConfig): unknown {
      const indexRef = { value: 0 };
      const selectResults: unknown[][] = [
        // Query 0: middleware's membership lookup
        config.requesterMember
          ? [
              {
                conversationId: TEST_CONVERSATION_ID,
                id: config.requesterMember.id,
                privilege: config.requesterMember.privilege,
                visibleFromEpoch: 1,
              },
            ]
          : [],
        // Query 1: link existence check
        config.linkExists === false ? [] : [{ id: 'link-to-update' }],
      ];
      const createQueryChain = createQueryChainFactory(selectResults, indexRef);

      return {
        select: () => createQueryChain(),
        update: () => ({
          set: () => ({
            where: () => Promise.resolve({ rowCount: 1 }),
          }),
        }),
      };
    }

    interface AdminNameTestAppOptions {
      user?: AppEnv['Variables']['user'] | null;
      dbConfig?: AdminNameMockDbConfig;
    }

    function createAdminNameTestApp(options: AdminNameTestAppOptions = {}): Hono<AppEnv> {
      const { user = createMockUser(), dbConfig = {} } = options;
      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
        c.set('user', user);
        c.set('session', user ? createMockSession() : null);
        c.set('sessionData', user ? createMockSession() : null);
        c.set('db', createAdminNameMockDb(dbConfig) as AppEnv['Variables']['db']);
        await next();
      });

      app.route('/', linksRoute);
      return app;
    }

    const TEST_LINK_ID = 'link-to-update';

    function createAdminNameBody(overrides?: Record<string, unknown>): Record<string, unknown> {
      return {
        displayName: 'Updated Name',
        ...overrides,
      };
    }

    it('returns 200 and updates display name', async () => {
      const app = createAdminNameTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          linkExists: true,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/${TEST_LINK_ID}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAdminNameBody()),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ success: boolean }>();
      expect(body.success).toBe(true);
    });

    it('returns 401 when not authenticated', async () => {
      const app = createAdminNameTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/${TEST_LINK_ID}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAdminNameBody()),
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 403 when privilege is below admin', async () => {
      const app = createAdminNameTestApp({
        dbConfig: { requesterMember: { id: 'member-1', privilege: 'write' } },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/${TEST_LINK_ID}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAdminNameBody()),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('returns 404 when link not found', async () => {
      const app = createAdminNameTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          linkExists: false,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/${TEST_LINK_ID}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAdminNameBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('LINK_NOT_FOUND');
    });

    it('returns 400 when displayName is empty', async () => {
      const app = createAdminNameTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/${TEST_LINK_ID}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAdminNameBody({ displayName: '' })),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when displayName exceeds max length', async () => {
      const app = createAdminNameTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/${TEST_LINK_ID}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createAdminNameBody({ displayName: 'A'.repeat(101) })),
      });

      expect(res.status).toBe(400);
    });
  });
});
