import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { WELCOME_CREDIT_BALANCE } from '@hushbox/shared';
import { devRoute } from './dev.js';
import { getVersionOverride, clearVersionOverride } from '../lib/version-override.js';
import type { DevPersonasResponse } from '@hushbox/shared';
import type { AppEnv } from '../types.js';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * Stub AI client returning a minimal text-model catalog. The route's call to
 * `aiClient.listRawModels()` feeds `pickValueTextModel`; the selector needs at
 * least one non-premium text entry (old enough to escape the recency premium
 * check, priced above MIN_PRICE_PER_1K_TOKENS, with text I/O modalities).
 */
const TEST_AI_CLIENT_STUB = {
  listRawModels: vi.fn().mockResolvedValue([
    {
      id: 'anthropic/claude-haiku-4.5',
      name: 'Claude Haiku',
      description: 'Test stub model',
      modality: 'text',
      context_length: 100_000,
      pricing: { prompt: '0.000001', completion: '0.000001' },
      supported_parameters: ['temperature'],
      // Two years ago in seconds — escapes both the recency premium check
      // (<6mo) and the standard-criteria age exclusion (>2y).
      created: Math.floor((Date.now() - 365 * 24 * 60 * 60 * 1000) / 1000),
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
    },
    {
      id: 'openai/gpt-5',
      name: 'GPT-5',
      description: 'Test stub premium model',
      modality: 'text',
      context_length: 100_000,
      pricing: { prompt: '0.000004', completion: '0.000004' },
      supported_parameters: ['temperature'],
      created: Math.floor((Date.now() - 365 * 24 * 60 * 60 * 1000) / 1000),
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
    },
  ]),
};

/** Shared test app factory for dev routes that only need a db stub. */
function createDevApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', {} as AppEnv['Variables']['db']);
    c.set('aiClient', TEST_AI_CLIENT_STUB as unknown as AppEnv['Variables']['aiClient']);
    await next();
  });
  app.route('/dev', devRoute);
  return app;
}

// Mock checkUserBalance used by listDevPersonas (wallet-based balance)
const mockCheckUserBalance = vi.fn();
vi.mock('../services/billing/index.js', () => ({
  checkUserBalance: (...args: unknown[]) => mockCheckUserBalance(...args),
}));

const mockCreateDevGroupChat = vi.fn();
const mockCreateDevConversation = vi.fn();
const mockCreateDevMultiModelConversation = vi.fn();
const mockCreateDevMediaConversation = vi.fn();
vi.mock('../services/dev/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/dev/index.js')>();
  return {
    ...original,
    createDevGroupChat: (...args: unknown[]) => mockCreateDevGroupChat(...args),
    createDevConversation: (...args: unknown[]) => mockCreateDevConversation(...args),
    createDevMultiModelConversation: (...args: unknown[]) =>
      mockCreateDevMultiModelConversation(...args),
    createDevMediaConversation: (...args: unknown[]) => mockCreateDevMediaConversation(...args),
  };
});

// Pass-through the media middleware; these tests set a stub `mediaStorage`
// themselves (the real one is covered in middleware/dependencies.test.ts).
vi.mock('../middleware/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../middleware/index.js')>();
  return {
    ...original,
    mediaStorageMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
  };
});

interface MockUser {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface TestDataDeleteResponse {
  success: boolean;
  deleted: { conversations: number; messages: number };
}

interface TrialUsageResetResponse {
  success: boolean;
  deleted: number;
}

function createMockDb(devUsers: MockUser[], counts?: { conv: number; msg: number; proj: number }) {
  const actualCounts = counts ?? { conv: 0, msg: 0, proj: 0 };

  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  const mockInnerJoin = vi.fn();

  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockImplementation(() => ({
    where: mockWhere,
    innerJoin: mockInnerJoin,
  }));
  mockInnerJoin.mockReturnValue({ where: mockWhere });

  let callCount = 0;
  mockWhere.mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      return Promise.resolve(devUsers);
    }
    const countType = (callCount - 2) % 3;
    if (countType === 0) return Promise.resolve([{ count: actualCounts.conv }]);
    if (countType === 1) return Promise.resolve([{ count: actualCounts.msg }]);
    return Promise.resolve([{ count: actualCounts.proj }]);
  });

  return { select: mockSelect };
}

