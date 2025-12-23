import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Hono } from 'hono';
import { createSessionMiddleware } from './session.js';

interface SessionData {
  user: unknown;
  session: unknown;
}

interface MockAuth {
  api: {
    getSession: Mock<(options: { headers: Headers }) => Promise<SessionData | null>>;
  };
}

describe('session middleware', () => {
  let mockAuth: MockAuth;

  beforeEach(() => {
    mockAuth = {
      api: {
        getSession: vi.fn<(options: { headers: Headers }) => Promise<SessionData | null>>(),
      },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns a middleware function', () => {
    const middleware = createSessionMiddleware(mockAuth);

    expect(middleware).toBeDefined();
    expect(typeof middleware).toBe('function');
  });

  it('calls auth.api.getSession with request headers', async () => {
    mockAuth.api.getSession.mockResolvedValue(null);

    const app = new Hono();
    app.use('*', createSessionMiddleware(mockAuth));
    app.get('/test', (c) => c.json({ ok: true }));

    await app.request('/test', {
      headers: { Cookie: 'auth-session=abc123' },
    });

    expect(mockAuth.api.getSession).toHaveBeenCalledTimes(1);
    const [callArgs] = mockAuth.api.getSession.mock.calls;
    expect(callArgs).toBeDefined();
    expect(callArgs?.[0].headers).toBeDefined();
  });

  it('sets user and session in context when authenticated', async () => {
    const mockUser = { id: 'user-1', email: 'test@example.com', name: 'Test' };
    const mockSession = {
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(),
    };
    mockAuth.api.getSession.mockResolvedValue({
      user: mockUser,
      session: mockSession,
    });

    const app = new Hono<{
      Variables: { user: typeof mockUser; session: typeof mockSession };
    }>();
    app.use('*', createSessionMiddleware(mockAuth));
    app.get('/test', (c) => {
      const user = c.get('user');
      const session = c.get('session');
      return c.json({ user, session });
    });

    const res = await app.request('/test');
    const body: { user: typeof mockUser; session: unknown } = await res.json();

    expect(body.user).toEqual(mockUser);
    expect(body.session).toEqual({
      ...mockSession,
      expiresAt: mockSession.expiresAt.toISOString(),
    });
  });

  it('sets null for user and session when not authenticated', async () => {
    mockAuth.api.getSession.mockResolvedValue(null);

    const app = new Hono<{
      Variables: { user: unknown; session: unknown };
    }>();
    app.use('*', createSessionMiddleware(mockAuth));
    app.get('/test', (c) => {
      const user = c.get('user');
      const session = c.get('session');
      return c.json({ user, session });
    });

    const res = await app.request('/test');
    const body: { user: unknown; session: unknown } = await res.json();

    expect(body.user).toBeNull();
    expect(body.session).toBeNull();
  });

  it('allows subsequent handlers to access session', async () => {
    const mockUser = { id: 'user-2', email: 'user@test.com', name: 'User' };
    mockAuth.api.getSession.mockResolvedValue({
      user: mockUser,
      session: { id: 'session-2', userId: 'user-2', expiresAt: new Date() },
    });

    const app = new Hono<{
      Variables: { user: typeof mockUser; session: unknown };
    }>();
    app.use('*', createSessionMiddleware(mockAuth));
    app.get('/protected', (c) => {
      const user = c.get('user');
      return c.json({ message: `Hello ${user.name}` });
    });

    const res = await app.request('/protected');
    expect(res.status).toBe(200);

    const body: { message: string } = await res.json();
    expect(body.message).toBe('Hello User');
  });
});
