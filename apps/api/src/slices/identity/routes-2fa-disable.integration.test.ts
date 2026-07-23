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
import {
  db,
  disabledEmailFailure,
  enrollTotp,
  loginInit,
  post,
  registerAccount,
  registerLoginFull,
  sentTwoFactorDisabled,
  stepUpKe3,
  wrongCode,
} from './routes.integration.setup.js';

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
