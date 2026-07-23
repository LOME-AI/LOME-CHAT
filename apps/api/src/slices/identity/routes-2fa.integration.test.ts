import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishLogin as opaqueClientFinishLogin,
  generateTotpCodeSync,
  startLogin as opaqueClientStartLogin,
} from '@hushbox/crypto';
import { DELETE_ACCOUNT_CONFIRMATION_PHRASE, ERROR_CODES } from '@hushbox/shared';
import { IDENTITY_KEYS } from './domain/keys.js';
import { issueBillingLoginToken } from './domain/billing-portal.js';
import {
  db,
  disabledEmailFailure,
  enrollTotp,
  evictedUserIds,
  expectStatus,
  get,
  login,
  loginInit,
  post,
  redis,
  registerAccount,
  registerLoginFull,
  sentTwoFactorDisabled,
  sessionCookieOf,
  stepUpKe3,
  wrongCode,
} from './routes.integration.setup.js';

describe('identity routes: TOTP enrollment and login 2FA', () => {
  it('enrolls TOTP, then promotes a pending-2fa login to full via a valid code', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const [row] = await db
      .select({ totpEnabled: users.totpEnabled, secret: users.totpSecretEncrypted })
      .from(users)
      .where(eq(users.id, account.userId));
    expect(row?.totpEnabled).toBe(true);
    expect(row?.secret).not.toBeNull();

    const loginRes = await login(account.email, account.password);
    expect(await loginRes.json()).toEqual({ requires2FA: true, userId: account.userId });
    const pendingCookie = sessionCookieOf(loginRes);

    const verify = await post(
      '/auth/login/2fa/verify',
      { code: generateTotpCodeSync(secret) },
      pendingCookie
    );
    expect(verify.status).toBe(200);
    const body = await verify.json<{ success: boolean; userId: string }>();
    expect(body.success).toBe(true);
    const fullCookie = sessionCookieOf(verify);
    const probe = await get('/t/session', fullCookie);
    expect(await probe.json()).toEqual({ kind: 'full' });
    // The pending-2fa → full rotation revokes through the eviction port.
    expect(evictedUserIds).toContain(account.userId);
  });

  it('rejects a wrong code at login 2FA with the typed invalid-code error', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const loginRes = await login(account.email, account.password);
    const pendingCookie = sessionCookieOf(loginRes);
    const verify = await post('/auth/login/2fa/verify', { code: wrongCode(secret) }, pendingCookie);
    expect(verify.status).toBe(400);
    expect(await verify.json()).toEqual({ code: ERROR_CODES.INVALID_TOTP_CODE });
  });

  it('rejects a wrong code during enrollment confirmation', async () => {
    const { cookie } = await registerLoginFull();
    const setup = await post('/auth/2fa/setup', {}, cookie);
    const { secret } = await setup.json<{ secret: string }>();
    const verify = await post('/auth/2fa/verify', { code: wrongCode(secret) }, cookie);
    expect(verify.status).toBe(400);
    expect(await verify.json()).toEqual({ code: ERROR_CODES.INVALID_TOTP_CODE });
  });

  it('refuses setup when TOTP is already enabled', async () => {
    const { cookie } = await registerLoginFull();
    await enrollTotp(cookie);
    const setup = await post('/auth/2fa/setup', {}, cookie);
    expect(setup.status).toBe(400);
    expect(await setup.json()).toEqual({ code: ERROR_CODES.TOTP_ALREADY_ENABLED });
  });

  it('rejects a verify with no pending setup', async () => {
    const { cookie } = await registerLoginFull();
    const verify = await post('/auth/2fa/verify', { code: '000000' }, cookie);
    expect(verify.status).toBe(400);
    expect(await verify.json()).toEqual({ code: ERROR_CODES.NO_PENDING_2FA_SETUP });
  });

  it('requires an authenticated session to set up TOTP', async () => {
    await expectStatus(post('/auth/2fa/setup', {}), 401);
  });
});

