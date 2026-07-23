import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishLogin as opaqueClientFinishLogin,
} from '@hushbox/crypto';
import { ERROR_CODES } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { redisSet } from '../../lib/redis/index.js';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { SESSION_COOKIE_NAME } from '../../lib/context/index.js';
import { IDENTITY_KEYS } from './domain/keys.js';
import { issueBillingLoginToken } from './domain/billing-portal.js';
import { fullClaims } from './routes.js';
import { checkSessionRevocation, createIdentityManifest, createIdentityStores } from './index.js';
import {
  KEY_BLOBS,
  PREFIX,
  billingSessionCookie,
  db,
  evictedUserIds,
  expectStatus,
  fullSessionCookie,
  get,
  login,
  loginInit,
  manifestDeps,
  markVerified,
  pendingSessionCookie,
  post,
  redis,
  registerAccount,
  registerLoginFull,
  sessionCookieOf,
  testEnv,
  unsealClaims,
} from './routes.integration.setup.js';
import type { AppEnv } from '../../lib/context/index.js';
import type { IdentityStores } from './index.js';
import type { LoginSuccessBody } from './routes.integration.setup.js';

describe('identity routes: login', () => {
  it('completes the OPAQUE register→login round trip with the real crypto stack', async () => {
    const account = await registerAccount();
    const res = await login(account.email, account.password);
    expect(res.status).toBe(200);
    const body = await res.json<LoginSuccessBody>();
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
    expect(Object.keys(body).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'ke2',
      'loginSessionId',
    ]);
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
    await markVerified(account.email);
    const client = createOpaqueClient();
    const { body } = await loginInit(account.email, account.password, client);
    const { ke3 } = await opaqueClientFinishLogin(client, body.ke2, OPAQUE_SERVER_IDENTIFIER);
    const finishBody = {
      identifier: account.email,
      ke3,
      loginSessionId: body.loginSessionId,
    };
    await expectStatus(post('/auth/login/finish', finishBody), 200);
    const replay = await post('/auth/login/finish', finishBody);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ code: ERROR_CODES.NO_PENDING_LOGIN });
  });

  it('mints exactly one session when two finish deliveries race the same handshake', async () => {
    const account = await registerAccount();
    await markVerified(account.email);
    const client = createOpaqueClient();
    const { body } = await loginInit(account.email, account.password, client);
    const { ke3 } = await opaqueClientFinishLogin(client, body.ke2, OPAQUE_SERVER_IDENTIFIER);
    const finishBody = { identifier: account.email, ke3, loginSessionId: body.loginSessionId };
    const [first, second] = await Promise.all([
      post('/auth/login/finish', finishBody),
      post('/auth/login/finish', finishBody),
    ]);
    const statuses = [first.status, second.status].toSorted((a, b) => a - b);
    // The atomic consume gives the handshake to one delivery; the loser sees
    // no pending state and restarts — never a second minted session.
    expect(statuses).toEqual([200, 400]);
    const winner = first.status === 200 ? first : second;
    const loser = first.status === 200 ? second : first;
    expect(winner.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(loser.headers.get('set-cookie')).toBeNull();
    expect(await loser.json()).toEqual({ code: ERROR_CODES.NO_PENDING_LOGIN });
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

  it('locks out login per identifier at the registry cap with a TTL-derived retry-after', async () => {
    const ghost = `${PREFIX}lim${crypto.randomUUID().slice(0, 8)}@identity-routes.test`;
    const { maxAttempts, windowSeconds } = IDENTITY_KEYS.loginLockout.rateLimitConfig;
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

  it('reserves login attempts on init and clears the counter on a verified login', async () => {
    const account = await registerAccount();
    const counterKey = IDENTITY_KEYS.loginLockout.buildKey(account.userId);
    await loginInit(account.email, 'wrong password entirely');
    await loginInit(account.email, 'wrong password entirely');
    expect(await redis.get(counterKey)).toBe(2);
    const res = await login(account.email, account.password);
    expect(res.status).toBe(200);
    expect(await redis.get(counterKey)).toBeNull();
  });

  it('admits exactly the cap under concurrent login inits (atomic reservation)', async () => {
    const ghost = `${PREFIX}race${crypto.randomUUID().slice(0, 8)}@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.loginLockout.rateLimitConfig;
    const overshoot = 3;
    const results = await Promise.all(
      Array.from({ length: maxAttempts + overshoot }, () => loginInit(ghost, 'any password at all'))
    );
    const statuses = results.map(({ res }) => res.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(maxAttempts);
    expect(statuses.filter((status) => status === 429)).toHaveLength(overshoot);
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
    await expectStatus(get('/t/session', cookie), 403);
    await expectStatus(get('/t/billing', cookie), 403);
  });
});

describe('identity routes: logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const cookie = await fullSessionCookie();
    const claims = await unsealClaims(cookie);
    await expectStatus(get('/t/session', cookie), 200);
    const res = await post('/auth/logout', {}, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    await expectStatus(get('/t/session', cookie), 401);
    // The revoke threads the eviction port through (ARCHITECTURE §15).
    expect(evictedUserIds).toContain(claims.userId);
  });

  it('succeeds without any session (naturally idempotent)', async () => {
    const res = await post('/auth/logout', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('succeeds when repeated with an already-revoked cookie', async () => {
    const cookie = await fullSessionCookie();
    await expectStatus(post('/auth/logout', {}, cookie), 200);
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
    await expectStatus(get('/t/session', cookie), 403);
    await expectStatus(get('/t/pending', cookie), 401);
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
      await expectStatus(post('/auth/logout', {}, cookie), 200);
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
    await expectStatus(get(fixture.path, cookie), 200);
    await revoke(cookie, scenario);
    const res = await get(fixture.path, cookie);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });
});

describe('identity routes: /me bootstrap', () => {
  it('returns the profile and crypto-key fields for a full session', async () => {
    const { account, cookie } = await registerLoginFull();
    const res = await get('/auth/me', cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: {
        id: account.userId,
        email: account.email,
        username: account.username,
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
      },
      passwordWrappedPrivateKey: KEY_BLOBS.passwordWrappedPrivateKey,
      publicKey: KEY_BLOBS.accountPublicKey,
    });
  });

  it('denies /me without a session (session-class default-deny)', async () => {
    const res = await get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('treats a vanished authenticated user as a defect (500)', async () => {
    const { account, cookie } = await registerLoginFull();
    await db.delete(users).where(eq(users.id, account.userId));
    const res = await get('/auth/me', cookie);
    expect(res.status).toBe(500);
  });

  it('propagates a store failure on /me', async () => {
    const { cookie } = await registerLoginFull();
    const real = createIdentityStores(db);
    const failing: IdentityStores = {
      users: { ...real.users, findById: () => errAsync(unavailableError('down')) },
      verification: real.verification,
    };
    const manifest = createIdentityManifest({ ...manifestDeps, stores: () => failing });
    const app = applyPipeline(new Hono<AppEnv>(), {
      session: { revocation: checkSessionRevocation },
    });
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request('/auth/me', { headers: { cookie } }, testEnv);
    expect(res.status).toBe(503);
  });
});

describe('identity routes: principal guards', () => {
  it('rejects a session-class route reached without a full principal', () => {
    const ctx = { var: { principal: { kind: 'none' as const } } } as never;
    expect(() => fullClaims(ctx)).toThrow(/full principal/);
  });
});

describe('identity routes: billing-portal token login', () => {
  async function issuedToken(): Promise<{ token: string; userId: string }> {
    const account = await registerAccount();
    const issued = await issueBillingLoginToken({ redis, userId: account.userId });
    return { token: issued._unsafeUnwrap().token, userId: account.userId };
  }

  it('mints a billing-only session cookie for a live token', async () => {
    const { token, userId } = await issuedToken();
    const res = await post('/auth/token-login', { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const cookie = sessionCookieOf(res);
    const claims = await unsealClaims(cookie);
    expect(claims.userId).toBe(userId);
    expect(claims.billingOnly).toBe(true);
  });

  it('admits the minted session to billing-token routes and nothing session-class', async () => {
    const { token } = await issuedToken();
    const cookie = sessionCookieOf(await post('/auth/token-login', { token }));
    const billing = await get('/t/billing', cookie);
    expect(billing.status).toBe(200);
    expect(await billing.json()).toEqual({ kind: 'billing-only' });
    await expectStatus(get('/t/session', cookie), 403);
  });

  it('replays the same token onto the same session with no second side effect', async () => {
    const { token } = await issuedToken();
    const first = await post('/auth/token-login', { token });
    const second = await post('/auth/token-login', { token });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstClaims = await unsealClaims(sessionCookieOf(first));
    const secondClaims = await unsealClaims(sessionCookieOf(second));
    expect(secondClaims.sessionId).toBe(firstClaims.sessionId);
  });

  it('answers unknown, deleted-user, and locked-account tokens with one uniform refusal', async () => {
    const unknown = await post('/auth/token-login', { token: crypto.randomUUID() });
    expect(unknown.status).toBe(401);
    const unknownBody = await unknown.json();
    expect(unknownBody).toEqual({ code: ERROR_CODES.LOGIN_TOKEN_INVALID });
    const { token, userId } = await issuedToken();
    await db.delete(users).where(eq(users.id, userId));
    const orphaned = await post('/auth/token-login', { token });
    expect(orphaned.status).toBe(401);
    expect(await orphaned.json()).toEqual(unknownBody);
    const locked = await issuedToken();
    await db
      .update(users)
      .set({ lockedAt: new Date(), lockReason: 'admin' })
      .where(eq(users.id, locked.userId));
    const refusedLocked = await post('/auth/token-login', { token: locked.token });
    expect(refusedLocked.status).toBe(401);
    expect(await refusedLocked.json()).toEqual(unknownBody);
  });

  it('rejects a malformed token body as validation input', async () => {
    const res = await post('/auth/token-login', { token: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('requires no Idempotency-Key header (the token is the key)', async () => {
    const { token } = await issuedToken();
    // `post` sends no Idempotency-Key; a 200 proves the token-is-key
    // exemption is declared on the route.
    await expectStatus(post('/auth/token-login', { token }), 200);
  });
});
