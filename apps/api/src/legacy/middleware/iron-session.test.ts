import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createIronSessionMiddleware } from './iron-session.js';
import type { SessionData } from '../lib/session.js';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// Mock iron-session since we can't create real encrypted cookies in tests
vi.mock('iron-session', () => ({
  getIronSession: vi.fn(),
}));

import { getIronSession } from 'iron-session';

const mockGetIronSession = vi.mocked(getIronSession);

interface TestEnv {
  Bindings: {
    IRON_SESSION_SECRET: string;
    NODE_ENV: string;
  };
  Variables: {
    sessionData: SessionData | null;
  };
}

describe('iron-session middleware', () => {
  const testSecret = 'test-secret-at-least-32-characters-long';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createApp(): Hono<TestEnv> {
    const app = new Hono<TestEnv>();

    app.use('*', async (c, next) => {
      c.env = {
        IRON_SESSION_SECRET: testSecret,
        NODE_ENV: 'development',
      };
      await next();
    });

    app.use('*', createIronSessionMiddleware());

    app.get('/test', (c) => {
      const sessionData = c.get('sessionData');
      return c.json({ sessionData });
    });

    return app;
  }

  it('returns a middleware function', () => {
    const middleware = createIronSessionMiddleware();

    expect(middleware).toBeDefined();
    expect(typeof middleware).toBe('function');
  });

  it('sets sessionData to null when no session exists', async () => {
    mockGetIronSession.mockResolvedValue({} as Awaited<ReturnType<typeof getIronSession>>);

    const app = createApp();
    const res = await app.request('/test');
    const body = await jsonBody<{ sessionData: unknown }>(res);

    expect(body.sessionData).toBeNull();
  });

  it('sets sessionData when valid session exists', async () => {
    const mockSessionData: SessionData = {
      sessionId: 'test-session-id',
      userId: 'user-123',
      email: 'test@example.com',
      username: 'test_user',
      emailVerified: true,
      totpEnabled: false,
      hasAcknowledgedPhrase: true,
      pending2FA: false,
      pending2FAExpiresAt: 0,
      createdAt: Date.now(),
    };

    mockGetIronSession.mockResolvedValue(
      mockSessionData as unknown as Awaited<ReturnType<typeof getIronSession>>
    );

    const app = createApp();
    const res = await app.request('/test');
    const body = await jsonBody<{ sessionData: unknown }>(res);

    expect(body.sessionData).toEqual(mockSessionData);
  });

  it('sets sessionData to null when session is missing userId', async () => {
    // Session without userId is considered invalid
    mockGetIronSession.mockResolvedValue({
      email: 'test@example.com',
    } as unknown as Awaited<ReturnType<typeof getIronSession>>);

    const app = createApp();
    const res = await app.request('/test');
    const body = await jsonBody<{ sessionData: unknown }>(res);

    expect(body.sessionData).toBeNull();
  });

  it('calls getIronSession with correct options', async () => {
    mockGetIronSession.mockResolvedValue({} as Awaited<ReturnType<typeof getIronSession>>);

    const app = createApp();
    await app.request('/test');

    expect(mockGetIronSession).toHaveBeenCalledTimes(1);
    expect(mockGetIronSession).toHaveBeenCalledWith(
      expect.anything(), // request
      expect.anything(), // response
      expect.objectContaining({
        password: testSecret,
        cookieName: 'hushbox_session',
      })
    );
  });

  it('uses lax sameSite and non-secure cookies in development', async () => {
    mockGetIronSession.mockResolvedValue({} as Awaited<ReturnType<typeof getIronSession>>);

    const app = createApp();
    await app.request('/test');

    expect(mockGetIronSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        cookieOptions: expect.objectContaining({
          secure: false,
          sameSite: 'lax',
        }),
      })
    );
  });

  it('uses none sameSite and secure cookies in production', async () => {
    mockGetIronSession.mockResolvedValue({} as Awaited<ReturnType<typeof getIronSession>>);

    const productionApp = new Hono<TestEnv>();
    productionApp.use('*', async (c, next) => {
      c.env = {
        IRON_SESSION_SECRET: testSecret,
        NODE_ENV: 'production',
      };
      await next();
    });
    productionApp.use('*', createIronSessionMiddleware());
    productionApp.get('/test', (c) => c.json({ ok: true }));

    await productionApp.request('/test');

    expect(mockGetIronSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        cookieOptions: expect.objectContaining({
          secure: true,
          sameSite: 'none',
        }),
      })
    );
  });

  it('allows subsequent handlers to access session', async () => {
    const mockSessionData: SessionData = {
      sessionId: 'test-session-id',
      userId: 'user-456',
      email: 'user@example.com',
      username: 'user_456',
      emailVerified: true,
      totpEnabled: true,
      hasAcknowledgedPhrase: false,
      pending2FA: false,
      pending2FAExpiresAt: 0,
      createdAt: Date.now(),
    };

    mockGetIronSession.mockResolvedValue(
      mockSessionData as unknown as Awaited<ReturnType<typeof getIronSession>>
    );

    const app = new Hono<TestEnv>();
    app.use('*', async (c, next) => {
      c.env = {
        IRON_SESSION_SECRET: testSecret,
        NODE_ENV: 'development',
      };
      await next();
    });
    app.use('*', createIronSessionMiddleware());
    app.get('/protected', (c) => {
      const session = c.get('sessionData');
      if (!session) {
        return c.json({ error: 'Not authenticated' }, 401);
      }
      return c.json({ message: `Hello ${String(session.email)}` });
    });

    const res = await app.request('/protected');
    expect(res.status).toBe(200);

    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toBe('Hello user@example.com');
  });

  it('sets sessionData to null when IRON_SESSION_SECRET is not configured', async () => {
    const app = new Hono<{
      Bindings: { IRON_SESSION_SECRET?: string; NODE_ENV?: string };
      Variables: { sessionData: SessionData | null };
    }>();

    app.use('*', async (c, next) => {
      // Omit IRON_SESSION_SECRET to test missing secret case
      c.env = {
        NODE_ENV: 'development',
      };
      await next();
    });
    app.use('*', createIronSessionMiddleware());
    app.get('/test', (c) => {
      const sessionData = c.get('sessionData');
      return c.json({ sessionData });
    });

    const res = await app.request('/test');
    const body = await jsonBody<{ sessionData: unknown }>(res);

    expect(body.sessionData).toBeNull();
    // Should not call getIronSession when no secret
    expect(mockGetIronSession).not.toHaveBeenCalled();
  });

  it('sets sessionData to null when session is null', async () => {
    mockGetIronSession.mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof getIronSession>>
    );

    const app = createApp();
    const res = await app.request('/test');
    const body = await jsonBody<{ sessionData: unknown }>(res);

    expect(body.sessionData).toBeNull();
  });
});