describe('identity routes: 2FA disable (step-up + code)', () => {
  async function disableInit(
    cookie: string,
    password: string
  ): Promise<{ ke2: number[]; sessionId: string; client: ReturnType<typeof createOpaqueClient> }> {
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, password);
    const res = await post('/auth/2fa/disable/init', { ke1 }, cookie);
    expect(res.status).toBe(200);
    const body = await res.json<{ ke2: number[]; disable2FASessionId: string }>();
    return { ke2: body.ke2, sessionId: body.disable2FASessionId, client };
  }

  it('disables TOTP with a valid step-up and code', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const init = await disableInit(cookie, account.password);
    const ke3 = await stepUpKe3(init.ke2, init.client);
    const finish = await post(
      '/auth/2fa/disable/finish',
      { ke3, code: generateTotpCodeSync(secret), disable2FASessionId: init.sessionId },
      cookie
    );
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ success: true });
    const [row] = await db
      .select({ totpEnabled: users.totpEnabled, secret: users.totpSecretEncrypted })
      .from(users)
      .where(eq(users.id, account.userId));
    expect(row?.totpEnabled).toBe(false);
    expect(row?.secret).toBeNull();
  });

  it('still disables TOTP when the security-notification send fails (best-effort)', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const init = await disableInit(cookie, account.password);
    const ke3 = await stepUpKe3(init.ke2, init.client);
    disabledEmailFailure.shouldFail = true;
    try {
      const finish = await post(
        '/auth/2fa/disable/finish',
        { ke3, code: generateTotpCodeSync(secret), disable2FASessionId: init.sessionId },
        cookie
      );
      expect(finish.status).toBe(200);
      expect(await finish.json()).toEqual({ success: true });
    } finally {
      disabledEmailFailure.shouldFail = false;
    }
    const [row] = await db
      .select({ totpEnabled: users.totpEnabled })
      .from(users)
      .where(eq(users.id, account.userId));
    expect(row?.totpEnabled).toBe(false);
  });

  it('disables TOTP without a notification when the account has no email', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    // A guest-origin account carries an empty email; the disable must still
    // succeed and simply skip the security notification. The empty email is
    // globally unique (users_email_unique), so restore a unique value in a
    // finally to free the slot for other suites/tests.
    await db.update(users).set({ email: '' }).where(eq(users.id, account.userId));
    try {
      const notificationsBefore = sentTwoFactorDisabled.length;
      const init = await disableInit(cookie, account.password);
      const ke3 = await stepUpKe3(init.ke2, init.client);
      const finish = await post(
        '/auth/2fa/disable/finish',
        { ke3, code: generateTotpCodeSync(secret), disable2FASessionId: init.sessionId },
        cookie
      );
      expect(finish.status).toBe(200);
      expect(await finish.json()).toEqual({ success: true });
      expect(sentTwoFactorDisabled.length).toBe(notificationsBefore);
      const [row] = await db
        .select({ totpEnabled: users.totpEnabled })
        .from(users)
        .where(eq(users.id, account.userId));
      expect(row?.totpEnabled).toBe(false);
    } finally {
      await db.update(users).set({ email: account.email }).where(eq(users.id, account.userId));
    }
  });

  it('rejects a wrong step-up password with the typed auth failure', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const init = await disableInit(cookie, account.password);
    // A KE3 from a mismatched-password handshake fails the 3DH MAC.
    const finish = await post(
      '/auth/2fa/disable/finish',
      { ke3: [0, 1, 2], code: generateTotpCodeSync(secret), disable2FASessionId: init.sessionId },
      cookie
    );
    expect(finish.status).toBe(401);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
  });

  it('rejects a stale disable session id as no-pending', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const init = await disableInit(cookie, account.password);
    const ke3 = await stepUpKe3(init.ke2, init.client);
    const finish = await post(
      '/auth/2fa/disable/finish',
      { ke3, code: generateTotpCodeSync(secret), disable2FASessionId: crypto.randomUUID() },
      cookie
    );
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.NO_PENDING_STEP_UP });
  });

  it('refuses disable init when TOTP is not enabled', async () => {
    const { account, cookie } = await registerLoginFull();
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const res = await post('/auth/2fa/disable/init', { ke1 }, cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.TOTP_NOT_ENABLED });
  });

  it('rejects a valid step-up with a wrong code', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const init = await disableInit(cookie, account.password);
    const ke3 = await stepUpKe3(init.ke2, init.client);
    const finish = await post(
      '/auth/2fa/disable/finish',
      { ke3, code: wrongCode(secret), disable2FASessionId: init.sessionId },
      cookie
    );
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.INVALID_TOTP_CODE });
  });
});

