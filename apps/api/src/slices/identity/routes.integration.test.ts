import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Redis } from '@upstash/redis';
import { eq, like } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, users } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration as opaqueClientFinishRegistration,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { ERROR_CODES, toBase64 } from '@hushbox/shared';
import { unsealData } from 'iron-session';
import { applyPipeline } from '../../middleware/pipeline.js';
import { routeClass } from '../../middleware/pipeline-markers.js';
import { createErrorResponse } from '../../lib/errors/index.js';
import { SESSION_COOKIE_NAME, parseSessionClaims } from '../../lib/context/index.js';
import { redisSet } from '../../lib/redis/index.js';
import { IDENTITY_KEYS } from './keys.js';
import {
  checkSessionRevocation,
  createIdentityManifest,
  createIdentityStores,
  issueSession,
} from './index.js';
import type { AppEnv, Bindings, SessionClaims } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
const OPAQUE_MASTER_SECRET = process.env['OPAQUE_MASTER_SECRET'];
if (
  !DATABASE_URL ||
  !UPSTASH_REDIS_REST_URL ||
  !UPSTASH_REDIS_REST_TOKEN ||
  !OPAQUE_MASTER_SECRET
) {
  throw new Error('DATABASE_URL, Upstash vars, and OPAQUE_MASTER_SECRET are required');
}

const SECRET = 'secret-at-least-32-characters-long!!';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  OPAQUE_MASTER_SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

