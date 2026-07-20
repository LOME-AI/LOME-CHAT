import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createEnvUtilities } from '@hushbox/shared';
import { deleteAccountRoute } from './delete-account.js';
import { createMockEmailClient, type MockEmailClient } from '../services/email/index.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

interface ApiResponse {
  code?: string;
  ke2?: number[];
  deleteAccountSessionId?: string;
  details?: { retryAfterSeconds?: number };
}

async function jsonBody<T = ApiResponse>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let mockEmailClient: MockEmailClient;

vi.mock('../services/email/index.js', async () => {
  const actual = await vi.importActual('../services/email/index.js');
  return {
    ...actual,
    getEmailClient: vi.fn(() => mockEmailClient),
  };
});

// Mock iron-session so the /finish handler can call session.destroy()
interface MockIronSession {
  userId?: string;
  sessionId?: string;
  destroy: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
}

let mockIronSession: MockIronSession;

function createDefaultIronSession(): MockIronSession {
  return {
    userId: 'test-user-id',
    sessionId: 'test-session-id',
    save: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(),
  };
}

mockIronSession = createDefaultIronSession();

vi.mock('iron-session', () => ({
  getIronSession: vi.fn(() => Promise.resolve(mockIronSession)),
}));

// Mock the OPAQUE step-up adapter — we test the route logic, not the OPAQUE math.
const startOpaqueStepUpMock = vi.fn();
const finishOpaqueStepUpMock = vi.fn();

vi.mock('../lib/opaque-step-up.js', () => ({
  startOpaqueStepUp: (args: unknown) => startOpaqueStepUpMock(args),
  finishOpaqueStepUp: (args: unknown) => finishOpaqueStepUpMock(args),
}));

// Mock the TOTP step-up helper — same reasoning.
const verifyTotpStepUpMock = vi.fn();

vi.mock('../lib/totp-step-up.js', () => ({
  verifyTotpStepUp: (args: unknown) => verifyTotpStepUpMock(args),
}));

// Mock the deletion saga so we can observe / control its outcome.
const deleteUserMock = vi.fn();

vi.mock('../services/account-deletion/delete-user.js', () => ({
  deleteUser: (args: unknown) => deleteUserMock(args),
}));

// Mock storage factory used by the route handler.
vi.mock('../services/storage/index.js', async () => {
  const actual = await vi.importActual('../services/storage/index.js');
  return {
    ...actual,
    getMediaStorage: vi.fn(() => ({
      put: vi.fn(),
      delete: vi.fn(),
      mintDownloadUrl: vi.fn(),
      list: vi.fn(),
    })),
  };
});

function createMockDb(): {
  whereImpl: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
} {
  const whereImpl = vi.fn().mockResolvedValue([]);
  const self = {
    whereImpl,
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn((...args: unknown[]) => whereImpl(...args)),
  };
  return self;
}