function createTestAppWithMockDb(mockDb: unknown): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', mockDb as AppEnv['Variables']['db']);
    await next();
  });
  app.route('/dev', devRoute);
  return app;
}

describe('devRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /personas', () => {
    it('returns 200 with personas array', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'alice_developer',
          email: 'alice@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      expect(res.status).toBe(200);

      const body: DevPersonasResponse = await res.json();
      expect(body.personas).toBeDefined();
      expect(Array.isArray(body.personas)).toBe(true);
    });

    it('returns empty array when no dev users exist', async () => {
      const mockDb = createMockDb([]);
      const app = createTestAppWithMockDb(mockDb);

      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas).toEqual([]);
    });

    it('includes user fields in response', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'alice_developer',
          email: 'alice@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas[0]).toMatchObject({
        id: 'user-1',
        username: 'alice_developer',
        email: 'alice@dev.hushbox.ai',
        emailVerified: true,
      });
    });

    it('returns credits based on wallet balance', async () => {
      mockCheckUserBalance.mockResolvedValue({ hasBalance: true, currentBalance: '1.50000000' });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'alice',
          email: 'alice@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas[0]?.credits).toBe('$1.50');
    });

    it('returns $0.00 for users with zero balance', async () => {
      mockCheckUserBalance.mockResolvedValue({ hasBalance: false, currentBalance: '0.00000000' });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'bob',
          email: 'bob@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas[0]?.credits).toBe('$0.00');
    });

    it('returns default welcome credits for new users', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'newuser',
          email: 'newuser@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas[0]?.credits).toBe('$0.20');
    });

    it('includes stats for each persona', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb(
        [
          {
            id: 'user-1',
            username: 'alice',
            email: 'alice@dev.hushbox.ai',
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        { conv: 3, msg: 12, proj: 2 }
      );

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      const persona = body.personas[0];
      expect(persona?.stats).toBeDefined();
      expect(typeof persona?.stats.conversationCount).toBe('number');
      expect(typeof persona?.stats.messageCount).toBe('number');
      expect(typeof persona?.stats.projectCount).toBe('number');
    });

    it('handles multiple personas', async () => {
      mockCheckUserBalance.mockResolvedValue({ hasBalance: true, currentBalance: '1.50000000' });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'alice',
          email: 'alice@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'user-2',
          username: 'bob',
          email: 'bob@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas).toHaveLength(2);
    });

    it('filters by type=dev (default)', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'alice',
          email: 'alice@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas?type=dev');
      const body: DevPersonasResponse = await res.json();

      expect(res.status).toBe(200);
      expect(body.personas).toHaveLength(1);
      expect(body.personas[0]?.email).toContain('@dev.hushbox.ai');
    });

    it('filters by type=test to get test personas', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb([
        {
          id: 'test-user-1',
          username: 'test_alice',
          email: 'test-alice@test.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas?type=test');
      const body: DevPersonasResponse = await res.json();

      expect(res.status).toBe(200);
      expect(body.personas).toHaveLength(1);
      expect(body.personas[0]?.email).toContain('@test.hushbox.ai');
    });

    it('returns dev personas by default when no type param', async () => {
      mockCheckUserBalance.mockResolvedValue({
        hasBalance: true,
        currentBalance: WELCOME_CREDIT_BALANCE,
      });
      const mockDb = createMockDb([
        {
          id: 'user-1',
          username: 'alice',
          email: 'alice@dev.hushbox.ai',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/personas');

      expect(res.status).toBe(200);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('returns 400 for invalid type query parameter', async () => {
      const mockDb = createMockDb([]);
      const app = createTestAppWithMockDb(mockDb);

      const res = await app.request('/dev/personas?type=invalid');

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /test-data', () => {
    function createDeleteMockDb(options: {
      testUsers: { id: string }[];
      conversations: { id: string }[];
      deleteMessagesRowCount?: number;
      deleteConversationsRowCount?: number;
    }) {
      const mockSelect = vi.fn();
      const mockFrom = vi.fn();
      const mockWhere = vi.fn();
      const mockDelete = vi.fn();
      const mockDeleteWhere = vi.fn();

      let selectCallCount = 0;
      mockSelect.mockReturnValue({ from: mockFrom });
      mockFrom.mockReturnValue({ where: mockWhere });
      mockWhere.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return Promise.resolve(options.testUsers);
        }
        return Promise.resolve(options.conversations);
      });

      let deleteCallCount = 0;
      mockDelete.mockReturnValue({ where: mockDeleteWhere });
      mockDeleteWhere.mockImplementation(() => {
        deleteCallCount++;
        if (deleteCallCount === 1) {
          return Promise.resolve({ rowCount: options.deleteMessagesRowCount ?? 0 });
        }
        return Promise.resolve({ rowCount: options.deleteConversationsRowCount ?? 0 });
      });

      return { select: mockSelect, delete: mockDelete };
    }

    it('returns success with zero counts when no test users exist', async () => {
      const mockDb = createDeleteMockDb({
        testUsers: [],
        conversations: [],
      });

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/test-data', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TestDataDeleteResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted.conversations).toBe(0);
      expect(body.deleted.messages).toBe(0);
    });

    it('returns success with zero counts when test users have no conversations', async () => {
      const mockDb = createDeleteMockDb({
        testUsers: [{ id: 'test-user-1' }],
        conversations: [],
      });

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/test-data', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TestDataDeleteResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted.conversations).toBe(0);
      expect(body.deleted.messages).toBe(0);
    });

    it('deletes messages and conversations for test users', async () => {
      const mockDb = createDeleteMockDb({
        testUsers: [{ id: 'test-user-1' }, { id: 'test-user-2' }],
        conversations: [{ id: 'conv-1' }, { id: 'conv-2' }],
        deleteMessagesRowCount: 5,
        deleteConversationsRowCount: 2,
      });

      const app = createTestAppWithMockDb(mockDb);
      const res = await app.request('/dev/test-data', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TestDataDeleteResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted.messages).toBe(5);
      expect(body.deleted.conversations).toBe(2);
    });

    it('calls delete on messages before conversations (FK constraint)', async () => {
      const deleteCalls: string[] = [];
      const mockSelect = vi.fn();
      const mockFrom = vi.fn();
      const mockWhere = vi.fn();
      const mockDelete = vi.fn();
      const mockDeleteWhere = vi.fn();

      mockSelect.mockReturnValue({ from: mockFrom });
      mockFrom.mockReturnValue({ where: mockWhere });

      let selectCallCount = 0;
      mockWhere.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return Promise.resolve([{ id: 'test-user-1' }]);
        }
        return Promise.resolve([{ id: 'conv-1' }]);
      });

      mockDelete.mockImplementation((table: Record<string, unknown>) => {
        // Track which table is being deleted from based on the table object
        const tableName = Object.keys(table).includes('conversationId')
          ? 'messages'
          : 'conversations';
        deleteCalls.push(tableName);
        return { where: mockDeleteWhere };
      });
      mockDeleteWhere.mockResolvedValue({ rowCount: 1 });

      const mockDb = { select: mockSelect, delete: mockDelete };
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        await next();
      });
      app.route('/dev', devRoute);

      await app.request('/dev/test-data', { method: 'DELETE' });

      // Delete should be called twice - messages first, then conversations
      expect(mockDelete).toHaveBeenCalledTimes(2);
      expect(deleteCalls).toEqual(['messages', 'conversations']);
    });
  });

  describe('GET /verify-token/:email', () => {
    function createVerifyTokenMockDb(user: { emailVerifyToken: string | null } | null) {
      const mockSelect = vi.fn();
      const mockFrom = vi.fn();
      const mockWhere = vi.fn();

      mockSelect.mockReturnValue({ from: mockFrom });
      mockFrom.mockReturnValue({ where: mockWhere });
      mockWhere.mockResolvedValue(user ? [user] : []);

      return { select: mockSelect };
    }

    it('returns token for user with pending verification', async () => {
      const mockDb = createVerifyTokenMockDb({ emailVerifyToken: 'test-token-123' });
      const app = createTestAppWithMockDb(mockDb);

      const res = await app.request('/dev/verify-token/test@example.com');

      expect(res.status).toBe(200);
      const body = await jsonBody<{ token: string }>(res);
      expect(body.token).toBe('test-token-123');
    });

    it('returns 404 when user not found', async () => {
      const mockDb = createVerifyTokenMockDb(null);
      const app = createTestAppWithMockDb(mockDb);

      const res = await app.request('/dev/verify-token/nonexistent@example.com');

      expect(res.status).toBe(404);
      const body = await jsonBody<{ code: string }>(res);
      expect(body.code).toBe('NOT_FOUND');
    });

    it('returns 404 when user has no verify token', async () => {
      const mockDb = createVerifyTokenMockDb({ emailVerifyToken: null });
      const app = createTestAppWithMockDb(mockDb);

      const res = await app.request('/dev/verify-token/verified@example.com');

      expect(res.status).toBe(404);
      const body = await jsonBody<{ code: string }>(res);
      expect(body.code).toBe('NOT_FOUND');
    });

    it('returns 400 for invalid email format', async () => {
      const mockDb = createVerifyTokenMockDb(null);
      const app = createTestAppWithMockDb(mockDb);

      const res = await app.request('/dev/verify-token/not-an-email');

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /trial-usage', () => {
    function createTrialUsageApp(keys: string[]) {
      const mockRedis = {
        scan: vi.fn().mockResolvedValue(['0', keys]),
        del: vi.fn().mockResolvedValue(keys.length),
      };

      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
        c.set('db', {} as unknown as AppEnv['Variables']['db']);
        await next();
      });
      app.route('/dev', devRoute);
      return app;
    }

    it('returns success with count of deleted keys', async () => {
      const app = createTrialUsageApp(['trial:token:abc', 'trial:ip:hash1']);
      const res = await app.request('/dev/trial-usage', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TrialUsageResetResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(2);
    });

    it('returns success with zero when no keys exist', async () => {
      const app = createTrialUsageApp([]);
      const res = await app.request('/dev/trial-usage', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TrialUsageResetResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(0);
    });
  });

  function createRateLimitResetApp(keys: string[]): {
    app: Hono<AppEnv>;
    mockRedis: { scan: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> };
  } {
    const mockRedis = {
      scan: vi.fn().mockResolvedValue(['0', keys]),
      del: vi.fn().mockResolvedValue(keys.length),
    };

    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
      c.set('db', {} as unknown as AppEnv['Variables']['db']);
      await next();
    });
    app.route('/dev', devRoute);
    return { app, mockRedis };
  }

  describe('DELETE /auth-rate-limits', () => {
    it('returns success with count of deleted keys', async () => {
      const { app } = createRateLimitResetApp([
        'login:user:ratelimit:alice',
        'login:lockout:alice',
      ]);
      const res = await app.request('/dev/auth-rate-limits', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TrialUsageResetResponse = await res.json();
      expect(body.success).toBe(true);
      expect(typeof body.deleted).toBe('number');
    });

    it('returns success with zero when no keys exist', async () => {
      const { app } = createRateLimitResetApp([]);
      const res = await app.request('/dev/auth-rate-limits', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TrialUsageResetResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(0);
    });
  });

  describe('DELETE /usage-rate-limits', () => {
    it('returns success with count of deleted keys across all per-user prefixes', async () => {
      const { app } = createRateLimitResetApp([
        'chat:stream:user:ratelimit:alice',
        'media:download:user:ratelimit:bob',
      ]);
      const res = await app.request('/dev/usage-rate-limits', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TrialUsageResetResponse = await res.json();
      expect(body.success).toBe(true);
      expect(typeof body.deleted).toBe('number');
    });

    it('returns success with zero when no keys exist', async () => {
      const { app } = createRateLimitResetApp([]);
      const res = await app.request('/dev/usage-rate-limits', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body: TrialUsageResetResponse = await res.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(0);
    });
  });

  describe('DELETE /totp-replay', () => {
    function createTotpReplayApp(options: { user?: { id: string }; keys: string[] }): {
      app: Hono<AppEnv>;
      mockRedis: { scan: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> };
    } {
      const mockRedis = {
        scan: vi.fn().mockResolvedValue(['0', options.keys]),
        del: vi.fn().mockResolvedValue(options.keys.length),
      };
      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(options.user ? [options.user] : []),
          }),
        }),
      };
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        await next();
      });
      app.route('/dev', devRoute);
      return { app, mockRedis };
    }

    it("clears the resolved user's replay markers and returns the deleted count", async () => {
      const { app, mockRedis } = createTotpReplayApp({
        user: { id: 'user-123' },
        keys: ['totp:used:user-123:111111', 'totp:used:user-123:222222'],
      });

      const res = await app.request('/dev/totp-replay', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'test-2fa@test.hushbox.ai' }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<{ success: boolean; deleted: number }>(res);
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(2);
      // Scopes the scan to the resolved user, not the global totp:used:* space.
      expect(mockRedis.scan).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ match: 'totp:used:user-123:*' })
      );
    });

    it('returns 404 when no user matches the email', async () => {
      const { app } = createTotpReplayApp({ keys: [] });

      const res = await app.request('/dev/totp-replay', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@test.hushbox.ai' }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /message-payers/:conversationId', () => {
    function createMessagePayersApp(
      rows: { messageId: string; payerId: string | null; sequenceNumber: number }[]
    ) {
      const orderBy = vi.fn().mockResolvedValue(rows);
      const where = vi.fn().mockReturnValue({ orderBy });
      const leftJoin = vi.fn().mockReturnValue({ where });
      const from = vi.fn().mockReturnValue({ leftJoin });
      const select = vi.fn().mockReturnValue({ from });
      const mockDb = { select };
      return createTestAppWithMockDb(mockDb);
    }

    it('returns AI messages with their resolved payerId from usage_records', async () => {
      const app = createMessagePayersApp([
        { messageId: 'msg-1', payerId: 'user-alice', sequenceNumber: 1 },
        { messageId: 'msg-2', payerId: 'user-bob', sequenceNumber: 3 },
      ]);
      const res = await app.request('/dev/message-payers/conv-1');

      expect(res.status).toBe(200);
      const body = await jsonBody<{
        payers: { messageId: string; payerId: string | null }[];
      }>(res);
      expect(body.payers).toEqual([
        { messageId: 'msg-1', payerId: 'user-alice' },
        { messageId: 'msg-2', payerId: 'user-bob' },
      ]);
    });

    it('surfaces null payerId for AI messages with no matching usage_records row', async () => {
      const app = createMessagePayersApp([
        { messageId: 'msg-only', payerId: null, sequenceNumber: 1 },
      ]);
      const res = await app.request('/dev/message-payers/conv-empty');

      expect(res.status).toBe(200);
      const body = await jsonBody<{
        payers: { messageId: string; payerId: string | null }[];
      }>(res);
      expect(body.payers).toEqual([{ messageId: 'msg-only', payerId: null }]);
    });

    it('returns an empty list when the conversation has no AI messages', async () => {
      const app = createMessagePayersApp([]);
      const res = await app.request('/dev/message-payers/conv-none');

      expect(res.status).toBe(200);
      const body = await jsonBody<{ payers: unknown[] }>(res);
      expect(body.payers).toEqual([]);
    });
  });

  describe('GET /conversation-cost/:conversationId', () => {
    function createConversationCostApp(rows: { cost: string }[]): Hono<AppEnv> {
      const where = vi.fn().mockResolvedValue(rows);
      const innerJoin = vi.fn().mockReturnValue({ where });
      const from = vi.fn().mockReturnValue({ innerJoin });
      const select = vi.fn().mockReturnValue({ from });
      return createTestAppWithMockDb({ select });
    }

    it('returns the summed usage_records cost charged for the conversation', async () => {
      const app = createConversationCostApp([{ cost: '0.00017768' }]);
      const res = await app.request('/dev/conversation-cost/conv-1');

      expect(res.status).toBe(200);
      const body = await jsonBody<{ cost: string }>(res);
      expect(body.cost).toBe('0.00017768');
    });

    it('returns "0" when the conversation has no charged usage', async () => {
      const app = createConversationCostApp([]);
      const res = await app.request('/dev/conversation-cost/conv-none');

      expect(res.status).toBe(200);
      const body = await jsonBody<{ cost: string }>(res);
      expect(body.cost).toBe('0');
    });
  });

  describe('POST /set-version', () => {
    afterEach(() => {
      clearVersionOverride();
    });

    function createSetVersionApp(): Hono<AppEnv> {
      return createDevApp();
    }

    it('sets version override and returns 200', async () => {
      const app = createSetVersionApp();

      const res = await app.request('/dev/set-version', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 'dev-update-12345' }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<{ success: boolean; version: string }>(res);
      expect(body.success).toBe(true);
      expect(body.version).toBe('dev-update-12345');
      expect(getVersionOverride()).toBe('dev-update-12345');
    });

    it('returns 400 when version is missing', async () => {
      const app = createSetVersionApp();

      const res = await app.request('/dev/set-version', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when version is empty', async () => {
      const app = createSetVersionApp();

      const res = await app.request('/dev/set-version', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('overwrites previous override', async () => {
      const app = createSetVersionApp();

      await app.request('/dev/set-version', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 'v1' }),
      });

      await app.request('/dev/set-version', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 'v2' }),
      });

      expect(getVersionOverride()).toBe('v2');
    });
  });

  describe('GET /emails', () => {
    function createEmailsApp(): Hono<AppEnv> {
      return createDevApp();
    }

    it('returns 200 with templates array', async () => {
      const app = createEmailsApp();

      const res = await app.request('/dev/emails');

      expect(res.status).toBe(200);
      const body = await jsonBody<{ templates: unknown[] }>(res);
      expect(Array.isArray(body.templates)).toBe(true);
      expect(body.templates.length).toBeGreaterThan(0);
    });

    it('includes all 6 email templates', async () => {
      const app = createEmailsApp();

      const res = await app.request('/dev/emails');
      const body = await jsonBody<{ templates: { name: string }[] }>(res);

      const names = body.templates.map((t) => t.name);
      expect(names).toContain('verification');
      expect(names).toContain('password-changed');
      expect(names).toContain('two-factor-enabled');
      expect(names).toContain('two-factor-disabled');
      expect(names).toContain('account-locked');
      expect(names).toContain('welcome');
    });

    it('returns name, label, and html for each template', async () => {
      const app = createEmailsApp();

      const res = await app.request('/dev/emails');
      const body = await jsonBody<{
        templates: { name: string; label: string; html: string }[];
      }>(res);

      for (const template of body.templates) {
        expect(typeof template.name).toBe('string');
        expect(typeof template.label).toBe('string');
        expect(typeof template.html).toBe('string');
        expect(template.html).toContain('<!DOCTYPE html');
      }
    });

    it('renders verification template with sample data', async () => {
      const app = createEmailsApp();

      const res = await app.request('/dev/emails');
      const body = await jsonBody<{
        templates: { name: string; html: string }[];
      }>(res);

      const verification = body.templates.find((t) => t.name === 'verification');
      expect(verification?.html).toContain('Verify');
    });
  });

  describe('POST /group-chat', () => {
    function createGroupChatApp(): Hono<AppEnv> {
      return createDevApp();
    }

    beforeEach(() => {
      mockCreateDevGroupChat.mockReset();
    });

    it('returns 201 with conversationId and members on success', async () => {
      mockCreateDevGroupChat.mockResolvedValue({
        conversationId: 'conv-123',
        members: [
          { userId: 'alice-id', username: 'alice', email: 'alice@test.hushbox.ai' },
          { userId: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai' },
        ],
      });

      const app = createGroupChatApp();
      const res = await app.request('/dev/group-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: 'alice@test.hushbox.ai',
          memberEmails: ['bob@test.hushbox.ai'],
        }),
      });

      expect(res.status).toBe(201);
      const body = await jsonBody<{ conversationId: string; members: unknown[] }>(res);
      expect(body.conversationId).toBe('conv-123');
      expect(body.members).toHaveLength(2);
    });

    it('passes messages to service when provided', async () => {
      mockCreateDevGroupChat.mockResolvedValue({
        conversationId: 'conv-456',
        members: [],
      });

      const app = createGroupChatApp();
      await app.request('/dev/group-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: 'alice@test.hushbox.ai',
          memberEmails: ['bob@test.hushbox.ai'],
          messages: [
            { senderEmail: 'alice@test.hushbox.ai', content: 'Hello', senderType: 'user' },
            { content: 'Echo: Hello', senderType: 'ai' },
          ],
        }),
      });

      expect(mockCreateDevGroupChat).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          ownerEmail: 'alice@test.hushbox.ai',
          memberEmails: ['bob@test.hushbox.ai'],
          messages: [
            { senderEmail: 'alice@test.hushbox.ai', content: 'Hello', senderType: 'user' },
            { content: 'Echo: Hello', senderType: 'ai' },
          ],
        })
      );
    });

    it('returns 400 when ownerEmail is missing', async () => {
      const app = createGroupChatApp();
      const res = await app.request('/dev/group-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberEmails: ['bob@test.hushbox.ai'],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when memberEmails is missing', async () => {
      const app = createGroupChatApp();
      const res = await app.request('/dev/group-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: 'alice@test.hushbox.ai',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /conversation', () => {
    // Three ZDR-allowed text models — the route filters through the real ZDR
    // allow-list, so fabricated ids would be dropped before the picker runs.
    // Per-token prices ≤ 0.000002 keep the two cheapest under the trial budget
    // (non-premium); the priciest is flagged premium by the 75th-percentile cut.
    const oldCreated = Math.floor((Date.now() - 365 * 24 * 60 * 60 * 1000) / 1000);
    const textModel = (id: string, perToken: string) => ({
      id,
      name: id,
      description: 'stub',
      modality: 'text',
      context_length: 100_000,
      pricing: { prompt: perToken, completion: perToken },
      supported_parameters: ['temperature'],
      created: oldCreated,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    });

    function createConversationApp(): Hono<AppEnv> {
      const aiClient = {
        listRawModels: vi
          .fn()
          .mockResolvedValue([
            textModel('anthropic/claude-haiku-4.5', '0.000001'),
            textModel('google/gemini-2.5-flash-lite', '0.0000015'),
            textModel('openai/gpt-5.4-nano', '0.000002'),
          ]),
      };
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('db', {} as AppEnv['Variables']['db']);
        c.set('aiClient', aiClient as unknown as AppEnv['Variables']['aiClient']);
        await next();
      });
      app.route('/dev', devRoute);
      return app;
    }

    beforeEach(() => {
      mockCreateDevConversation.mockReset();
      mockCreateDevMultiModelConversation.mockReset();
    });

    it('seeds a multi-model turn with distinct resolved models and costs when aiTurn is provided', async () => {
      mockCreateDevMultiModelConversation.mockResolvedValue({ conversationId: 'conv-mm' });
      const app = createConversationApp();

      const res = await app.request('/dev/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: 'alice@test.hushbox.ai',
          aiTurn: { userContent: 'Compare these', responseCount: 2 },
        }),
      });

      expect(res.status).toBe(201);
      const body = await jsonBody<{ conversationId: string }>(res);
      expect(body.conversationId).toBe('conv-mm');

      expect(mockCreateDevMultiModelConversation).toHaveBeenCalledTimes(1);
      const callArgument = mockCreateDevMultiModelConversation.mock.calls[0]![1] as {
        ownerEmail: string;
        userContent: string;
        aiResponses: { content: string; modelName: string; cost: string }[];
      };
      expect(callArgument.ownerEmail).toBe('alice@test.hushbox.ai');
      expect(callArgument.userContent).toBe('Compare these');
      expect(callArgument.aiResponses).toHaveLength(2);

      // The two cheapest non-premium picks, distinct, in ascending price order.
      const modelNames = callArgument.aiResponses.map((r) => r.modelName);
      expect(modelNames).toEqual(['anthropic/claude-haiku-4.5', 'google/gemini-2.5-flash-lite']);

      // Every sibling carries a non-null, parseable, positive cost so the badge
      // renders and the `data-cost-count` signal counts it.
      for (const response of callArgument.aiResponses) {
        expect(Number.parseFloat(response.cost)).toBeGreaterThan(0);
      }
    });

    it('seeds a plain text conversation via createDevConversation when messages are provided', async () => {
      mockCreateDevConversation.mockResolvedValue({ conversationId: 'conv-text' });
      const app = createConversationApp();

      const res = await app.request('/dev/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: 'alice@test.hushbox.ai',
          messages: [
            { content: 'Hello', senderType: 'user' },
            { content: 'Echo: Hello', senderType: 'ai' },
          ],
        }),
      });

      expect(res.status).toBe(201);
      const body = await jsonBody<{ conversationId: string }>(res);
      expect(body.conversationId).toBe('conv-text');

      expect(mockCreateDevMultiModelConversation).not.toHaveBeenCalled();
      expect(mockCreateDevConversation).toHaveBeenCalledTimes(1);
      const callArgument = mockCreateDevConversation.mock.calls[0]![1] as {
        ownerEmail: string;
        seedAiModel: string;
        messages: { content: string; senderType: string }[];
      };
      expect(callArgument.ownerEmail).toBe('alice@test.hushbox.ai');
      // The single cheapest non-premium pick stamps the seeded AI rows.
      expect(callArgument.seedAiModel).toBe('anthropic/claude-haiku-4.5');
      expect(callArgument.messages).toHaveLength(2);
    });

    it('returns 400 when ownerEmail is missing', async () => {
      const app = createConversationApp();
      const res = await app.request('/dev/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiTurn: { userContent: 'x', responseCount: 2 } }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when aiTurn.responseCount is below 1', async () => {
      const app = createConversationApp();
      const res = await app.request('/dev/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: 'alice@test.hushbox.ai',
          aiTurn: { userContent: 'x', responseCount: 0 },
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /media-conversation', () => {
    function createMediaApp(): { app: Hono<AppEnv>; put: ReturnType<typeof vi.fn> } {
      const put = vi.fn(() => Promise.resolve());
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('db', {} as AppEnv['Variables']['db']);
        c.set('aiClient', TEST_AI_CLIENT_STUB as unknown as AppEnv['Variables']['aiClient']);
        c.set('mediaStorage', { put } as unknown as AppEnv['Variables']['mediaStorage']);
        await next();
      });
      app.route('/dev', devRoute);
      return { app, put };
    }

    beforeEach(() => {
      mockCreateDevMediaConversation.mockReset();
    });

    it('seeds an image conversation with a live-catalog model and a positive cost', async () => {
      mockCreateDevMediaConversation.mockResolvedValue({
        conversationId: 'conv-img',
        assistantMessageId: 'msg-img',
      });
      const { app } = createMediaApp();

      const res = await app.request('/dev/media-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: 'alice@test.hushbox.ai',
          userContent: 'Draw a cat',
          mediaType: 'image',
        }),
      });

      expect(res.status).toBe(201);
      const body = await jsonBody<{ conversationId: string; assistantMessageId: string }>(res);
      expect(body).toEqual({ conversationId: 'conv-img', assistantMessageId: 'msg-img' });

      expect(mockCreateDevMediaConversation).toHaveBeenCalledTimes(1);
      // The mediaStorage from context is forwarded as the second arg.
      expect(mockCreateDevMediaConversation.mock.calls[0]![1]).toBeDefined();
      const params = mockCreateDevMediaConversation.mock.calls[0]![2] as {
        ownerEmail: string;
        userContent: string;
        mediaType: string;
        modelName: string;
        cost: string;
      };
      expect(params.ownerEmail).toBe('alice@test.hushbox.ai');
      expect(params.userContent).toBe('Draw a cat');
      expect(params.mediaType).toBe('image');
      expect(params.modelName).toBe('anthropic/claude-haiku-4.5');
      expect(Number.parseFloat(params.cost)).toBeGreaterThan(0);
    });

    it('seeds a video conversation', async () => {
      mockCreateDevMediaConversation.mockResolvedValue({
        conversationId: 'conv-vid',
        assistantMessageId: 'msg-vid',
      });
      const { app } = createMediaApp();

      const res = await app.request('/dev/media-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: 'alice@test.hushbox.ai',
          userContent: 'Animate a cat',
          mediaType: 'video',
        }),
      });

      expect(res.status).toBe(201);
      const params = mockCreateDevMediaConversation.mock.calls[0]![2] as { mediaType: string };
      expect(params.mediaType).toBe('video');
    });

    it('returns 400 for an unknown mediaType', async () => {
      const { app } = createMediaApp();
      const res = await app.request('/dev/media-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: 'alice@test.hushbox.ai',
          userContent: 'x',
          mediaType: 'audio',
        }),
      });

      expect(res.status).toBe(400);
      expect(mockCreateDevMediaConversation).not.toHaveBeenCalled();
    });
  });
});