/** Unique per run so concurrent suites on the shared DB never collide. */
const PREFIX = `zr${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
let counter = 0;

function uniqueAccount(): { email: string; username: string; password: string } {
  counter += 1;
  const name = `${PREFIX}a${String(counter)}`;
  return {
    email: `${name}@identity-routes.test`,
    username: name,
    password: `correct horse ${name}`,
  };
}

function createApp(): Hono<AppEnv> {
  const manifest = createIdentityManifest({ stores: createIdentityStores });
  const app = applyPipeline(new Hono<AppEnv>(), {
    session: { revocation: checkSessionRevocation },
  });
  app.route(manifest.basePath, manifest.routes);
  // Fixture routes — one per authenticated route class, so revocation and
  // principal-kind enforcement is observable across the whole matrix. The
  // pending-2fa fixture mirrors the future verify route's principal gate.
  app.get('/t/session', routeClass('session'), (c) => c.json({ kind: c.var.principal.kind }));
  app.get('/t/billing', routeClass('billing-token'), (c) => c.json({ kind: c.var.principal.kind }));
  app.get('/t/pending', routeClass('pending-2fa'), (c) =>
    c.var.principal.kind === 'pending-2fa'
      ? c.json({ kind: c.var.principal.kind })
      : c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED), 401)
  );
  return app;
}

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return createApp().request(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    },
    testEnv
  );
}

async function get(path: string, cookie?: string): Promise<Response> {
  return createApp().request(path, { headers: cookie === undefined ? {} : { cookie } }, testEnv);
}

const KEY_BYTES = new Uint8Array([7, 7, 7]);
const KEY_BLOBS = {
  accountPublicKey: toBase64(KEY_BYTES),
  passwordWrappedPrivateKey: toBase64(KEY_BYTES),
  recoveryWrappedPrivateKey: toBase64(KEY_BYTES),
};

interface RegisterInitBody {
  registrationResponse: number[];
  registerSessionId: string;
}

async function registerInit(
  account: { email: string; username: string; password: string },
  client = createOpaqueClient()
): Promise<{ res: Response; body: RegisterInitBody }> {
  const { serialized } = await opaqueClientStartRegistration(client, account.password);
  const res = await post('/auth/register/init', {
    email: account.email,
    username: account.username,
    registrationRequest: serialized,
  });
  expect(res.status).toBe(200);
  return { res, body: await res.json() };
}

async function registerAccount(
  account = uniqueAccount()
): Promise<{ email: string; username: string; password: string; userId: string }> {
  const client = createOpaqueClient();
  const { body } = await registerInit(account, client);
  const { record } = await opaqueClientFinishRegistration(
    client,
    body.registrationResponse,
    OPAQUE_SERVER_IDENTIFIER
  );
  const res = await post('/auth/register/finish', {
    email: account.email,
    registrationRecord: record,
    registerSessionId: body.registerSessionId,
    ...KEY_BLOBS,
  });
  expect(res.status).toBe(201);
  const finished = await res.json();
  expect(finished.success).toBe(true);
  return { ...account, userId: finished.userId };
}

afterAll(async () => {
  await db.delete(users).where(like(users.username, `${PREFIX}%`));
  await db.$client.end();
});

describe('identity routes: registration', () => {
  it('completes the two-round OPAQUE registration and stores the wrapped keys', async () => {
    const created = await registerAccount();
    const [row] = await db
      .select({
        email: users.email,
        emailVerified: users.emailVerified,
        publicKey: users.publicKey,
        passwordWrappedPrivateKey: users.passwordWrappedPrivateKey,
        recoveryWrappedPrivateKey: users.recoveryWrappedPrivateKey,
      })
      .from(users)
      .where(eq(users.id, created.userId));
    expect(row?.email).toBe(created.email);
    expect(row?.emailVerified).toBe(false);
    expect([...(row?.publicKey ?? [])]).toEqual([...KEY_BYTES]);
    expect([...(row?.passwordWrappedPrivateKey ?? [])]).toEqual([...KEY_BYTES]);
    expect([...(row?.recoveryWrappedPrivateKey ?? [])]).toEqual([...KEY_BYTES]);
  });

  it('answers a duplicate email with the same fake-success shape and creates no second row', async () => {
    const existing = await registerAccount();
    const duplicate = { ...uniqueAccount(), email: existing.email };
    const client = createOpaqueClient();
    const { body } = await registerInit(duplicate, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const res = await post('/auth/register/finish', {
      email: duplicate.email,
      registrationRecord: record,
      registerSessionId: body.registerSessionId,
      ...KEY_BLOBS,
    });
    expect(res.status).toBe(201);
    const finished = await res.json();
    expect(finished.success).toBe(true);
    expect(finished.userId).not.toBe(existing.userId);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, existing.email));
    expect(rows).toHaveLength(1);
  });

  it('answers a duplicate username with the typed conflict', async () => {
    const existing = await registerAccount();
    const duplicate = { ...uniqueAccount(), username: existing.username };
    const client = createOpaqueClient();
    const { body } = await registerInit(duplicate, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const res = await post('/auth/register/finish', {
      email: duplicate.email,
      registrationRecord: record,
      registerSessionId: body.registerSessionId,
      ...KEY_BLOBS,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.USERNAME_TAKEN });
  });

  it('rejects malformed OPAQUE registration-request bytes as validation input', async () => {
    const account = uniqueAccount();
    const res = await post('/auth/register/init', {
      email: account.email,
      username: account.username,
      registrationRequest: [1, 2, 3],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a replayed register handshake (pending state is single-use)', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { body } = await registerInit(account, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finishBody = {
      email: account.email,
      registrationRecord: record,
      registerSessionId: body.registerSessionId,
      ...KEY_BLOBS,
    };
    expect((await post('/auth/register/finish', finishBody)).status).toBe(201);
    const replay = await post('/auth/register/finish', finishBody);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ code: ERROR_CODES.NO_PENDING_REGISTRATION });
  });

  it('rejects a finish whose email does not match the pending handshake', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { body } = await registerInit(account, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const res = await post('/auth/register/finish', {
      email: `other-${account.email}`,
      registrationRecord: record,
      registerSessionId: body.registerSessionId,
      ...KEY_BLOBS,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NO_PENDING_REGISTRATION });
  });

  it('bounds the pending registration state with the registry TTL', async () => {
    const account = uniqueAccount();
    const { body } = await registerInit(account);
    const ttl = await redis.ttl(
      IDENTITY_KEYS.opaquePendingRegistration.buildKey(body.registerSessionId)
    );
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(IDENTITY_KEYS.opaquePendingRegistration.ttlSeconds);
  });

  it('rate-limits registration per email at the registry window', async () => {
    const account = uniqueAccount();
    const { maxAttempts, windowSeconds } = IDENTITY_KEYS.registerRateLimit.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await registerInit(account);
    }
    const client = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(client, account.password);
    const res = await post('/auth/register/init', {
      email: account.email,
      username: account.username,
      registrationRequest: serialized,
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.details.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
  });
});

interface LoginInitBody {
  ke2: number[];
  loginSessionId: string;
}

async function loginInit(
  identifier: string,
  password: string,
  client = createOpaqueClient()
): Promise<{ res: Response; body: LoginInitBody }> {
  const { ke1 } = await opaqueClientStartLogin(client, password);
  const res = await post('/auth/login/init', { identifier, ke1 });
  return { res, body: await res.json() };
}

interface LoginSuccessBody {
  success: true;
  userId: string;
  email: string;
  passwordWrappedPrivateKey: string;
}

function sessionCookieOf(res: Response): string {
  const header = res.headers.get('set-cookie');
  expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
  const value = header?.split(`${SESSION_COOKIE_NAME}=`)[1]?.split(';')[0];
  return `${SESSION_COOKIE_NAME}=${value ?? ''}`;
}

async function login(identifier: string, password: string): Promise<Response> {
  const client = createOpaqueClient();
  const { res: initRes, body } = await loginInit(identifier, password, client);
  expect(initRes.status).toBe(200);
  const { ke3 } = await opaqueClientFinishLogin(client, body.ke2, OPAQUE_SERVER_IDENTIFIER);
  return post('/auth/login/finish', { identifier, ke3, loginSessionId: body.loginSessionId });
}

describe('identity routes: login', () => {
  it('completes the OPAQUE register→login round trip with the real crypto stack', async () => {
    const account = await registerAccount();
    const res = await login(account.email, account.password);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      userId: account.userId,
      email: account.email,
      passwordWrappedPrivateKey: KEY_BLOBS.passwordWrappedPrivateKey,
    });
    const cookie = sessionCookieOf(res);
    const probe = await get('/t/session', cookie);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ kind: 'full' });
  });

  it('logs in by username as well as email', async () => {
    const account = await registerAccount();
    const res = await login(account.username, account.password);
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password with the typed auth failure', async () => {
    const account = await registerAccount();
    const client = createOpaqueClient();
    const { body } = await loginInit(account.email, `wrong ${account.password}`, client);
    // A wrong password fails the client side of the AKE, so no honest KE3
    // exists; a stale KE3 from a different handshake exercises the server's
    // MAC verification failure path.
    const other = await registerAccount();
    const otherClient = createOpaqueClient();
    const { body: otherInit } = await loginInit(other.email, other.password, otherClient);
    const { ke3 } = await opaqueClientFinishLogin(
      otherClient,
      otherInit.ke2,
      OPAQUE_SERVER_IDENTIFIER
    );
    const res = await post('/auth/login/finish', {
      identifier: account.email,
      ke3,
      loginSessionId: body.loginSessionId,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
  });

  it('answers an unknown identifier with the same shape as a wrong password (enumeration safety)', async () => {
    const ghost = `${PREFIX}ghost@identity-routes.test`;
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, ghost));
    expect(rows).toHaveLength(0);

    const { res: initRes, body } = await loginInit(ghost, 'any password at all');
    expect(initRes.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['ke2', 'loginSessionId']);
    expect(body.ke2.length).toBeGreaterThan(0);

    const finishRes = await post('/auth/login/finish', {
      identifier: ghost,
      ke3: [0, 1, 2],
      loginSessionId: body.loginSessionId,
    });
    expect(finishRes.status).toBe(401);
    expect(await finishRes.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
  });

  it('refuses a locked account with the typed error even with the correct password', async () => {
    const account = await registerAccount();
    await db
      .update(users)
      .set({ lockedAt: new Date(), lockReason: 'admin' })
      .where(eq(users.id, account.userId));
    const res = await login(account.email, account.password);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.ACCOUNT_LOCKED });
  });

  it('rejects a replayed login handshake (pending state is single-use)', async () => {
    const account = await registerAccount();
    const client = createOpaqueClient();
    const { body } = await loginInit(account.email, account.password, client);
    const { ke3 } = await opaqueClientFinishLogin(client, body.ke2, OPAQUE_SERVER_IDENTIFIER);
    const finishBody = {
      identifier: account.email,
      ke3,
      loginSessionId: body.loginSessionId,
    };
    expect((await post('/auth/login/finish', finishBody)).status).toBe(200);
    const replay = await post('/auth/login/finish', finishBody);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ code: ERROR_CODES.NO_PENDING_LOGIN });
  });

  it('rejects a finish whose identifier does not match the pending handshake', async () => {
    const account = await registerAccount();
    const client = createOpaqueClient();
    const { body } = await loginInit(account.email, account.password, client);
    const { ke3 } = await opaqueClientFinishLogin(client, body.ke2, OPAQUE_SERVER_IDENTIFIER);
    const res = await post('/auth/login/finish', {
      identifier: `other-${account.email}`,
      ke3,
      loginSessionId: body.loginSessionId,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
  });

  it('bounds the pending login state with the registry TTL', async () => {
    const account = await registerAccount();
    const { body } = await loginInit(account.email, account.password);
    const ttl = await redis.ttl(IDENTITY_KEYS.opaquePendingLogin.buildKey(body.loginSessionId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(IDENTITY_KEYS.opaquePendingLogin.ttlSeconds);
  });

  it('rate-limits login per identifier at the registry window', async () => {
    const ghost = `${PREFIX}lim${crypto.randomUUID().slice(0, 8)}@identity-routes.test`;
    const { maxAttempts, windowSeconds } = IDENTITY_KEYS.loginRateLimit.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { res } = await loginInit(ghost, 'any password at all');
      expect(res.status).toBe(200);
    }
    const { res, body } = await loginInit(ghost, 'any password at all');
    expect(res.status).toBe(429);
    const denied = body as unknown as { code: string; details: { retryAfterSeconds: number } };
    expect(denied.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(denied.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.details.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
  });

  it('issues a pending-2fa session for a TOTP-enabled user', async () => {
    const account = await registerAccount();
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, account.userId));
    const res = await login(account.email, account.password);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requires2FA: true, userId: account.userId });

    const cookie = sessionCookieOf(res);
    const pendingProbe = await get('/t/pending', cookie);
    expect(pendingProbe.status).toBe(200);
    expect(await pendingProbe.json()).toEqual({ kind: 'pending-2fa' });
    expect((await get('/t/session', cookie)).status).toBe(403);
    expect((await get('/t/billing', cookie)).status).toBe(403);
  });
});

async function fullSessionCookie(): Promise<string> {
  const account = await registerAccount();
  const res = await login(account.email, account.password);
  expect(res.status).toBe(200);
  return sessionCookieOf(res);
}

async function pendingSessionCookie(): Promise<string> {
  const account = await registerAccount();
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, account.userId));
  const res = await login(account.email, account.password);
  expect(res.status).toBe(200);
  return sessionCookieOf(res);
}

async function billingSessionCookie(): Promise<string> {
  const account = await registerAccount();
  const response = new Response();
  const issued = await issueSession({
    request: new Request('http://localhost/billing/token-login'),
    response,
    redis,
    secret: SECRET,
    isProduction: false,
    userId: account.userId,
    kind: 'billing-only',
    now: Date.now(),
  });
  issued._unsafeUnwrap();
  return sessionCookieOf(response);
}

async function unsealClaims(cookie: string): Promise<SessionClaims> {
  const sealed = cookie.split(`${SESSION_COOKIE_NAME}=`)[1] ?? '';
  const claims = parseSessionClaims(await unsealData(sealed, { password: SECRET }));
  if (claims === null) throw new Error('test cookie did not unseal to valid claims');
  return claims;
}

describe('identity routes: logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const cookie = await fullSessionCookie();
    expect((await get('/t/session', cookie)).status).toBe(200);
    const res = await post('/auth/logout', {}, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await get('/t/session', cookie)).status).toBe(401);
  });

  it('succeeds without any session (naturally idempotent)', async () => {
    const res = await post('/auth/logout', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('succeeds when repeated with an already-revoked cookie', async () => {
    const cookie = await fullSessionCookie();
    expect((await post('/auth/logout', {}, cookie)).status).toBe(200);
    const repeat = await post('/auth/logout', {}, cookie);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ success: true });
  });
});

describe('identity routes: billing-only session lifecycle', () => {
  it('reaches billing-token routes but no full-session surface', async () => {
    const cookie = await billingSessionCookie();
    const billing = await get('/t/billing', cookie);
    expect(billing.status).toBe(200);
    expect(await billing.json()).toEqual({ kind: 'billing-only' });
    expect((await get('/t/session', cookie)).status).toBe(403);
    expect((await get('/t/pending', cookie)).status).toBe(401);
  });
});

describe('identity routes: revocation across every authenticated route class', () => {
  type RouteClassName = 'session' | 'pending-2fa' | 'billing-token';
  const CLASS_FIXTURES: Record<RouteClassName, { path: string; cookie: () => Promise<string> }> = {
    session: { path: '/t/session', cookie: fullSessionCookie },
    'pending-2fa': { path: '/t/pending', cookie: pendingSessionCookie },
    'billing-token': { path: '/t/billing', cookie: billingSessionCookie },
  };

  type Scenario = 'logout-revoked' | 'session-key-absent' | 'issued-before-password-change';
  async function revoke(cookie: string, scenario: Scenario): Promise<void> {
    if (scenario === 'logout-revoked') {
      expect((await post('/auth/logout', {}, cookie)).status).toBe(200);
      return;
    }
    const claims = await unsealClaims(cookie);
    if (scenario === 'session-key-absent') {
      await redis.del(IDENTITY_KEYS.sessionActive.buildKey(claims.userId, claims.sessionId));
      return;
    }
    const written = await redisSet(
      redis,
      IDENTITY_KEYS.passwordChangedAt,
      claims.createdAt + 1,
      claims.userId
    );
    written._unsafeUnwrap();
  }

  const matrix: [Scenario, RouteClassName][] = (
    ['logout-revoked', 'session-key-absent', 'issued-before-password-change'] as const
  ).flatMap((scenario) =>
    (['session', 'pending-2fa', 'billing-token'] as const).map(
      (cls): [Scenario, RouteClassName] => [scenario, cls]
    )
  );

  it.each(matrix)('rejects a %s cookie on the %s route class', async (scenario, cls) => {
    const fixture = CLASS_FIXTURES[cls];
    const cookie = await fixture.cookie();
    expect((await get(fixture.path, cookie)).status).toBe(200);
    await revoke(cookie, scenario);
    const res = await get(fixture.path, cookie);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });
});
