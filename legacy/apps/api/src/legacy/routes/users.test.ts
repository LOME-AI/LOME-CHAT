import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { usersRoute } from './users.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

const TEST_USER_ID = 'user-search-123';

const MOCK_SEARCH_RESULTS = [
  { id: 'user-1', username: 'alice', publicKey: 'AQID' },
  { id: 'user-2', username: 'alicia', publicKey: 'BAUG' },
];

vi.mock('../services/users/user-search.js', () => ({
  searchUsers: vi.fn(),
}));

// Import after mock so we get the mocked version
const { searchUsers } = await import('../services/users/user-search.js');
const mockSearchUsers = vi.mocked(searchUsers);

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
  db?: Partial<AppEnv['Variables']['db']>;
}

function createTestApp(options: TestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), db = {} } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', db as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', usersRoute);
  return app;
}

function createMockDbForUpdate(): {
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return { update, set };
}

describe('users route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /search', () => {
    it('returns 200 with matching users', async () => {
      mockSearchUsers.mockResolvedValue(MOCK_SEARCH_RESULTS);
      const app = createTestApp();

      const res = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'ali' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ users: typeof MOCK_SEARCH_RESULTS }>();
      expect(body.users).toHaveLength(2);
      expect(body.users[0]?.id).toBe('user-1');
      expect(body.users[0]?.username).toBe('alice');
      expect(body.users[0]?.publicKey).toBe('AQID');
      expect(body.users[1]?.id).toBe('user-2');
    });

    it('returns 401 when not authenticated', async () => {
      const app = createTestApp({ user: null });

      const res = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test' }),
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('validates query is non-empty', async () => {
      const app = createTestApp();

      const res = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('passes excludeConversationId to service', async () => {
      mockSearchUsers.mockResolvedValue([]);
      const app = createTestApp();

      const res = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test', excludeConversationId: 'conv-123' }),
      });

      expect(res.status).toBe(200);
      expect(mockSearchUsers).toHaveBeenCalledWith(expect.anything(), 'test', TEST_USER_ID, {
        excludeConversationId: 'conv-123',
        limit: undefined,
      });
    });

    it('passes limit to service', async () => {
      mockSearchUsers.mockResolvedValue([]);
      const app = createTestApp();

      const res = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test', limit: 5 }),
      });

      expect(res.status).toBe(200);
      expect(mockSearchUsers).toHaveBeenCalledWith(expect.anything(), 'test', TEST_USER_ID, {
        excludeConversationId: undefined,
        limit: 5,
      });
    });

    it('rejects query longer than 50 characters', async () => {
      const app = createTestApp();

      const res = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'a'.repeat(51) }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects limit less than 1', async () => {
      const app = createTestApp();

      const res = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test', limit: 0 }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects limit greater than 20', async () => {
      const app = createTestApp();

      const res = await app.request('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test', limit: 21 }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /custom-instructions', () => {
    it('returns 200 with success true on valid base64 blob', async () => {
      const mockDb = createMockDbForUpdate();
      const app = createTestApp({ db: mockDb as never });
      // Valid base64 string (simulates an ECIES-encrypted blob)
      const blob = btoa('encrypted-custom-instructions');

      const res = await app.request('/custom-instructions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customInstructionsEncrypted: blob }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ success: boolean }>();
      expect(body.success).toBe(true);
    });

    it('returns 401 when not authenticated', async () => {
      const app = createTestApp({ user: null });

      const res = await app.request('/custom-instructions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customInstructionsEncrypted: btoa('test') }),
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('accepts null to clear custom instructions', async () => {
      const mockDb = createMockDbForUpdate();
      const app = createTestApp({ db: mockDb as never });

      const res = await app.request('/custom-instructions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customInstructionsEncrypted: null }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ success: boolean }>();
      expect(body.success).toBe(true);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('stores decoded base64 as bytea in database', async () => {
      const mockDb = createMockDbForUpdate();
      const app = createTestApp({ db: mockDb as never });
      const plainBytes = 'hello-encrypted';
      const blob = btoa(plainBytes);

      await app.request('/custom-instructions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customInstructionsEncrypted: blob }),
      });

      const setCall = mockDb.set;
      expect(setCall).toHaveBeenCalledWith({
        customInstructionsEncrypted: expect.any(Uint8Array),
      });
    });

    it('stores null in database when clearing instructions', async () => {
      const mockDb = createMockDbForUpdate();
      const app = createTestApp({ db: mockDb as never });

      await app.request('/custom-instructions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customInstructionsEncrypted: null }),
      });

      const setCall = mockDb.set;
      expect(setCall).toHaveBeenCalledWith({
        customInstructionsEncrypted: null,
      });
    });

    it('rejects invalid base64 string', async () => {
      const app = createTestApp();

      const res = await app.request('/custom-instructions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customInstructionsEncrypted: '!!!not-base64!!!' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('INVALID_BASE64');
    });

    it('rejects missing body', async () => {
      const app = createTestApp();

      const res = await app.request('/custom-instructions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });
});