describe('identity routes: TOTP-verify lockout', () => {
  it('locks out after the registry number of failed login-2FA attempts', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const loginRes = await login(account.email, account.password);
    const pendingCookie = sessionCookieOf(loginRes);
    const { maxAttempts } = IDENTITY_KEYS.twoFactorLockout.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const res = await post('/auth/login/2fa/verify', { code: wrongCode(secret) }, pendingCookie);
      expect(res.status).toBe(400);
    }
    const locked = await post('/auth/login/2fa/verify', { code: wrongCode(secret) }, pendingCookie);
    expect(locked.status).toBe(429);
    const body = await locked.json<{ code: string; details: { retryAfterSeconds: number } }>();
    expect(body.code).toBe(ERROR_CODES.TOO_MANY_ATTEMPTS);
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('verifies at most the cap even under concurrent distinct wrong codes', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const loginRes = await login(account.email, account.password);
    const pendingCookie = sessionCookieOf(loginRes);
    const { maxAttempts } = IDENTITY_KEYS.twoFactorLockout.rateLimitConfig;
    const live = generateTotpCodeSync(secret);
    const codes = Array.from({ length: maxAttempts + 6 }, (_, n) =>
      String(n).padStart(6, '0')
    ).filter((code) => code !== live);
    const results = await Promise.all(
      codes
        .slice(0, maxAttempts + 5)
        .map((code) => post('/auth/login/2fa/verify', { code }, pendingCookie))
    );
    const statuses = results.map((res) => res.status);
    // The atomic attempt reservation bounds VERIFICATIONS, not just recorded
    // failures: exactly maxAttempts submissions reach the verifier (invalid),
    // the rest are gated before any crypto runs.
    expect(statuses.filter((status) => status === 400)).toHaveLength(maxAttempts);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });
});

describe('identity routes: step-up duplicate and well-formed bad proof', () => {
  it('treats an unknown delete handshake id as no-step-up (duplicate path)', async () => {
    const { cookie } = await registerLoginFull();
    const res = await post(
      '/auth/account/delete/finish',
      {
        ke3: [1, 2, 3],
        deleteAccountSessionId: crypto.randomUUID(),
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NO_PENDING_STEP_UP });
  });

  it('rejects a well-formed KE3 from a mismatched handshake as bad proof', async () => {
    const a = await registerLoginFull();
    const secretA = await enrollTotp(a.cookie);
    const clientA = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(clientA, a.account.password);
    const initA = await post('/auth/2fa/disable/init', { ke1 }, a.cookie);
    const initBody = await initA.json<{ ke2: number[]; disable2FASessionId: string }>();
    // A well-formed KE3 computed against a DIFFERENT account's handshake: it
    // deserializes cleanly but fails the 3DH MAC (the ternary bad-proof, not
    // the malformed-bytes catch path).
    const b = await registerAccount();
    const clientB = createOpaqueClient();
    const { body: initBLogin } = await loginInit(b.email, b.password, clientB);
    const { ke3: ke3B } = await opaqueClientFinishLogin(
      clientB,
      initBLogin.ke2,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finish = await post(
      '/auth/2fa/disable/finish',
      {
        ke3: ke3B,
        code: generateTotpCodeSync(secretA),
        disable2FASessionId: initBody.disable2FASessionId,
      },
      a.cookie
    );
    expect(finish.status).toBe(401);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
  });
});

describe('identity routes: login 2FA verify principal gate', () => {
  it('refuses a billing-only session gracefully instead of throwing', async () => {
    const account = await registerAccount();
    const issued = await issueBillingLoginToken({ redis, userId: account.userId });
    const login = await post('/auth/token-login', { token: issued._unsafeUnwrap().token });
    const cookie = sessionCookieOf(login);
    const res = await post('/auth/login/2fa/verify', { code: '123456' }, cookie);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('refuses a full session gracefully instead of throwing', async () => {
    const { cookie } = await registerLoginFull();
    const res = await post('/auth/login/2fa/verify', { code: '123456' }, cookie);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('refuses an anonymous caller gracefully instead of throwing', async () => {
    const res = await post('/auth/login/2fa/verify', { code: '123456' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });
});
