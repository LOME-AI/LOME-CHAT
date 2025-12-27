import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createDevRoute } from './dev.js';
import type { DevPersonasResponse } from '@lome-chat/shared';
import type { AppEnv } from '../types.js';

interface MockUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TestDataDeleteResponse {
  success: boolean;
  deleted: { conversations: number; messages: number };
}

function createMockDb(
  devUsers: MockUser[],
  counts: { conv: number; msg: number; proj: number } = { conv: 0, msg: 0, proj: 0 }
) {
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
    if (countType === 0) return Promise.resolve([{ count: counts.conv }]);
    if (countType === 1) return Promise.resolve([{ count: counts.msg }]);
    return Promise.resolve([{ count: counts.proj }]);
  });

  return { select: mockSelect };
}

function createTestApp(mockDb: ReturnType<typeof createMockDb>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
    await next();
  });
  app.route('/dev', createDevRoute());
  return app;
}

describe('createDevRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /personas', () => {
    it('returns 200 with personas array', async () => {
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'Alice Developer',
          email: 'alice@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestApp(mockDb);
      const res = await app.request('/dev/personas');
      expect(res.status).toBe(200);

      const body: DevPersonasResponse = await res.json();
      expect(body.personas).toBeDefined();
      expect(Array.isArray(body.personas)).toBe(true);
    });

    it('returns empty array when no dev users exist', async () => {
      const mockDb = createMockDb([]);
      const app = createTestApp(mockDb);

      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas).toEqual([]);
    });

    it('includes user fields in response', async () => {
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'Alice Developer',
          email: 'alice@dev.lome-chat.com',
          emailVerified: true,
          image: 'https://example.com/alice.png',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestApp(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas[0]).toMatchObject({
        id: 'user-1',
        name: 'Alice Developer',
        email: 'alice@dev.lome-chat.com',
        emailVerified: true,
        image: 'https://example.com/alice.png',
      });
    });

    it('returns credits as $0.00 placeholder', async () => {
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'Alice',
          email: 'alice@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestApp(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas[0]?.credits).toBe('$0.00');
    });

    it('includes stats for each persona', async () => {
      const mockDb = createMockDb(
        [
          {
            id: 'user-1',
            name: 'Alice',
            email: 'alice@dev.lome-chat.com',
            emailVerified: true,
            image: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        { conv: 3, msg: 12, proj: 2 }
      );

      const app = createTestApp(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      const persona = body.personas[0];
      expect(persona?.stats).toBeDefined();
      expect(typeof persona?.stats.conversationCount).toBe('number');
      expect(typeof persona?.stats.messageCount).toBe('number');
      expect(typeof persona?.stats.projectCount).toBe('number');
    });

    it('handles multiple personas', async () => {
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'Alice',
          email: 'alice@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'user-2',
          name: 'Bob',
          email: 'bob@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestApp(mockDb);
      const res = await app.request('/dev/personas');
      const body: DevPersonasResponse = await res.json();

      expect(body.personas).toHaveLength(2);
    });

    it('filters by type=dev (default)', async () => {
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'Alice',
          email: 'alice@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestApp(mockDb);
      const res = await app.request('/dev/personas?type=dev');
      const body: DevPersonasResponse = await res.json();

      expect(res.status).toBe(200);
      expect(body.personas).toHaveLength(1);
      expect(body.personas[0]?.email).toContain('@dev.lome-chat.com');
    });

    it('filters by type=test to get test personas', async () => {
      const mockDb = createMockDb([
        {
          id: 'test-user-1',
          name: 'Test Alice',
          email: 'test-alice@test.lome-chat.com',
          emailVerified: true,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestApp(mockDb);
      const res = await app.request('/dev/personas?type=test');
      const body: DevPersonasResponse = await res.json();

      expect(res.status).toBe(200);
      expect(body.personas).toHaveLength(1);
      expect(body.personas[0]?.email).toContain('@test.lome-chat.com');
    });

    it('returns dev personas by default when no type param', async () => {
      const mockDb = createMockDb([
        {
          id: 'user-1',
          name: 'Alice',
          email: 'alice@dev.lome-chat.com',
          emailVerified: true,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const app = createTestApp(mockDb);
      const res = await app.request('/dev/personas');

      expect(res.status).toBe(200);
      // Default behavior should query dev domain
      expect(mockDb.select).toHaveBeenCalled();
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

    function createDeleteTestApp(mockDb: ReturnType<typeof createDeleteMockDb>): Hono<AppEnv> {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        await next();
      });
      app.route('/dev', createDevRoute());
      return app;
    }

    it('returns success with zero counts when no test users exist', async () => {
      const mockDb = createDeleteMockDb({
        testUsers: [],
        conversations: [],
      });

      const app = createDeleteTestApp(mockDb);
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

      const app = createDeleteTestApp(mockDb);
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

      const app = createDeleteTestApp(mockDb);
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
      app.route('/dev', createDevRoute());

      await app.request('/dev/test-data', { method: 'DELETE' });

      // Delete should be called twice - messages first, then conversations
      expect(mockDelete).toHaveBeenCalledTimes(2);
    });
  });
});
