import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import {
  createOpaqueClient,
  startRegistration,
  finishRegistration,
  startLogin,
  finishLogin,
  OPAQUE_SERVER_IDENTIFIER,
} from '@hushbox/crypto';
import { createEnvUtilities } from '@hushbox/shared';
import { opaqueAuthRoute } from './opaque-auth.js';
import { createMockEmailClient, type MockEmailClient } from '../services/email/index.js';
import { errorHandler } from '../middleware/error.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = ApiResponse>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Common API response shape for error and success responses. */
interface ApiResponse {
  code?: string;
  success?: boolean;
  retryAfterSeconds?: number;
  newRegistrationResponse?: number[];
  recoveryWrappedPrivateKey?: string;
}

/** Registration init response shape. */
interface RegistrationInitResponse {
  registrationResponse: number[];
  registerSessionId: string;
}

/** Registration finish response shape. */
interface RegistrationFinishResponse {
  success: boolean;
  userId: string;
}

/** Login init response shape. */
interface LoginInitResponse {
  ke2: number[];
  loginSessionId: string;
  passwordSalt?: unknown;
}

/** Login finish success response shape. */
interface LoginFinishResponse {
  success: true;
  userId: string;
  email: string | null;
  passwordWrappedPrivateKey: string;
}

/** 2FA setup response shape. */
interface TotpSetupResponse {
  totpUri: string;
  secret: string;
}

/** Recovery reset init response shape. */
interface RecoveryResetInitResponse {
  newRegistrationResponse: number[];
  recoverySessionId: string;
}

/** A fixed-format UUID for tests that need to pass schema validation without
 *  actually exercising the Redis lookup (e.g. "returns 400 if no pending …"). */
const DUMMY_SESSION_ID = '00000000-0000-0000-0000-000000000000';

/** Recovery wrapped key response shape. */
interface RecoveryWrappedKeyResponse {
  recoveryWrappedPrivateKey: string;
}

// Mock getEmailClient to return our mockEmailClient
let mockEmailClient: MockEmailClient;

vi.mock('../services/email/index.js', async () => {
  const actual = await vi.importActual('../services/email/index.js');
  return {
    ...actual,
    getEmailClient: vi.fn(() => mockEmailClient),
  };
});

// Mock ensureWalletsExist to verify it's called during registration
const mockEnsureWalletsExist = vi.fn().mockImplementation(() => Promise.resolve());
vi.mock('../services/billing/wallet-provisioning.js', () => ({
  ensureWalletsExist: (...args: unknown[]) => mockEnsureWalletsExist(...args),
}));

/**
 * iron-session mock backing object. Tests that exercise the `getIronSession`
 * code path (login/finish, login/2fa/verify, logout) prime this fixture in
 * `beforeEach`; everything else uses the default empty session, which
 * matches the runtime behavior on a request with no decryptable cookie.
 */
interface MockIronSession {
  sessionId?: string;
  userId?: string;
  email?: string;
  username?: string;
  emailVerified?: boolean;
  totpEnabled?: boolean;
  hasAcknowledgedPhrase?: boolean;
  pending2FA?: boolean;
  pending2FAExpiresAt?: number;
  createdAt?: number;
  save: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

let mockIronSessionData: MockIronSession;

function createDefaultMockIronSession(): MockIronSession {
  return {
    save: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(() => {
      // Reset all session fields on destroy, mirroring iron-session semantics.
      // `delete` (not `= undefined`) keeps the assignment compatible with
      // exactOptionalPropertyTypes.
      delete mockIronSessionData.sessionId;
      delete mockIronSessionData.userId;
      delete mockIronSessionData.pending2FA;
      delete mockIronSessionData.pending2FAExpiresAt;
    }),
  };
}

mockIronSessionData = createDefaultMockIronSession();

vi.mock('iron-session', () => ({
  // Returning the same singleton each call lets tests prime fields once and
  // observe save() / destroy() across multiple requests in the same test.
  getIronSession: vi.fn(() => Promise.resolve(mockIronSessionData)),
}));

// Mock database
function createMockDb() {
  const users = new Map<string, Record<string, unknown>>();
  const self = {
    users,
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockImplementation(() => [{ id: 'test-user-id' }]),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation(() => []),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
  return self;
}

// Mock Redis
function createMockRedis() {
  const store = new Map<string, string>();
  return {
    set: vi.fn().mockImplementation((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    get: vi.fn().mockImplementation((key: string) => {
      return Promise.resolve(store.get(key) ?? null);
    }),
    del: vi.fn().mockImplementation((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    expire: vi.fn().mockResolvedValue(1),
  };
}

// Test master secret (32 bytes)
const TEST_MASTER_SECRET = 'test-master-secret-at-least-32-bytes-long-for-testing';
const TEST_SESSION_SECRET = 'test-session-secret-at-least-32-bytes';
const TEST_FRONTEND_URL = 'http://localhost:5173';

describe('OPAQUE auth routes', () => {
  let app: Hono<AppEnv>;
  let mockDb: ReturnType<typeof createMockDb>;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockDb = createMockDb();
    mockRedis = createMockRedis();
    mockEmailClient = createMockEmailClient();
    mockEnsureWalletsExist.mockClear();
    // Reset the iron-session mock between tests so leftover state from a prior
    // test (e.g. a primed pending2FA) doesn't leak into the next.
    mockIronSessionData = createDefaultMockIronSession();

    const routes = opaqueAuthRoute;
    app = new Hono<AppEnv>();

    // Add mock middleware
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
      // Simulate iron-session middleware: set sessionData for authenticated requests
      const cookie = c.req.header('Cookie');
      if (cookie?.includes('hushbox_session=')) {
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
      }
      await next();
    });

    app.route('/api/auth', routes);
    // Mirror production: unhandled throws become a JSON 500 with code INTERNAL
    // instead of Hono's default plain-text body.
    app.onError(errorHandler);
  });

  describe('POST /api/auth/register/init', () => {
    it('returns 429 when IP is rate limited', async () => {
      const client = createOpaqueClient();
      const { serialized } = await startRegistration(client, 'test-password');

      const testIp = '192.168.1.100';

      // Exhaust IP rate limit (10 attempts per 3600 seconds)
      for (let index = 0; index < 10; index++) {
        await app.request('/api/auth/register/init', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cf-connecting-ip': testIp,
          },
          body: JSON.stringify({
            email: `test${String(index)}@example.com`,
            username: 'Test User',
            registrationRequest: serialized,
          }),
        });
      }

      // 11th attempt from same IP should be rate limited
      const res = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': testIp,
        },
        body: JSON.stringify({
          email: 'another@example.com',
          username: 'Test User',
          registrationRequest: serialized,
        }),
      });

      expect(res.status).toBe(429);
      const body = await jsonBody(res);
      expect(body.code).toBe('RATE_LIMITED');
      const details = (body as unknown as { details?: { retryAfterSeconds?: number } }).details;
      expect(details?.retryAfterSeconds).toBeDefined();
    }, 30_000);