function createMockRedis(): {
  store: Map<string, unknown>;
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, unknown>();
  return {
    store,
    set: vi.fn().mockImplementation((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    del: vi.fn().mockImplementation((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    expire: vi.fn().mockResolvedValue(1),
  };
}

const TEST_MASTER_SECRET = 'test-master-secret-at-least-32-bytes-long-for-testing';
const TEST_SESSION_SECRET = 'test-session-secret-at-least-32-bytes';
const TEST_FRONTEND_URL = 'http://localhost:5173';

interface SessionOverrides {
  pending2FA?: boolean;
  totpEnabled?: boolean;
  userId?: string;
}

describe('delete-account routes', () => {
  let app: Hono<AppEnv>;
  let mockDb: ReturnType<typeof createMockDb>;
  let mockRedis: ReturnType<typeof createMockRedis>;
  let sessionOverrides: SessionOverrides;

  beforeEach(() => {
    mockDb = createMockDb();
    mockRedis = createMockRedis();
    mockEmailClient = createMockEmailClient();
    mockIronSession = createDefaultIronSession();
    sessionOverrides = {};
    startOpaqueStepUpMock.mockReset();
    finishOpaqueStepUpMock.mockReset();
    verifyTotpStepUpMock.mockReset();
    deleteUserMock.mockReset();

    app = new Hono<AppEnv>();

    app.use('*', async (c, next) => {
      c.env = {
        OPAQUE_MASTER_SECRET: TEST_MASTER_SECRET,
        IRON_SESSION_SECRET: TEST_SESSION_SECRET,
        FRONTEND_URL: TEST_FRONTEND_URL,
        DATABASE_URL: 'mock',
        NODE_ENV: 'development',
      } as AppEnv['Bindings'];
      c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
      c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
      c.set('envUtils', createEnvUtilities(c.env));
      const cookie = c.req.header('Cookie');
      if (cookie?.includes('hushbox_session=')) {
        const sessionData: SessionData = {
          sessionId: 'test-session-id',
          userId: sessionOverrides.userId ?? 'test-user-id',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: sessionOverrides.totpEnabled ?? false,
          hasAcknowledgedPhrase: false,
          pending2FA: sessionOverrides.pending2FA ?? false,
          pending2FAExpiresAt: sessionOverrides.pending2FA ? Date.now() + 60_000 : 0,
          createdAt: Date.now(),
        };
        c.set('sessionData', sessionData);
      }
      await next();
    });

    app.route('/api/auth/delete-account', deleteAccountRoute);
  });

  function withCookie(headers: Record<string, string> = {}): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Cookie: 'hushbox_session=test-session-value',
      ...headers,
    };
  }

  function stubUserRow(
    overrides: {
      totpEnabled?: boolean;
      totpSecretEncrypted?: Uint8Array | null;
    } = {}
  ): void {
    mockDb.whereImpl.mockResolvedValue([
      {
        id: 'test-user-id',
        email: 'test@example.com',
        username: 'test_user',
        opaqueRegistration: new Uint8Array([1, 2, 3, 4]),
        totpEnabled: overrides.totpEnabled ?? false,
        totpSecretEncrypted:
          overrides.totpSecretEncrypted === undefined ? null : overrides.totpSecretEncrypted,
      },
    ]);
  }

  describe('POST /api/auth/delete-account/init', () => {
    it('returns 401 when no session cookie is present', async () => {
      const res = await app.request('/api/auth/delete-account/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ke1: [1, 2, 3] }),
      });
      expect(res.status).toBe(401);
      const body = await jsonBody(res);
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 403 with 2FA_REQUIRED when the session is pending 2FA', async () => {
      sessionOverrides.pending2FA = true;
      sessionOverrides.totpEnabled = true;
      stubUserRow({ totpEnabled: true });

      const res = await app.request('/api/auth/delete-account/init', {
        method: 'POST',
        headers: withCookie(),
        body: JSON.stringify({ ke1: [1, 2, 3] }),
      });
      expect(res.status).toBe(403);
      const body = await jsonBody(res);
      expect(body.code).toBe('2FA_REQUIRED');
      expect(startOpaqueStepUpMock).not.toHaveBeenCalled();
    });

    it('returns 403 with DELETE_ACCOUNT_LOCKED when the account is locked out', async () => {
      mockRedis.store.set('delete-account:lockout:test-user-id', String(Date.now() + 60_000));
      stubUserRow();

      const res = await app.request('/api/auth/delete-account/init', {
        method: 'POST',
        headers: withCookie(),
        body: JSON.stringify({ ke1: [1, 2, 3] }),
      });
      expect(res.status).toBe(403);
      const body = await jsonBody(res);
      expect(body.code).toBe('DELETE_ACCOUNT_LOCKED');
      expect(startOpaqueStepUpMock).not.toHaveBeenCalled();
    });

    it('returns ke2 and the server-issued sessionId from the OPAQUE step-up helper', async () => {
      stubUserRow();
      const issuedSessionId = '00000000-0000-4000-8000-deadbeefdead';
      startOpaqueStepUpMock.mockResolvedValue({
        ke2: new Uint8Array([9, 8, 7]),
        sessionId: issuedSessionId,
      });

      const res = await app.request('/api/auth/delete-account/init', {
        method: 'POST',
        headers: withCookie(),
        body: JSON.stringify({ ke1: [1, 2, 3, 4] }),
      });
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.ke2).toEqual([9, 8, 7]);
      expect(body.deleteAccountSessionId).toBe(issuedSessionId);

      expect(startOpaqueStepUpMock).toHaveBeenCalledTimes(1);
      const args = startOpaqueStepUpMock.mock.calls[0]![0] as {
        userId: string;
        redisKeyName: string;
        username: string;
      };
      expect(args.userId).toBe('test-user-id');
      expect(args.username).toBe('test-user-id');
      expect(args.redisKeyName).toBe('opaquePendingDeleteAccount');
    });

    it('returns 500 when OPAQUE_MASTER_SECRET is missing', async () => {
      stubUserRow();
      const testApp = new Hono<AppEnv>();
      testApp.use('*', async (c, next) => {
        c.env = {
          IRON_SESSION_SECRET: TEST_SESSION_SECRET,
          FRONTEND_URL: TEST_FRONTEND_URL,
          DATABASE_URL: 'mock',
          NODE_ENV: 'development',
        } as AppEnv['Bindings'];
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
        c.set('envUtils', createEnvUtilities(c.env));
        const sessionData: SessionData = {
          sessionId: 'test-session-id',
          userId: 'test-user-id',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        };
        c.set('sessionData', sessionData);
        await next();
      });
      testApp.route('/api/auth/delete-account', deleteAccountRoute);

      const res = await testApp.request('/api/auth/delete-account/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ke1: [1, 2, 3] }),
      });
      expect(res.status).toBe(500);
      const body = await jsonBody(res);
      expect(body.code).toBe('SERVER_MISCONFIGURED');
    });

    it('returns 500 when the user row is missing from the DB', async () => {
      mockDb.whereImpl.mockResolvedValue([]);

      const res = await app.request('/api/auth/delete-account/init', {
        method: 'POST',
        headers: withCookie(),
        body: JSON.stringify({ ke1: [1, 2, 3] }),
      });
      expect(res.status).toBe(500);
      const body = await jsonBody(res);
      expect(body.code).toBe('USER_NOT_FOUND');
    });

    it('rejects malformed ke1 with 400', async () => {
      const res = await app.request('/api/auth/delete-account/init', {
        method: 'POST',
        headers: withCookie(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/delete-account/finish', () => {
    const DUMMY_SESSION_ID = '00000000-0000-4000-8000-cafebabecafe';

    function happyPathBody(
      overrides: {
        confirmationPhrase?: string;
        totpCode?: string;
        deleteAccountSessionId?: string;
      } = {}
    ): string {
      const body: Record<string, unknown> = {
        ke3: [1, 2, 3, 4],
        confirmationPhrase: overrides.confirmationPhrase ?? 'delete my account',
        deleteAccountSessionId: overrides.deleteAccountSessionId ?? DUMMY_SESSION_ID,
      };
      if (overrides.totpCode !== undefined) body['totpCode'] = overrides.totpCode;
      return JSON.stringify(body);
    }

    it('returns 401 when no session cookie is present', async () => {
      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: happyPathBody(),
      });
      expect(res.status).toBe(401);
      const body = await jsonBody(res);
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 403 with 2FA_REQUIRED when the session is pending 2FA', async () => {
      sessionOverrides.pending2FA = true;
      sessionOverrides.totpEnabled = true;

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody(),
      });
      expect(res.status).toBe(403);
      const body = await jsonBody(res);
      expect(body.code).toBe('2FA_REQUIRED');
      expect(finishOpaqueStepUpMock).not.toHaveBeenCalled();
    });

    it('returns 403 with DELETE_ACCOUNT_LOCKED when the account is locked out', async () => {
      mockRedis.store.set('delete-account:lockout:test-user-id', String(Date.now() + 60_000));

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody(),
      });
      expect(res.status).toBe(403);
      const body = await jsonBody(res);
      expect(body.code).toBe('DELETE_ACCOUNT_LOCKED');
      expect(finishOpaqueStepUpMock).not.toHaveBeenCalled();
    });

    it('rejects empty confirmation phrase with INVALID_CONFIRMATION_PHRASE', async () => {
      stubUserRow();
      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody({ confirmationPhrase: '' }),
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('INVALID_CONFIRMATION_PHRASE');
      expect(finishOpaqueStepUpMock).not.toHaveBeenCalled();
    });

    it('rejects wrong confirmation phrase with INVALID_CONFIRMATION_PHRASE', async () => {
      stubUserRow();
      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody({ confirmationPhrase: 'delete me' }),
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('INVALID_CONFIRMATION_PHRASE');
      expect(finishOpaqueStepUpMock).not.toHaveBeenCalled();
    });

    it('accepts case-insensitive, whitespace-padded confirmation phrase', async () => {
      stubUserRow();
      finishOpaqueStepUpMock.mockResolvedValue({ ok: true });
      deleteUserMock.mockResolvedValue({ ok: true });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody({ confirmationPhrase: '   Delete My Account   ' }),
      });
      expect(res.status).toBe(204);
    });

    it('rejects bad OPAQUE proof with INCORRECT_PASSWORD and records a failed attempt', async () => {
      stubUserRow();
      finishOpaqueStepUpMock.mockResolvedValue({ ok: false, reason: 'bad-proof' });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody(),
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('INCORRECT_PASSWORD');
      expect(mockRedis.store.get('delete-account:user:ratelimit:test-user-id')).toBeDefined();
    });

    it('rejects expired OPAQUE state with NO_PENDING_DELETE_ACCOUNT without incrementing rate limit', async () => {
      stubUserRow();
      finishOpaqueStepUpMock.mockResolvedValue({ ok: false, reason: 'no-pending' });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody(),
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('NO_PENDING_DELETE_ACCOUNT');
      expect(mockRedis.store.get('delete-account:user:ratelimit:test-user-id')).toBeUndefined();
    });

    it('returns TOTP_CODE_REQUIRED (not INVALID_TOTP_CODE) when totpCode is missing — no failed-attempt recorded', async () => {
      sessionOverrides.totpEnabled = true;
      stubUserRow({ totpEnabled: true, totpSecretEncrypted: new Uint8Array([5, 5]) });
      finishOpaqueStepUpMock.mockResolvedValue({ ok: true });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody(),
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('TOTP_CODE_REQUIRED');
      expect(verifyTotpStepUpMock).not.toHaveBeenCalled();
      expect(mockRedis.store.get('delete-account:user:ratelimit:test-user-id')).toBeUndefined();
    });

    it('rejects bad TOTP code with INVALID_TOTP_CODE and records a failed attempt', async () => {
      sessionOverrides.totpEnabled = true;
      stubUserRow({ totpEnabled: true, totpSecretEncrypted: new Uint8Array([5, 5]) });
      finishOpaqueStepUpMock.mockResolvedValue({ ok: true });
      verifyTotpStepUpMock.mockResolvedValue({ ok: false, reason: 'invalid-code' });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody({ totpCode: '000000' }),
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('INVALID_TOTP_CODE');
      expect(mockRedis.store.get('delete-account:user:ratelimit:test-user-id')).toBeDefined();
    });

    it('happy path with TOTP enabled: TOTP verified, saga run, 204', async () => {
      sessionOverrides.totpEnabled = true;
      stubUserRow({ totpEnabled: true, totpSecretEncrypted: new Uint8Array([5, 5]) });
      finishOpaqueStepUpMock.mockResolvedValue({ ok: true });
      verifyTotpStepUpMock.mockResolvedValue({ ok: true });
      deleteUserMock.mockResolvedValue({ ok: true });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody({ totpCode: '123456' }),
      });
      expect(res.status).toBe(204);
      expect(verifyTotpStepUpMock).toHaveBeenCalledTimes(1);
      expect(deleteUserMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT require totpCode when the user has TOTP disabled', async () => {
      stubUserRow({ totpEnabled: false });
      finishOpaqueStepUpMock.mockResolvedValue({ ok: true });
      deleteUserMock.mockResolvedValue({ ok: true });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody(),
      });
      expect(res.status).toBe(204);
      expect(verifyTotpStepUpMock).not.toHaveBeenCalled();
    });

    it('locks out on the 3rd consecutive failed attempt and rejects subsequent calls', async () => {
      stubUserRow();
      finishOpaqueStepUpMock.mockResolvedValue({ ok: false, reason: 'bad-proof' });

      for (let index = 0; index < 3; index++) {
        await app.request('/api/auth/delete-account/finish', {
          method: 'POST',
          headers: withCookie(),
          body: happyPathBody(),
        });
      }

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody(),
      });
      expect(res.status).toBe(403);
      const body = await jsonBody(res);
      expect(body.code).toBe('DELETE_ACCOUNT_LOCKED');
    });

    it('the triggering failed attempt itself surfaces DELETE_ACCOUNT_LOCKED with retryAfterSeconds', async () => {
      stubUserRow();
      finishOpaqueStepUpMock.mockResolvedValue({ ok: false, reason: 'bad-proof' });

      // First two failures return INCORRECT_PASSWORD (under cap).
      for (let index = 0; index < 2; index++) {
        const res = await app.request('/api/auth/delete-account/finish', {
          method: 'POST',
          headers: withCookie(),
          body: happyPathBody(),
        });
        expect(res.status).toBe(400);
        const body = await jsonBody(res);
        expect(body.code).toBe('INCORRECT_PASSWORD');
      }

      // The 3rd failure triggers the lockout, so it should surface DELETE_ACCOUNT_LOCKED
      // immediately (not INCORRECT_PASSWORD — otherwise the user must retry once to learn).
      const trigger = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody(),
      });
      expect(trigger.status).toBe(403);
      const triggerBody = await jsonBody(trigger);
      expect(triggerBody.code).toBe('DELETE_ACCOUNT_LOCKED');
      expect(triggerBody.details?.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('the triggering bad-TOTP attempt surfaces DELETE_ACCOUNT_LOCKED with retryAfterSeconds', async () => {
      sessionOverrides.totpEnabled = true;
      stubUserRow({ totpEnabled: true, totpSecretEncrypted: new Uint8Array([5, 5]) });
      finishOpaqueStepUpMock.mockResolvedValue({ ok: true });
      verifyTotpStepUpMock.mockResolvedValue({ ok: false, reason: 'invalid-code' });

      for (let index = 0; index < 2; index++) {
        await app.request('/api/auth/delete-account/finish', {
          method: 'POST',
          headers: withCookie(),
          body: happyPathBody({ totpCode: '000000' }),
        });
      }
      const trigger = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody({ totpCode: '000000' }),
      });
      expect(trigger.status).toBe(403);
      const body = await jsonBody(trigger);
      expect(body.code).toBe('DELETE_ACCOUNT_LOCKED');
      expect(body.details?.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('rejects ke3 array exceeding the max length cap', async () => {
      const oversizedKe3 = Array.from({ length: 2000 }, (_, index) => index);
      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: JSON.stringify({
          ke3: oversizedKe3,
          confirmationPhrase: 'delete my account',
        }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects confirmationPhrase exceeding the max length cap at validation (before phrase check)', async () => {
      stubUserRow();
      // Build an over-cap input that would otherwise PASS the phrase check
      // (so a missing cap would surface as INVALID_CONFIRMATION_PHRASE+400 — wrong-reason 400).
      const padded = ' '.repeat(300) + 'delete my account' + ' '.repeat(300);
      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: JSON.stringify({ ke3: [1, 2, 3], confirmationPhrase: padded }),
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).not.toBe('INVALID_CONFIRMATION_PHRASE');
      expect(finishOpaqueStepUpMock).not.toHaveBeenCalled();
    });

    it('logs the saga error via console.error when the saga throws', async () => {
      stubUserRow();
      finishOpaqueStepUpMock.mockResolvedValue({ ok: true });
      const sagaError = new Error('db blew up');
      deleteUserMock.mockRejectedValue(sagaError);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
        // suppress
      });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody(),
      });
      expect(res.status).toBe(500);
      expect(errSpy).toHaveBeenCalled();
      const call = errSpy.mock.calls.find((c) =>
        typeof c[0] === 'string' ? c[0].includes('delete-account') : false
      );
      expect(call).toBeDefined();
    });

    it('happy path: calls the saga, clears the session, returns 204', async () => {
      stubUserRow();
      finishOpaqueStepUpMock.mockResolvedValue({ ok: true });
      deleteUserMock.mockResolvedValue({ ok: true });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie({
          'cf-connecting-ip': '203.0.113.5',
          'user-agent': 'curl/8',
        }),
        body: happyPathBody(),
      });
      expect(res.status).toBe(204);

      expect(deleteUserMock).toHaveBeenCalledTimes(1);
      const sagaArgs = deleteUserMock.mock.calls[0]![0] as {
        userId: string;
        ipAddress: string | null;
        userAgent: string | null;
      };
      expect(sagaArgs.userId).toBe('test-user-id');
      expect(sagaArgs.ipAddress).toBe('203.0.113.5');
      expect(sagaArgs.userAgent).toBe('curl/8');
      expect(mockIronSession.destroy).toHaveBeenCalledTimes(1);
    });

    it('saga returns user-not-found: still 204 (concurrent delete is success state)', async () => {
      stubUserRow();
      finishOpaqueStepUpMock.mockResolvedValue({ ok: true });
      deleteUserMock.mockResolvedValue({ ok: false, reason: 'user-not-found' });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody(),
      });
      expect(res.status).toBe(204);
      expect(mockIronSession.destroy).toHaveBeenCalledTimes(1);
    });

    it('saga throws: returns 500, session NOT cleared', async () => {
      stubUserRow();
      finishOpaqueStepUpMock.mockResolvedValue({ ok: true });
      deleteUserMock.mockRejectedValue(new Error('db blew up'));

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody(),
      });
      expect(res.status).toBe(500);
      expect(mockIronSession.destroy).not.toHaveBeenCalled();
    });

    it('gate order: phrase check runs BEFORE OPAQUE step-up', async () => {
      stubUserRow();
      finishOpaqueStepUpMock.mockResolvedValue({ ok: true });
      deleteUserMock.mockResolvedValue({ ok: true });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody({ confirmationPhrase: 'nope' }),
      });
      expect(res.status).toBe(400);
      expect(finishOpaqueStepUpMock).not.toHaveBeenCalled();
      expect(deleteUserMock).not.toHaveBeenCalled();
    });

    it('gate order: OPAQUE runs BEFORE TOTP', async () => {
      sessionOverrides.totpEnabled = true;
      stubUserRow({ totpEnabled: true, totpSecretEncrypted: new Uint8Array([5, 5]) });
      finishOpaqueStepUpMock.mockResolvedValue({ ok: false, reason: 'bad-proof' });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody({ totpCode: '111111' }),
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('INCORRECT_PASSWORD');
      expect(verifyTotpStepUpMock).not.toHaveBeenCalled();
      expect(deleteUserMock).not.toHaveBeenCalled();
    });

    it('gate order: TOTP runs BEFORE saga', async () => {
      sessionOverrides.totpEnabled = true;
      stubUserRow({ totpEnabled: true, totpSecretEncrypted: new Uint8Array([5, 5]) });
      finishOpaqueStepUpMock.mockResolvedValue({ ok: true });
      verifyTotpStepUpMock.mockResolvedValue({ ok: false, reason: 'invalid-code' });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody({ totpCode: '222222' }),
      });
      expect(res.status).toBe(400);
      expect(deleteUserMock).not.toHaveBeenCalled();
    });

    it('returns 500 when OPAQUE_MASTER_SECRET is missing', async () => {
      stubUserRow();
      const testApp = new Hono<AppEnv>();
      testApp.use('*', async (c, next) => {
        c.env = {
          IRON_SESSION_SECRET: TEST_SESSION_SECRET,
          FRONTEND_URL: TEST_FRONTEND_URL,
          DATABASE_URL: 'mock',
          NODE_ENV: 'development',
        } as AppEnv['Bindings'];
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
        c.set('envUtils', createEnvUtilities(c.env));
        const sessionData: SessionData = {
          sessionId: 'test-session-id',
          userId: 'test-user-id',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        };
        c.set('sessionData', sessionData);
        await next();
      });
      testApp.route('/api/auth/delete-account', deleteAccountRoute);

      const res = await testApp.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: happyPathBody(),
      });
      expect(res.status).toBe(500);
      const body = await jsonBody(res);
      expect(body.code).toBe('SERVER_MISCONFIGURED');
    });

    it('handles missing cf-connecting-ip and user-agent headers (passes nulls to saga)', async () => {
      stubUserRow();
      finishOpaqueStepUpMock.mockResolvedValue({ ok: true });
      deleteUserMock.mockResolvedValue({ ok: true });

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody(),
      });
      expect(res.status).toBe(204);
      const args = deleteUserMock.mock.calls[0]![0] as {
        ipAddress: string | null;
        userAgent: string | null;
      };
      expect(args.ipAddress).toBeNull();
      // user-agent will be set by Hono's request stack in some environments; allow either
      // explicit null or a non-empty string but never undefined.
      expect(args.userAgent === null || typeof args.userAgent === 'string').toBe(true);
    });

    it('returns 500 USER_NOT_FOUND when the user row is missing on /finish', async () => {
      mockDb.whereImpl.mockResolvedValue([]);

      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: happyPathBody(),
      });
      expect(res.status).toBe(500);
      const body = await jsonBody(res);
      expect(body.code).toBe('USER_NOT_FOUND');
      expect(finishOpaqueStepUpMock).not.toHaveBeenCalled();
    });

    it('rejects malformed request body with 400', async () => {
      const res = await app.request('/api/auth/delete-account/finish', {
        method: 'POST',
        headers: withCookie(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });
});