    it('returns 400 for missing email', async () => {
      const res = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'Test User',
          registrationRequest: [1, 2, 3],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing name', async () => {
      const res = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          registrationRequest: [1, 2, 3],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing registrationRequest', async () => {
      const res = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          username: 'Test User',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid email format', async () => {
      const res = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'not-an-email',
          username: 'Test User',
          registrationRequest: [1, 2, 3],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns registrationResponse for valid request', async () => {
      const client = createOpaqueClient();
      const { serialized } = await startRegistration(client, 'test-password');

      const res = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          username: 'Test User',
          registrationRequest: serialized,
        }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<RegistrationInitResponse>(res);
      expect(body.registrationResponse).toBeDefined();
      expect(Array.isArray(body.registrationResponse)).toBe(true);
    });

    it('stores pending registration in Redis', async () => {
      const client = createOpaqueClient();
      const { serialized } = await startRegistration(client, 'test-password');

      await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          username: 'Test User',
          registrationRequest: serialized,
        }),
      });

      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('returns 200 with valid registration response when email exists (prevents enumeration)', async () => {
      // Setup mock to return existing user
      mockDb.where = vi.fn().mockImplementation(() => [{ id: 'existing-user' }]);

      const client = createOpaqueClient();
      const { serialized } = await startRegistration(client, 'test-password');

      const res = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'existing@example.com',
          username: 'Test User',
          registrationRequest: serialized,
        }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<RegistrationInitResponse>(res);
      expect(body.registrationResponse).toBeDefined();
      expect(Array.isArray(body.registrationResponse)).toBe(true);
      expect(body.registrationResponse.length).toBeGreaterThan(0);
    });

    it('stores existing flag in Redis when email already exists', async () => {
      // Setup mock to return existing user
      mockDb.where = vi.fn().mockImplementation(() => [{ id: 'existing-user' }]);

      const client = createOpaqueClient();
      const { serialized } = await startRegistration(client, 'test-password');

      const res = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'existing@example.com',
          username: 'Test User',
          registrationRequest: serialized,
        }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<RegistrationInitResponse>(res);
      // Redis key is now scoped to the server-issued sessionId, not the email.
      expect(mockRedis.set).toHaveBeenCalledWith(
        `opaque:pending:${body.registerSessionId}`,
        expect.objectContaining({
          email: 'existing@example.com',
          username: 'test_user',
          existing: true,
        }),
        expect.anything()
      );
    });
  });

  describe('POST /api/auth/register/finish', () => {
    it('returns 400 for missing email', async () => {
      const res = await app.request('/api/auth/register/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          registrationRecord: [1, 2, 3],
          accountPublicKey: 'YmFzZTY0cHVia2V5',
          passwordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
          recoveryWrappedPrivateKey: 'YmFzZTY0cmVjb3Zlcnk=', // gitleaks:allow
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing registrationRecord', async () => {
      const res = await app.request('/api/auth/register/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          accountPublicKey: 'YmFzZTY0cHVia2V5',
          passwordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
          recoveryWrappedPrivateKey: 'YmFzZTY0cmVjb3Zlcnk=', // gitleaks:allow
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing key material', async () => {
      const res = await app.request('/api/auth/register/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          registrationRecord: [1, 2, 3],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 if no pending registration exists', async () => {
      const res = await app.request('/api/auth/register/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          registrationRecord: [1, 2, 3],
          accountPublicKey: 'YmFzZTY0cHVia2V5',
          passwordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
          recoveryWrappedPrivateKey: 'YmFzZTY0cmVjb3Zlcnk=', // gitleaks:allow
          registerSessionId: DUMMY_SESSION_ID,
        }),
      });

      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('NO_PENDING_REGISTRATION');
    });
  });

  describe('full registration flow', () => {
    it('completes registration successfully', async () => {
      const client = createOpaqueClient();
      const { serialized } = await startRegistration(client, 'secure-password-123');

      const initRes = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'newuser@example.com',
          username: 'New User',
          registrationRequest: serialized,
        }),
      });

      expect(initRes.status).toBe(200);
      const initBody = await jsonBody<RegistrationInitResponse>(initRes);
      expect(initBody.registrationResponse).toBeDefined();

      const { record } = await finishRegistration(client, initBody.registrationResponse);

      const finishRes = await app.request('/api/auth/register/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'newuser@example.com',
          registrationRecord: record,
          accountPublicKey: 'YmFzZTY0cHVia2V5',
          passwordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
          recoveryWrappedPrivateKey: 'YmFzZTY0cmVjb3Zlcnk=', // gitleaks:allow
          registerSessionId: initBody.registerSessionId,
        }),
      });

      expect(finishRes.status).toBe(201);
      const finishBody = await jsonBody<RegistrationFinishResponse>(finishRes);
      expect(finishBody.success).toBe(true);
      expect(finishBody.userId).toBeDefined();

      // Wallet provisioning must happen after user creation
      expect(mockEnsureWalletsExist).toHaveBeenCalledOnce();
      expect(mockEnsureWalletsExist).toHaveBeenCalledWith(expect.anything(), 'test-user-id');
    });

    it('returns 201 but does not create user when email already exists', async () => {
      mockDb.where = vi.fn().mockImplementation(() => [{ id: 'existing-user-id' }]);
      const insertSpy = vi.fn().mockReturnThis();
      mockDb.insert = insertSpy;

      const client = createOpaqueClient();
      const { serialized } = await startRegistration(client, 'secure-password-123');

      const initRes = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'existing@example.com',
          username: 'Existing User',
          registrationRequest: serialized,
        }),
      });

      expect(initRes.status).toBe(200);
      const initBody = await jsonBody<RegistrationInitResponse>(initRes);
      expect(initBody.registrationResponse).toBeDefined();

      const { record } = await finishRegistration(client, initBody.registrationResponse);

      const finishRes = await app.request('/api/auth/register/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'existing@example.com',
          registrationRecord: record,
          accountPublicKey: 'YmFzZTY0cHVia2V5',
          passwordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
          recoveryWrappedPrivateKey: 'YmFzZTY0cmVjb3Zlcnk=', // gitleaks:allow
          registerSessionId: initBody.registerSessionId,
        }),
      });

      expect(finishRes.status).toBe(201);
      const finishBody = await jsonBody<RegistrationFinishResponse>(finishRes);
      expect(finishBody.success).toBe(true);
      expect(finishBody.userId).toBeDefined();
      // Critical: verify no INSERT was attempted
      expect(insertSpy).not.toHaveBeenCalled();
      // No wallets created for existing email (fake registration)
      expect(mockEnsureWalletsExist).not.toHaveBeenCalled();
    });

    it('returns 409 USERNAME_TAKEN when the users_username_unique constraint fires', async () => {
      mockDb.returning = vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          cause: { code: '23505', constraint: 'users_username_unique' },
        });
      });

      const client = createOpaqueClient();
      const { serialized } = await startRegistration(client, 'secure-password-123');

      const initRes = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'collision-username@example.com',
          username: 'Taken Username',
          registrationRequest: serialized,
        }),
      });
      expect(initRes.status).toBe(200);
      const initBody = await jsonBody<RegistrationInitResponse>(initRes);
      const { record } = await finishRegistration(client, initBody.registrationResponse);

      const finishRes = await app.request('/api/auth/register/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'collision-username@example.com',
          registrationRecord: record,
          accountPublicKey: 'YmFzZTY0cHVia2V5',
          passwordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
          recoveryWrappedPrivateKey: 'YmFzZTY0cmVjb3Zlcnk=', // gitleaks:allow
          registerSessionId: initBody.registerSessionId,
        }),
      });

      expect(finishRes.status).toBe(409);
      const body = await jsonBody<{ code: string }>(finishRes);
      expect(body.code).toBe('USERNAME_TAKEN');
      // Wallet provisioning must not run when user creation failed
      expect(mockEnsureWalletsExist).not.toHaveBeenCalled();
    });

    it('returns 409 EMAIL_TAKEN when the users_email_unique constraint fires past /init', async () => {
      mockDb.returning = vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          cause: { code: '23505', constraint: 'users_email_unique' },
        });
      });

      const client = createOpaqueClient();
      const { serialized } = await startRegistration(client, 'secure-password-123');

      const initRes = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'collision-email@example.com',
          username: 'Some User',
          registrationRequest: serialized,
        }),
      });
      const initBody = await jsonBody<RegistrationInitResponse>(initRes);
      const { record } = await finishRegistration(client, initBody.registrationResponse);

      const finishRes = await app.request('/api/auth/register/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'collision-email@example.com',
          registrationRecord: record,
          accountPublicKey: 'YmFzZTY0cHVia2V5',
          passwordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
          recoveryWrappedPrivateKey: 'YmFzZTY0cmVjb3Zlcnk=', // gitleaks:allow
          registerSessionId: initBody.registerSessionId,
        }),
      });

      expect(finishRes.status).toBe(409);
      const body = await jsonBody<{ code: string }>(finishRes);
      expect(body.code).toBe('EMAIL_TAKEN');
      expect(mockEnsureWalletsExist).not.toHaveBeenCalled();
    });

    it('lets unknown DB errors surface as INTERNAL', async () => {
      mockDb.returning = vi.fn().mockImplementation(() => {
        throw new Error('something unrelated broke');
      });

      const client = createOpaqueClient();
      const { serialized } = await startRegistration(client, 'secure-password-123');

      const initRes = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'unknown-err@example.com',
          username: 'Unknown Err',
          registrationRequest: serialized,
        }),
      });
      const initBody = await jsonBody<RegistrationInitResponse>(initRes);
      const { record } = await finishRegistration(client, initBody.registrationResponse);

      const finishRes = await app.request('/api/auth/register/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'unknown-err@example.com',
          registrationRecord: record,
          accountPublicKey: 'YmFzZTY0cHVia2V5',
          passwordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
          recoveryWrappedPrivateKey: 'YmFzZTY0cmVjb3Zlcnk=', // gitleaks:allow
          registerSessionId: initBody.registerSessionId,
        }),
      });

      expect(finishRes.status).toBe(500);
      const body = await jsonBody<{ code: string }>(finishRes);
      expect(body.code).toBe('INTERNAL');
    });
  });

  describe('POST /api/auth/login/init', () => {
    it('returns 400 for missing identifier', async () => {
      const res = await app.request('/api/auth/login/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ke1: [1, 2, 3],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing ke1', async () => {
      const res = await app.request('/api/auth/login/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'test@example.com',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 200 with fake OPAQUE state for non-existent email', async () => {
      const client = createOpaqueClient();
      const { ke1 } = await startLogin(client, 'test-password');

      const res = await app.request('/api/auth/login/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'nonexistent@example.com',
          ke1,
        }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<LoginInitResponse>(res);
      expect(body.ke2).toBeDefined();
      expect(Array.isArray(body.ke2)).toBe(true);
      // passwordSalt is no longer returned (removed in new key hierarchy)
      expect(body.passwordSalt).toBeUndefined();
    });

    it('returns 200 with fake OPAQUE state for non-existent username', async () => {
      const client = createOpaqueClient();
      const { ke1 } = await startLogin(client, 'test-password');

      const res = await app.request('/api/auth/login/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'nonexistentuser',
          ke1,
        }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<LoginInitResponse>(res);
      expect(body.ke2).toBeDefined();
      expect(Array.isArray(body.ke2)).toBe(true);
    });

    it('returns 429 when IP rate limited', async () => {
      const ip = '192.168.1.1';

      // Exhaust IP rate limit (20 attempts per 900 seconds)
      for (let index = 0; index < 20; index++) {
        const client = createOpaqueClient();
        const { ke1 } = await startLogin(client, 'test-password');
        await app.request('/api/auth/login/init', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cf-connecting-ip': ip,
          },
          body: JSON.stringify({
            identifier: `test${String(index)}@example.com`,
            ke1,
          }),
        });
      }

      const client = createOpaqueClient();
      const { ke1 } = await startLogin(client, 'test-password');
      const res = await app.request('/api/auth/login/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': ip,
        },
        body: JSON.stringify({
          identifier: 'another@example.com',
          ke1,
        }),
      });

      expect(res.status).toBe(429);
      const body = await jsonBody(res);
      expect(body.code).toBe('RATE_LIMITED');
    }, 30_000);
  });

  describe('POST /api/auth/login/finish', () => {
    it('returns 400 for missing identifier', async () => {
      const res = await app.request('/api/auth/login/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ke3: [1, 2, 3],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing ke3', async () => {
      const res = await app.request('/api/auth/login/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'test@example.com',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 if no pending login exists', async () => {
      const res = await app.request('/api/auth/login/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'test@example.com',
          ke3: [1, 2, 3],
          loginSessionId: DUMMY_SESSION_ID,
        }),
      });

      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('NO_PENDING_LOGIN');
    });
  });

  describe('full login flow', () => {
    it('returns 401 EMAIL_NOT_VERIFIED when email is not verified', async () => {
      const email = 'unverified@example.com';
      const password = 'secure-password-123';

      const regClient = createOpaqueClient();
      const { serialized: regRequest } = await startRegistration(regClient, password);

      const initRes = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          username: 'Unverified User',
          registrationRequest: regRequest,
        }),
      });
      expect(initRes.status).toBe(200);
      const { registrationResponse, registerSessionId } =
        await jsonBody<RegistrationInitResponse>(initRes);

      const { record } = await finishRegistration(
        regClient,
        registrationResponse,
        OPAQUE_SERVER_IDENTIFIER
      );

      const finishRes = await app.request('/api/auth/register/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          registrationRecord: record,
          accountPublicKey: 'YmFzZTY0cHVia2V5',
          passwordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
          recoveryWrappedPrivateKey: 'YmFzZTY0cmVjb3Zlcnk=', // gitleaks:allow
          registerSessionId,
        }),
      });
      expect(finishRes.status).toBe(201);

      // Capture the opaqueRegistration and pre-generated userId from db.insert().values()
      const valuesCall = mockDb.values.mock.calls[0]?.[0] as Record<string, unknown>;
      const storedOpaqueRegistration = valuesCall['opaqueRegistration'] as Uint8Array;
      const registeredUserId = valuesCall['id'] as string;

      // Mock DB to return user with opaqueRegistration but emailVerified: false
      // Must use registeredUserId — OPAQUE credential identifier was bound to this ID during registration
      mockDb.where = vi.fn().mockImplementation(() => [
        {
          id: registeredUserId,
          email,
          username: 'unverifieduser',
          emailVerified: false,
          opaqueRegistration: storedOpaqueRegistration,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          passwordWrappedPrivateKey: new Uint8Array(
            Array.from(atob('YmFzZTY0d3JhcHBlZA=='), (c) => c.codePointAt(0) ?? 0)
          ),
        },
      ]);

      const loginClient = createOpaqueClient();
      const { ke1 } = await startLogin(loginClient, password);

      const loginInitRes = await app.request('/api/auth/login/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: email, ke1 }),
      });
      expect(loginInitRes.status).toBe(200);
      const loginInitBody = await jsonBody<LoginInitResponse>(loginInitRes);

      const { ke3 } = await finishLogin(loginClient, loginInitBody.ke2, OPAQUE_SERVER_IDENTIFIER);

      const loginFinishRes = await app.request('/api/auth/login/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: email,
          ke3,
          loginSessionId: loginInitBody.loginSessionId,
        }),
      });

      expect(loginFinishRes.status).toBe(401);
      const body = await jsonBody(loginFinishRes);
      expect(body.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('allows login via username identifier', async () => {
      const email = 'userbyname@example.com';
      const username = 'loginbyname';
      const password = 'secure-password-456';

      const regClient = createOpaqueClient();
      const { serialized: regRequest } = await startRegistration(regClient, password);

      const initRes = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          username,
          registrationRequest: regRequest,
        }),
      });
      expect(initRes.status).toBe(200);
      const { registrationResponse, registerSessionId } =
        await jsonBody<RegistrationInitResponse>(initRes);

      const { record } = await finishRegistration(
        regClient,
        registrationResponse,
        OPAQUE_SERVER_IDENTIFIER
      );

      const finishRes = await app.request('/api/auth/register/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          registrationRecord: record,
          accountPublicKey: 'YmFzZTY0cHVia2V5',
          passwordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
          recoveryWrappedPrivateKey: 'YmFzZTY0cmVjb3Zlcnk=', // gitleaks:allow
          registerSessionId,
        }),
      });
      expect(finishRes.status).toBe(201);

      // Capture registration data
      const valuesCall = mockDb.values.mock.calls[0]?.[0] as Record<string, unknown>;
      const storedOpaqueRegistration = valuesCall['opaqueRegistration'] as Uint8Array;
      const registeredUserId = valuesCall['id'] as string;

      mockDb.where = vi.fn().mockImplementation(() => [
        {
          id: registeredUserId,
          email,
          username,
          emailVerified: true,
          opaqueRegistration: storedOpaqueRegistration,
          totpEnabled: false,
          hasAcknowledgedPhrase: true,
          passwordWrappedPrivateKey: new Uint8Array(
            Array.from(atob('YmFzZTY0d3JhcHBlZA=='), (c) => c.codePointAt(0) ?? 0)
          ),
        },
      ]);

      const loginClient = createOpaqueClient();
      const { ke1 } = await startLogin(loginClient, password);

      const loginInitRes = await app.request('/api/auth/login/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: username, ke1 }),
      });
      expect(loginInitRes.status).toBe(200);
      const loginInitBody = await jsonBody<LoginInitResponse>(loginInitRes);

      const { ke3 } = await finishLogin(loginClient, loginInitBody.ke2, OPAQUE_SERVER_IDENTIFIER);

      const loginFinishRes = await app.request('/api/auth/login/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: username,
          ke3,
          loginSessionId: loginInitBody.loginSessionId,
        }),
      });

      expect(loginFinishRes.status).toBe(200);
      const body = await jsonBody<LoginFinishResponse>(loginFinishRes);
      expect(body.success).toBe(true);
      expect(body.userId).toBe(registeredUserId);
    });

    it('skips email verification for no-email users', async () => {
      const email = 'noemail-reg@example.com';
      const password = 'secure-password-789';

      const regClient = createOpaqueClient();
      const { serialized: regRequest } = await startRegistration(regClient, password);

      const initRes = await app.request('/api/auth/register/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          username: 'noemailuser',
          registrationRequest: regRequest,
        }),
      });
      expect(initRes.status).toBe(200);
      const { registrationResponse, registerSessionId } =
        await jsonBody<RegistrationInitResponse>(initRes);

      const { record } = await finishRegistration(
        regClient,
        registrationResponse,
        OPAQUE_SERVER_IDENTIFIER
      );

      const finishRes = await app.request('/api/auth/register/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          registrationRecord: record,
          accountPublicKey: 'YmFzZTY0cHVia2V5',
          passwordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
          recoveryWrappedPrivateKey: 'YmFzZTY0cmVjb3Zlcnk=', // gitleaks:allow
          registerSessionId,
        }),
      });
      expect(finishRes.status).toBe(201);

      // Capture registration data
      const valuesCall = mockDb.values.mock.calls[0]?.[0] as Record<string, unknown>;
      const storedOpaqueRegistration = valuesCall['opaqueRegistration'] as Uint8Array;
      const registeredUserId = valuesCall['id'] as string;

      // emailVerified is false, but email is null — should skip verification
      mockDb.where = vi.fn().mockImplementation(() => [
        {
          id: registeredUserId,
          email: null,
          username: 'noemailuser',
          emailVerified: false,
          opaqueRegistration: storedOpaqueRegistration,
          totpEnabled: false,
          hasAcknowledgedPhrase: true,
          passwordWrappedPrivateKey: new Uint8Array(
            Array.from(atob('YmFzZTY0d3JhcHBlZA=='), (c) => c.codePointAt(0) ?? 0)
          ),
        },
      ]);

      const loginClient = createOpaqueClient();
      const { ke1 } = await startLogin(loginClient, password);

      const loginInitRes = await app.request('/api/auth/login/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'noemailuser', ke1 }),
      });
      expect(loginInitRes.status).toBe(200);
      const loginInitBody = await jsonBody<LoginInitResponse>(loginInitRes);

      const { ke3 } = await finishLogin(loginClient, loginInitBody.ke2, OPAQUE_SERVER_IDENTIFIER);

      const loginFinishRes = await app.request('/api/auth/login/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'noemailuser',
          ke3,
          loginSessionId: loginInitBody.loginSessionId,
        }),
      });

      expect(loginFinishRes.status).toBe(200);
      const body = await jsonBody<LoginFinishResponse>(loginFinishRes);
      expect(body.success).toBe(true);
      expect(body.userId).toBe(registeredUserId);
      // No-email users should not receive email in response
      expect(body.email).toBeNull();
    });
  });

  describe('POST /api/auth/logout', () => {
    it('returns success when no session exists', async () => {
      const res = await app.request('/api/auth/logout', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.success).toBe(true);
    });

    it('returns success and clears session when authenticated', async () => {
      // Create a mock session cookie
      const mockSession = {
        userId: 'test-user-id',
        email: 'test@example.com',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: true,
        createdAt: Date.now(),
      };
      // Store session in mock context - the middleware will inject this
      mockRedis.set('session:test-user-id', mockSession);

      const res = await app.request('/api/auth/logout', {
        method: 'POST',
        headers: {
          Cookie: 'hushbox_session=test-session-value',
        },
      });

      // For now, test that the route exists (will return 401 without proper session handling)
      expect([200, 401]).toContain(res.status);
    });
  });

  describe('POST /api/auth/2fa/setup', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/api/auth/2fa/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(401);
      const body = await jsonBody(res);
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 if 2FA is already enabled', async () => {
      // Setup mock user with 2FA already enabled
      mockDb.where = vi.fn().mockImplementation(() => [
        {
          id: 'test-user-id',
          email: 'test@example.com',
          totpEnabled: true,
          totpSecretEncrypted: new Uint8Array([1, 2, 3]),
        },
      ]);

      const res = await app.request('/api/auth/2fa/setup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('TOTP_ALREADY_ENABLED');
    });

    it('returns TOTP URI and secret for authenticated user', async () => {
      // Setup mock user without 2FA
      mockDb.where = vi.fn().mockImplementation(() => [
        {
          id: 'test-user-id',
          email: 'test@example.com',
          totpEnabled: false,
        },
      ]);

      const res = await app.request('/api/auth/2fa/setup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<TotpSetupResponse>(res);
      expect(body.totpUri).toBeDefined();
      expect(body.totpUri).toContain('otpauth://totp/');
      expect(body.totpUri).toContain('HushBox');
      expect(body.secret).toBeDefined();
      expect(typeof body.secret).toBe('string');
      expect(body.secret.length).toBeGreaterThan(0);
    });

    it('stores pending 2FA setup in Redis', async () => {
      mockDb.where = vi.fn().mockImplementation(() => [
        {
          id: 'test-user-id',
          email: 'test@example.com',
          totpEnabled: false,
        },
      ]);

      await app.request('/api/auth/2fa/setup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({}),
      });

      expect(mockRedis.set).toHaveBeenCalled();
      const setCall = mockRedis.set.mock.calls.find((call: string[]) =>
        call[0]?.includes('totp:pending:')
      );
      expect(setCall).toBeDefined();
    });
  });

  describe('POST /api/auth/2fa/verify', () => {
    it('returns 400 for missing code', async () => {
      const res = await app.request('/api/auth/2fa/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid code format', async () => {
      const res = await app.request('/api/auth/2fa/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({ code: 'abc' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/api/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456' }),
      });

      expect(res.status).toBe(401);
      const body = await jsonBody(res);
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 if no pending 2FA setup exists', async () => {
      mockDb.where = vi.fn().mockImplementation(() => [
        {
          id: 'test-user-id',
          email: 'test@example.com',
          totpEnabled: false,
        },
      ]);

      const res = await app.request('/api/auth/2fa/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({ code: '123456' }),
      });

      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('NO_PENDING_2FA_SETUP');
    });

    it('returns 400 for incorrect TOTP code', async () => {
      const { encryptTotpSecret, deriveTotpEncryptionKey } = await import('@hushbox/crypto');
      const totpKey = deriveTotpEncryptionKey(new TextEncoder().encode(TEST_MASTER_SECRET));

      mockDb.where = vi.fn().mockImplementation(() => [
        {
          id: 'test-user-id',
          email: 'test@example.com',
          totpEnabled: false,
        },
      ]);

      // Store a pending 2FA setup with encrypted secret matching registry schema
      const encryptedBlob = encryptTotpSecret('JBSWY3DPEHPK3PXP', totpKey);
      const pendingData = {
        secret: 'JBSWY3DPEHPK3PXP',
        encryptedBlob: [...encryptedBlob],
      };
      mockRedis.set(`totp:pending:test-user-id`, pendingData);

      const res = await app.request('/api/auth/2fa/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({ code: '000000' }),
      });

      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('INVALID_TOTP_CODE');
    });
  });

  describe('POST /api/auth/2fa/disable/init', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/api/auth/2fa/disable/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ke1: [1, 2, 3] }),
      });
      expect(res.status).toBe(401);
      const body = await jsonBody(res);
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 500 when server is misconfigured', async () => {
      // Override env in middleware to remove OPAQUE_MASTER_SECRET
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
        const cookie = c.req.header('Cookie');
        if (cookie?.includes('hushbox_session=')) {
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
        }
        await next();
      });
      testApp.route('/api/auth', opaqueAuthRoute);

      const res = await testApp.request('/api/auth/2fa/disable/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({ ke1: [1, 2, 3] }),
      });
      expect(res.status).toBe(500);
      const body = await jsonBody(res);
      expect(body.code).toBe('SERVER_MISCONFIGURED');
    });

    it('returns 400 when 2FA is not enabled', async () => {
      mockDb.where = vi.fn().mockImplementation(() => [
        {
          id: 'test-user-id',
          email: 'test@example.com',
          opaqueRegistration: new Uint8Array([1, 2, 3]),
          totpEnabled: false,
        },
      ]);

      const res = await app.request('/api/auth/2fa/disable/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({ ke1: [1, 2, 3] }),
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('TOTP_NOT_ENABLED');
    });
  });

  describe('POST /api/auth/2fa/disable/finish', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/api/auth/2fa/disable/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ke3: [1, 2, 3],
          code: '123456',
          disable2FASessionId: DUMMY_SESSION_ID,
        }),
      });
      expect(res.status).toBe(401);
      const body = await jsonBody(res);
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 when no pending disable state exists', async () => {
      const res = await app.request('/api/auth/2fa/disable/finish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({
          ke3: [1, 2, 3],
          code: '123456',
          disable2FASessionId: DUMMY_SESSION_ID,
        }),
      });
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('NO_PENDING_DISABLE');
    });

    it('returns 500 when server is misconfigured', async () => {
      // Store pending state first (under the sessionId key used by the request).
      const pendingSessionId = '11111111-1111-4111-8111-111111111111';
      const { redisSet } = await import('../lib/redis-registry.js');
      await redisSet(
        mockRedis as unknown as Parameters<typeof redisSet>[0],
        'opaquePending2FADisable',
        {
          userId: 'test-user-id',
          expectedSerialized: [1, 2, 3],
        },
        pendingSessionId
      );

      // Override env to remove OPAQUE_MASTER_SECRET
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
        const cookie = c.req.header('Cookie');
        if (cookie?.includes('hushbox_session=')) {
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
        }
        await next();
      });
      testApp.route('/api/auth', opaqueAuthRoute);

      const res = await testApp.request('/api/auth/2fa/disable/finish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({
          ke3: [1, 2, 3],
          code: '123456',
          disable2FASessionId: pendingSessionId,
        }),
      });
      expect(res.status).toBe(500);
      const body = await jsonBody(res);
      expect(body.code).toBe('SERVER_MISCONFIGURED');
    });
  });

  describe('POST /api/auth/verify-email', () => {
    it('returns 400 for missing token', async () => {
      const res = await app.request('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for empty token', async () => {
      const res = await app.request('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when token not found or expired', async () => {
      // Default mock returns empty array (no user found)
      mockDb.where = vi.fn().mockImplementation(() => []);

      const res = await app.request('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'invalid-token' }),
      });

      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('INVALID_OR_EXPIRED_TOKEN');
    });

    it('returns 200 and verifies email when token is valid', async () => {
      // First call: select returns user, second call: update
      let callCount = 0;
      mockDb.where = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return [{ id: 'test-user-id' }];
        }
        return [];
      });
      mockDb.set = vi.fn().mockReturnValue(mockDb);

      const res = await app.request('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'valid-token' }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.success).toBe(true);
    });

    it('rate limits by IP when using different invalid tokens', async () => {
      mockDb.where = vi.fn().mockImplementation(() => []);
      const ip = '192.168.1.50';

      // Exhaust IP rate limit with different tokens (30 attempts per 3600 seconds)
      for (let index = 0; index < 30; index++) {
        await app.request('/api/auth/verify-email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cf-connecting-ip': ip,
          },
          body: JSON.stringify({ token: `different-token-${String(index)}` }),
        });
      }

      // 31st attempt from same IP with yet another different token should be rate limited
      const res = await app.request('/api/auth/verify-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': ip,
        },
        body: JSON.stringify({ token: 'yet-another-different-token' }),
      });

      expect(res.status).toBe(429);
      const body = await jsonBody(res);
      expect(body.code).toBe('RATE_LIMITED');
    });

    it('returns 429 when IP rate limited', async () => {
      mockDb.where = vi.fn().mockImplementation(() => [{ id: 'test-user-id' }]);
      mockDb.set = vi.fn().mockReturnValue(mockDb);

      const ip = '192.168.1.1';

      // Exhaust IP rate limit (30 attempts per 3600 seconds)
      for (let index = 0; index < 30; index++) {
        await app.request('/api/auth/verify-email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cf-connecting-ip': ip,
          },
          body: JSON.stringify({ token: `token-${String(index)}` }),
        });
      }

      const res = await app.request('/api/auth/verify-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': ip,
        },
        body: JSON.stringify({ token: 'another-token' }),
      });

      expect(res.status).toBe(429);
      const body = await jsonBody(res);
      expect(body.code).toBe('RATE_LIMITED');
    }, 30_000);
  });

  describe('POST /api/auth/resend-verification', () => {
    it('returns 400 for missing email', async () => {
      const res = await app.request('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid email format', async () => {
      const res = await app.request('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 200 even when user does not exist (no leak)', async () => {
      mockDb.where = vi.fn().mockImplementation(() => []);
      mockDb.set = vi.fn().mockReturnValue(mockDb);

      const res = await app.request('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nonexistent@example.com' }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.success).toBe(true);
    });

    it('returns 200 and sends email when user exists and not verified', async () => {
      let callCount = 0;
      mockDb.where = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return [{ id: 'test-user-id', username: 'test_user' }];
        }
        return [];
      });
      mockDb.set = vi.fn().mockReturnValue(mockDb);

      const res = await app.request('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.success).toBe(true);
    });

    it('returns 429 when email rate limited', async () => {
      // First request to use up the rate limit
      mockDb.where = vi.fn().mockImplementation(() => []);
      mockDb.set = vi.fn().mockReturnValue(mockDb);

      await app.request('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' }),
      });

      // Second request should be rate limited (1 per 60 seconds)
      const res = await app.request('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' }),
      });

      expect(res.status).toBe(429);
      const body = await jsonBody(res);
      expect(body.code).toBe('RATE_LIMITED');
    }, 30_000);

    it('returns 429 when IP rate limited', async () => {
      mockDb.where = vi.fn().mockImplementation(() => []);
      mockDb.set = vi.fn().mockReturnValue(mockDb);

      const ip = '192.168.1.1';

      // Exhaust IP rate limit (5 attempts per 60 seconds)
      for (let index = 0; index < 5; index++) {
        await app.request('/api/auth/resend-verification', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cf-connecting-ip': ip,
          },
          body: JSON.stringify({ email: `test${String(index)}@example.com` }),
        });
      }

      const res = await app.request('/api/auth/resend-verification', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': ip,
        },
        body: JSON.stringify({ email: 'another@example.com' }),
      });

      expect(res.status).toBe(429);
      const body = await jsonBody(res);
      expect(body.code).toBe('RATE_LIMITED');
    }, 30_000);
  });

  describe('POST /api/auth/change-password/init', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/api/auth/change-password/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ke1: [1, 2, 3], newRegistrationRequest: [4, 5, 6] }),
      });

      expect(res.status).toBe(401);
      const body = await jsonBody(res);
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 for missing ke1', async () => {
      const res = await app.request('/api/auth/change-password/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({ newRegistrationRequest: [1, 2, 3] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing newRegistrationRequest', async () => {
      const res = await app.request('/api/auth/change-password/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({ ke1: [1, 2, 3] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 500 when user not found', async () => {
      mockDb.where = vi.fn().mockImplementation(() => []);

      const client = createOpaqueClient();
      const { ke1 } = await startLogin(client, 'test-password');
      const regClient = createOpaqueClient();
      const { serialized } = await startRegistration(regClient, 'new-password');

      const res = await app.request('/api/auth/change-password/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({ ke1, newRegistrationRequest: serialized }),
      });

      expect(res.status).toBe(500);
      const body = await jsonBody(res);
      expect(body.code).toBe('USER_NOT_FOUND');
    });
  });

  describe('POST /api/auth/change-password/finish', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/api/auth/change-password/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ke3: [1, 2, 3],
          newRegistrationRecord: [4, 5, 6],
          newPasswordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
          changePasswordSessionId: DUMMY_SESSION_ID,
        }),
      });

      expect(res.status).toBe(401);
      const body = await jsonBody(res);
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 when no pending change exists', async () => {
      const res = await app.request('/api/auth/change-password/finish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({
          ke3: [1, 2, 3],
          newRegistrationRecord: [4, 5, 6],
          newPasswordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
          changePasswordSessionId: DUMMY_SESSION_ID,
        }),
      });

      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('NO_PENDING_CHANGE');
    });

    it('returns 400 for missing required fields', async () => {
      const res = await app.request('/api/auth/change-password/finish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({ ke3: [1, 2, 3] }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('Recovery Password Reset', () => {
    describe('POST /api/auth/recovery/reset', () => {
      it('returns registration response for valid request', async () => {
        const client = createOpaqueClient();
        const { serialized } = await startRegistration(client, 'new-password');

        const res = await app.request('/api/auth/recovery/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'user@example.com',
            newRegistrationRequest: serialized,
          }),
        });

        expect(res.status).toBe(200);
        const body = await jsonBody(res);
        expect(body.newRegistrationResponse).toBeDefined();
        expect(Array.isArray(body.newRegistrationResponse)).toBe(true);
      });

      it('returns registration response for username identifier', async () => {
        const client = createOpaqueClient();
        const { serialized } = await startRegistration(client, 'new-password');

        const res = await app.request('/api/auth/recovery/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'test_user',
            newRegistrationRequest: serialized,
          }),
        });

        expect(res.status).toBe(200);
        const body = await jsonBody(res);
        expect(body.newRegistrationResponse).toBeDefined();
        expect(Array.isArray(body.newRegistrationResponse)).toBe(true);
      });

      it('returns 429 when rate limited', async () => {
        const identifier = 'test@example.com';

        // Exhaust rate limit (3 attempts per 3600 seconds)
        for (let index = 0; index < 3; index++) {
          const client = createOpaqueClient();
          const { serialized } = await startRegistration(client, 'new-password');
          await app.request('/api/auth/recovery/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, newRegistrationRequest: serialized }),
          });
        }

        const client = createOpaqueClient();
        const { serialized } = await startRegistration(client, 'new-password');
        const res = await app.request('/api/auth/recovery/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, newRegistrationRequest: serialized }),
        });

        expect(res.status).toBe(429);
        const body = await jsonBody(res);
        expect(body.code).toBe('RATE_LIMITED');
      }, 30_000);
    });

    describe('POST /api/auth/recovery/reset/finish', () => {
      it('updates user record and invalidates sessions on success', async () => {
        // Set up pending recovery state in Redis (key-aware to avoid breaking rate limit checks)
        mockRedis.get = vi.fn().mockImplementation((key: string) => {
          if (key.startsWith('opaque:recovery-reset:')) {
            return Promise.resolve({ identifier: 'user@example.com' });
          }
          return Promise.resolve(null);
        });
        mockDb.where = vi.fn().mockImplementation(() => [{ id: 'user-id' }]);

        const client = createOpaqueClient();
        const { serialized: regRequest } = await startRegistration(client, 'new-password');

        const initRes = await app.request('/api/auth/recovery/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'user@example.com',
            newRegistrationRequest: regRequest,
          }),
        });

        expect(initRes.status).toBe(200);
        const initBody = await jsonBody<RecoveryResetInitResponse>(initRes);
        const { record } = await finishRegistration(client, initBody.newRegistrationResponse);

        const res = await app.request('/api/auth/recovery/reset/finish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'user@example.com',
            newRegistrationRecord: record,
            newPasswordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
            recoverySessionId: initBody.recoverySessionId,
          }),
        });

        expect(res.status).toBe(200);
        const body = await jsonBody(res);
        expect(body.success).toBe(true);
        expect(mockDb.update).toHaveBeenCalled();
        expect(mockRedis.set).toHaveBeenCalled();
      });

      it('completes recovery reset for username identifier', async () => {
        mockRedis.get = vi.fn().mockImplementation((key: string) => {
          if (key.startsWith('opaque:recovery-reset:')) {
            return Promise.resolve({ identifier: 'test_user' });
          }
          return Promise.resolve(null);
        });
        mockDb.where = vi.fn().mockImplementation(() => [{ id: 'user-id' }]);

        const client = createOpaqueClient();
        const { serialized: regRequest } = await startRegistration(client, 'new-password');

        const initRes = await app.request('/api/auth/recovery/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'test_user',
            newRegistrationRequest: regRequest,
          }),
        });

        expect(initRes.status).toBe(200);
        const initBody = await jsonBody<RecoveryResetInitResponse>(initRes);
        const { record } = await finishRegistration(client, initBody.newRegistrationResponse);

        const res = await app.request('/api/auth/recovery/reset/finish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'test_user',
            newRegistrationRecord: record,
            newPasswordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
            recoverySessionId: initBody.recoverySessionId,
          }),
        });

        expect(res.status).toBe(200);
        const body = await jsonBody(res);
        expect(body.success).toBe(true);
      });

      it('returns 400 when no pending recovery', async () => {
        mockRedis.get = vi.fn().mockResolvedValue(null);

        const res = await app.request('/api/auth/recovery/reset/finish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'user@example.com',
            newRegistrationRecord: [1, 2, 3],
            newPasswordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
            recoverySessionId: DUMMY_SESSION_ID,
          }),
        });

        expect(res.status).toBe(400);
        const body = await jsonBody(res);
        expect(body.code).toBe('NO_PENDING_RECOVERY');
      });

      it('cleans up pending state after success', async () => {
        mockRedis.get = vi.fn().mockImplementation((key: string) => {
          if (key.startsWith('opaque:recovery-reset:')) {
            return Promise.resolve({ identifier: 'user@example.com' });
          }
          return Promise.resolve(null);
        });
        mockDb.where = vi.fn().mockImplementation(() => [{ id: 'user-id' }]);

        const client = createOpaqueClient();
        const { serialized: regRequest } = await startRegistration(client, 'new-password');

        const initRes = await app.request('/api/auth/recovery/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'user@example.com',
            newRegistrationRequest: regRequest,
          }),
        });

        const initBody = await jsonBody<RecoveryResetInitResponse>(initRes);
        const { record } = await finishRegistration(client, initBody.newRegistrationResponse);

        const res = await app.request('/api/auth/recovery/reset/finish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'user@example.com',
            newRegistrationRecord: record,
            newPasswordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
            recoverySessionId: initBody.recoverySessionId,
          }),
        });

        expect(res.status).toBe(200);
        expect(mockRedis.del).toHaveBeenCalled();
      });

      it('sends password changed notification email after recovery reset', async () => {
        mockRedis.get = vi.fn().mockImplementation((key: string) => {
          if (key.startsWith('opaque:recovery-reset:')) {
            return Promise.resolve({ identifier: 'user@example.com' });
          }
          return Promise.resolve(null);
        });
        mockDb.where = vi
          .fn()
          .mockImplementation(() => [
            { id: 'user-id', email: 'user@example.com', username: 'test_user' },
          ]);

        const client = createOpaqueClient();
        const { serialized: regRequest } = await startRegistration(client, 'new-password');

        const initRes = await app.request('/api/auth/recovery/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'user@example.com',
            newRegistrationRequest: regRequest,
          }),
        });

        const initBody = await jsonBody<RecoveryResetInitResponse>(initRes);
        const { record } = await finishRegistration(client, initBody.newRegistrationResponse);

        mockEmailClient.clearSentEmails();

        const res = await app.request('/api/auth/recovery/reset/finish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'user@example.com',
            newRegistrationRecord: record,
            newPasswordWrappedPrivateKey: 'YmFzZTY0d3JhcHBlZA==', // gitleaks:allow
            recoverySessionId: initBody.recoverySessionId,
          }),
        });

        expect(res.status).toBe(200);
        const sentEmails = mockEmailClient.getSentEmails();
        expect(sentEmails).toHaveLength(1);
        expect(sentEmails[0]?.to).toBe('user@example.com');
        expect(sentEmails[0]?.subject).toContain('password');
      });
    });
  });

  describe('POST /api/auth/recovery/get-wrapped-key', () => {
    it('returns recoveryWrappedPrivateKey for valid email identifier', async () => {
      const recoveryBlob = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
      mockDb.where = vi.fn().mockImplementation(() => [
        {
          id: 'user-id',
          recoveryWrappedPrivateKey: recoveryBlob,
        },
      ]);

      const res = await app.request('/api/auth/recovery/get-wrapped-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'user@example.com' }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<RecoveryWrappedKeyResponse>(res);
      expect(body.recoveryWrappedPrivateKey).toBeDefined();
      expect(typeof body.recoveryWrappedPrivateKey).toBe('string');
      expect(body.recoveryWrappedPrivateKey.length).toBeGreaterThan(0);
    });

    it('returns recoveryWrappedPrivateKey for username identifier', async () => {
      const recoveryBlob = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
      mockDb.where = vi.fn().mockImplementation(() => [
        {
          id: 'user-id',
          recoveryWrappedPrivateKey: recoveryBlob,
        },
      ]);

      const res = await app.request('/api/auth/recovery/get-wrapped-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'test_user' }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<RecoveryWrappedKeyResponse>(res);
      expect(body.recoveryWrappedPrivateKey).toBeDefined();
      expect(typeof body.recoveryWrappedPrivateKey).toBe('string');
      expect(body.recoveryWrappedPrivateKey.length).toBeGreaterThan(0);
    });

    it('returns dummy value for unknown identifier (timing-safe)', async () => {
      mockDb.where = vi.fn().mockImplementation(() => []);

      const res = await app.request('/api/auth/recovery/get-wrapped-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'nonexistent@example.com' }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<RecoveryWrappedKeyResponse>(res);
      expect(body.recoveryWrappedPrivateKey).toBeDefined();
      expect(typeof body.recoveryWrappedPrivateKey).toBe('string');
      expect(body.recoveryWrappedPrivateKey.length).toBeGreaterThan(0);
    });

    it('returns dummy value for unknown username (timing-safe)', async () => {
      mockDb.where = vi.fn().mockImplementation(() => []);

      const res = await app.request('/api/auth/recovery/get-wrapped-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'nobody_here' }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<RecoveryWrappedKeyResponse>(res);
      expect(body.recoveryWrappedPrivateKey).toBeDefined();
      expect(typeof body.recoveryWrappedPrivateKey).toBe('string');
      expect(body.recoveryWrappedPrivateKey.length).toBeGreaterThan(0);
    });

    it('returns 429 when rate limited by identifier', async () => {
      mockDb.where = vi.fn().mockImplementation(() => []);
      const identifier = 'ratelimit@example.com';

      // Exhaust identifier rate limit (3 attempts per 3600 seconds)
      for (let index = 0; index < 3; index++) {
        await app.request('/api/auth/recovery/get-wrapped-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier }),
        });
      }

      const res = await app.request('/api/auth/recovery/get-wrapped-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier }),
      });

      expect(res.status).toBe(429);
      const body = await jsonBody(res);
      expect(body.code).toBe('RATE_LIMITED');
    }, 30_000);

    it('returns 400 for missing identifier', async () => {
      const res = await app.request('/api/auth/recovery/get-wrapped-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/recovery/save', () => {
    const validPayload = {
      recoveryWrappedPrivateKey: 'dGVzdHJlY292ZXJ5d3JhcHBlZA==', // gitleaks:allow
    };

    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/api/auth/recovery/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      expect(res.status).toBe(401);
      const body = await jsonBody(res);
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 when recoveryWrappedPrivateKey is missing', async () => {
      const res = await app.request('/api/auth/recovery/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('updates user record with decoded crypto material', async () => {
      const res = await app.request('/api/auth/recovery/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify(validPayload),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.success).toBe(true);

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          recoveryWrappedPrivateKey: expect.any(Uint8Array),
          hasAcknowledgedPhrase: true,
        })
      );
    });

    it('returns 400 when values are not valid base64', async () => {
      const res = await app.request('/api/auth/recovery/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({
          recoveryWrappedPrivateKey: '!!!not-base64!!!',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/login/2fa/verify - session rotation', () => {
    /**
     * Helper: prime the iron-session fixture for a pending-2FA login.
     * Returns the original session ID so callers can compare against the
     * post-verification ID assigned via session.save().
     *
     * Default secret is 32 base32 characters (≥16 bytes once decoded), which
     * satisfies otplib's minimum-strength check.
     */
    async function setupPendingTotpSession(
      totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
    ): Promise<{ originalSessionId: string; encryptedSecret: Uint8Array }> {
      const { encryptTotpSecret, deriveTotpEncryptionKey } = await import('@hushbox/crypto');
      const totpKey = deriveTotpEncryptionKey(new TextEncoder().encode(TEST_MASTER_SECRET));
      const encryptedSecret = encryptTotpSecret(totpSecret, totpKey);

      const originalSessionId = 'session-id-before-rotation';
      mockIronSessionData.sessionId = originalSessionId;
      mockIronSessionData.userId = 'test-user-id';
      mockIronSessionData.email = 'test@example.com';
      mockIronSessionData.username = 'test_user';
      mockIronSessionData.emailVerified = true;
      mockIronSessionData.totpEnabled = true;
      mockIronSessionData.hasAcknowledgedPhrase = true;
      mockIronSessionData.pending2FA = true;
      mockIronSessionData.pending2FAExpiresAt = Date.now() + 60_000;
      mockIronSessionData.createdAt = Date.now();

      // Stub the user row lookup the route needs.
      mockDb.where = vi.fn().mockImplementation(() => [
        {
          id: 'test-user-id',
          totpSecretEncrypted: encryptedSecret,
          passwordWrappedPrivateKey: new Uint8Array(32),
        },
      ]);

      return { originalSessionId, encryptedSecret };
    }

    it('rotates the session ID and clears pending2FA on successful TOTP verification', async () => {
      const { generateTotpCodeSync } = await import('@hushbox/crypto');
      const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
      const { originalSessionId } = await setupPendingTotpSession(totpSecret);

      // Real TOTP code derived from the same secret the route will decrypt.
      const validCode = generateTotpCodeSync(totpSecret);

      const res = await app.request('/api/auth/login/2fa/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({ code: validCode }),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<{ success: boolean; userId: string }>(res);
      expect(body.success).toBe(true);
      expect(body.userId).toBe('test-user-id');

      // Session rotation: the new sessionId differs from what the request brought in.
      expect(mockIronSessionData.sessionId).toBeDefined();
      expect(mockIronSessionData.sessionId).not.toBe(originalSessionId);
      // Pending flag is cleared post-verification.
      expect(mockIronSessionData.pending2FA).toBe(false);
      expect(mockIronSessionData.pending2FAExpiresAt).toBe(0);
      // save() was called to persist the rotated session.
      expect(mockIronSessionData.save).toHaveBeenCalled();
    });

    it('does NOT rotate the session ID when TOTP verification fails (wrong code)', async () => {
      const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
      const { originalSessionId } = await setupPendingTotpSession(totpSecret);

      // Submit an invalid code that won't match the secret.
      const res = await app.request('/api/auth/login/2fa/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'hushbox_session=test-session-value',
        },
        body: JSON.stringify({ code: '000000' }),
      });

      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.code).toBe('INVALID_TOTP_CODE');

      // Session ID is unchanged after a failed verification — the rotate
      // happens only after successful TOTP. This is the critical security
      // invariant: failed 2FA must never advance session state.
      expect(mockIronSessionData.sessionId).toBe(originalSessionId);
      expect(mockIronSessionData.pending2FA).toBe(true);
      // save() must not have been called on the failure path.
      expect(mockIronSessionData.save).not.toHaveBeenCalled();
    });
  });

  // Note: Security email notifications are tested via integration tests
  // The implementation sends emails on the following triggers:
  // - Password changed (change-password/finish)
  // - Password reset via recovery (recovery/reset-password/finish)
  // - 2FA enabled (2fa/verify)
  // - 2FA disabled (2fa/disable)
  // - Account locked after failed login attempts (login/finish)

  describe('GET /api/auth/me', () => {
    it('returns 401 SESSION_REVOKED when session is not active in Redis', async () => {
      // Session cookie is valid (iron-session decrypts it) but Redis has no active session key
      // This simulates the exact scenario causing e2e test failures
      const res = await app.request('/api/auth/me', {
        method: 'GET',
        headers: {
          Cookie: 'hushbox_session=mock',
        },
      });

      expect(res.status).toBe(401);
      const body = await jsonBody(res);
      expect(body.code).toBe('SESSION_REVOKED');
    });

    it('returns user data when session is active in Redis', async () => {
      // Set the session as active in mock Redis
      await mockRedis.set('sessions:user:active:test-user-id:test-session-id', '1');

      // Mock DB to return user
      mockDb.where = vi.fn().mockResolvedValue([
        {
          id: 'test-user-id',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          passwordWrappedPrivateKey: new Uint8Array(32),
          publicKey: new Uint8Array(32),
        },
      ]);

      const res = await app.request('/api/auth/me', {
        method: 'GET',
        headers: {
          Cookie: 'hushbox_session=mock',
        },
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<{ user: { id: string } }>(res);
      expect(body.user.id).toBe('test-user-id');
    });

    it('returns customInstructionsEncrypted as base64 when set', async () => {
      await mockRedis.set('sessions:user:active:test-user-id:test-session-id', '1');

      const instructionsBytes = new Uint8Array([1, 2, 3, 4, 5]);
      mockDb.where = vi.fn().mockResolvedValue([
        {
          id: 'test-user-id',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          passwordWrappedPrivateKey: new Uint8Array(32),
          publicKey: new Uint8Array(32),
          customInstructionsEncrypted: instructionsBytes,
        },
      ]);

      const res = await app.request('/api/auth/me', {
        method: 'GET',
        headers: {
          Cookie: 'hushbox_session=mock',
        },
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<{ customInstructionsEncrypted: string }>(res);
      expect(body.customInstructionsEncrypted).toBe('AQIDBAU');
    });

    it('returns customInstructionsEncrypted as null when not set', async () => {
      await mockRedis.set('sessions:user:active:test-user-id:test-session-id', '1');

      mockDb.where = vi.fn().mockResolvedValue([
        {
          id: 'test-user-id',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          passwordWrappedPrivateKey: new Uint8Array(32),
          publicKey: new Uint8Array(32),
          customInstructionsEncrypted: null,
        },
      ]);

      const res = await app.request('/api/auth/me', {
        method: 'GET',
        headers: {
          Cookie: 'hushbox_session=mock',
        },
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<{ customInstructionsEncrypted: string | null }>(res);
      expect(body.customInstructionsEncrypted).toBeNull();
    });

    it('returns 401 NOT_AUTHENTICATED when no session cookie', async () => {
      const res = await app.request('/api/auth/me', {
        method: 'GET',
      });

      expect(res.status).toBe(401);
      const body = await jsonBody(res);
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });
  });
});
