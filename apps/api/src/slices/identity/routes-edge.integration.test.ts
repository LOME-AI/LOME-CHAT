import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration as opaqueClientFinishRegistration,
  generateTotpCodeSync,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { ERROR_CODES } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { IDENTITY_KEYS } from './domain/keys.js';
import { checkSessionRevocation, createIdentityManifest, createIdentityStores } from './index.js';
import {
  KEY_BLOBS,
  NEW_WRAPPED_KEY,
  PREFIX,
  db,
  emailPortFailure,
  enrollTotp,
  expectStatus,
  get,
  login,
  manifestDeps,
  post,
  redis,
  registerAccount,
  registerLoginFull,
  sessionCookieOf,
  stepUpKe3,
  testEnv,
  wrongCode,
} from './routes.integration.setup.js';
import type { AppEnv } from '../../lib/context/index.js';
import type { IdentityStores } from './index.js';

describe('identity routes: edge states for coverage', () => {
  it('returns 500 when a TOTP-enabled account has no configured secret at login 2FA', async () => {
    const { account } = await registerLoginFull();
    await db
      .update(users)
      .set({ totpEnabled: true, totpSecretEncrypted: null })
      .where(eq(users.id, account.userId));
    const loginRes = await login(account.email, account.password);
    const pendingCookie = sessionCookieOf(loginRes);
    const verify = await post('/auth/login/2fa/verify', { code: '123456' }, pendingCookie);
    expect(verify.status).toBe(500);
  });

  it('treats an undecryptable stored TOTP secret as a defect (500)', async () => {
    const { account } = await registerLoginFull();
    await db
      .update(users)
      .set({ totpEnabled: true, totpSecretEncrypted: new Uint8Array([1, 2, 3]) })
      .where(eq(users.id, account.userId));
    const loginRes = await login(account.email, account.password);
    const pendingCookie = sessionCookieOf(loginRes);
    const verify = await post('/auth/login/2fa/verify', { code: '123456' }, pendingCookie);
    expect(verify.status).toBe(500);
  });

  it('treats a vanished authenticated user as a defect on TOTP setup', async () => {
    const { account, cookie } = await registerLoginFull();
    await db.delete(users).where(eq(users.id, account.userId));
    const res = await post('/auth/2fa/setup', {}, cookie);
    expect(res.status).toBe(500);
  });

  it('returns 500 disabling TOTP whose secret is missing after a valid step-up', async () => {
    const { account, cookie } = await registerLoginFull();
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, account.userId));
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const init = await post('/auth/2fa/disable/init', { ke1 }, cookie);
    const initBody = await init.json<{ ke2: number[]; disable2FASessionId: string }>();
    const ke3 = await stepUpKe3(initBody.ke2, client);
    const finish = await post(
      '/auth/2fa/disable/finish',
      { ke3, code: '123456', disable2FASessionId: initBody.disable2FASessionId },
      cookie
    );
    expect(finish.status).toBe(500);
  });

  it('rejects a recovery reset finish for an account deleted after init as no-pending', async () => {
    const account = await registerAccount();
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'post-delete password');
    const init = await post('/auth/recovery/reset/init', {
      identifier: account.email,
      newRegistrationRequest: serialized,
    });
    const initBody = await init.json<{
      newRegistrationResponse: number[];
      recoverySessionId: string;
    }>();
    const { record } = await opaqueClientFinishRegistration(
      newClient,
      initBody.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    await db.delete(users).where(eq(users.id, account.userId));
    const finish = await post('/auth/recovery/reset/finish', {
      identifier: account.email,
      newRegistrationRecord: record,
      newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
      recoverySessionId: initBody.recoverySessionId,
    });
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.NO_PENDING_RECOVERY });
  });

  it('locks out recovery get-wrapped-key at the registry cap, counting reserved attempts', async () => {
    const identifier = `${PREFIX}getkey@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.recoveryGetKeyLockout.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await expectStatus(post('/auth/recovery/get-wrapped-key', { identifier }), 200);
    }
    expect(await redis.get(IDENTITY_KEYS.recoveryGetKeyLockout.buildKey(identifier))).toBe(
      maxAttempts
    );
    await expectStatus(post('/auth/recovery/get-wrapped-key', { identifier }), 429);
  });

  it('admits exactly the cap under concurrent get-wrapped-key requests (atomic reservation)', async () => {
    const identifier = `${PREFIX}getkeyrace@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.recoveryGetKeyLockout.rateLimitConfig;
    const overshoot = 3;
    const responses = await Promise.all(
      Array.from({ length: maxAttempts + overshoot }, () =>
        post('/auth/recovery/get-wrapped-key', { identifier })
      )
    );
    const statuses = responses.map((res) => res.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(maxAttempts);
    expect(statuses.filter((status) => status === 429)).toHaveLength(overshoot);
  });

  it('locks out recovery reset init at the registry cap', async () => {
    const identifier = `${PREFIX}resetlim@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.recoveryResetLockout.rateLimitConfig;
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'rate limited pw');
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await expectStatus(
        post('/auth/recovery/reset/init', { identifier, newRegistrationRequest: serialized }),
        200
      );
    }
    await expectStatus(
      post('/auth/recovery/reset/init', { identifier, newRegistrationRequest: serialized }),
      429
    );
  });

  it('admits exactly the cap under concurrent reset inits (atomic reservation)', async () => {
    const identifier = `${PREFIX}resetrace@identity-routes.test`;
    const { maxAttempts } = IDENTITY_KEYS.recoveryResetLockout.rateLimitConfig;
    const overshoot = 3;
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'rate limited pw');
    const responses = await Promise.all(
      Array.from({ length: maxAttempts + overshoot }, () =>
        post('/auth/recovery/reset/init', { identifier, newRegistrationRequest: serialized })
      )
    );
    const statuses = responses.map((res) => res.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(maxAttempts);
    expect(statuses.filter((status) => status === 429)).toHaveLength(overshoot);
  });

  it('still answers success when the verification email send fails (best-effort)', async () => {
    const account = await registerAccount();
    emailPortFailure.shouldFail = true;
    try {
      const res = await post('/auth/verify-email/resend', { email: account.email });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    } finally {
      emailPortFailure.shouldFail = false;
    }
  });
});

describe('identity routes: more edge states for coverage', () => {
  it('treats a vanished user as a defect on change-password init', async () => {
    const { account, cookie } = await registerLoginFull();
    await db.delete(users).where(eq(users.id, account.userId));
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const { serialized } = await opaqueClientStartRegistration(createOpaqueClient(), 'x');
    const res = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    expect(res.status).toBe(500);
  });

  it('treats a vanished user as a defect on 2FA disable init', async () => {
    const { account, cookie } = await registerLoginFull();
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, account.userId));
    await db.delete(users).where(eq(users.id, account.userId));
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const res = await post('/auth/2fa/disable/init', { ke1 }, cookie);
    expect(res.status).toBe(500);
  });

  it('treats a vanished user as a defect on account-deletion init', async () => {
    const { account, cookie } = await registerLoginFull();
    await db.delete(users).where(eq(users.id, account.userId));
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const res = await post('/auth/account/delete/init', { ke1 }, cookie);
    expect(res.status).toBe(500);
  });

  it('rejects a change-password finish with a stale session id as no-step-up', async () => {
    const { account, cookie } = await registerLoginFull();
    const stepClient = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(stepClient, account.password);
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'stale pw change');
    const init = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    const initBody = await init.json<{ ke2: number[]; newRegistrationResponse: number[] }>();
    const { ke3 } = await opaqueClientFinishLogin(
      stepClient,
      initBody.ke2,
      OPAQUE_SERVER_IDENTIFIER
    );
    const { record } = await opaqueClientFinishRegistration(
      newClient,
      initBody.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finish = await post(
      '/auth/change-password/finish',
      {
        ke3,
        newRegistrationRecord: record,
        newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
        changePasswordSessionId: crypto.randomUUID(),
      },
      cookie
    );
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.NO_PENDING_STEP_UP });
  });

  it('collapses a cross-account 2FA-disable handshake onto no-step-up', async () => {
    const victim = await registerLoginFull();
    await enrollTotp(victim.cookie);
    const attacker = await registerLoginFull();
    await enrollTotp(attacker.cookie);
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, victim.account.password);
    const init = await post('/auth/2fa/disable/init', { ke1 }, victim.cookie);
    const initBody = await init.json<{ ke2: number[]; disable2FASessionId: string }>();
    const ke3 = await stepUpKe3(initBody.ke2, client);
    // Attacker replays the victim's disable handshake from their own session.
    const finish = await post(
      '/auth/2fa/disable/finish',
      { ke3, code: '000000', disable2FASessionId: initBody.disable2FASessionId },
      attacker.cookie
    );
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.NO_PENDING_STEP_UP });
  });

  it('reports too-many-attempts on 2FA disable when the account is locked out', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    // Exhaust the shared TOTP lockout via failed login-2FA attempts.
    const loginRes = await login(account.email, account.password);
    const pendingCookie = sessionCookieOf(loginRes);
    const { maxAttempts } = IDENTITY_KEYS.twoFactorLockout.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await post('/auth/login/2fa/verify', { code: wrongCode(secret) }, pendingCookie);
    }
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const init = await post('/auth/2fa/disable/init', { ke1 }, cookie);
    const initBody = await init.json<{ ke2: number[]; disable2FASessionId: string }>();
    const ke3 = await stepUpKe3(initBody.ke2, client);
    const finish = await post(
      '/auth/2fa/disable/finish',
      {
        ke3,
        code: generateTotpCodeSync(secret),
        disable2FASessionId: initBody.disable2FASessionId,
      },
      cookie
    );
    expect(finish.status).toBe(429);
    const lockedBody = await finish.json<{ code: string }>();
    expect(lockedBody.code).toBe(ERROR_CODES.TOO_MANY_ATTEMPTS);
  });

  it('returns the wrapped key by username as well as email', async () => {
    const account = await registerAccount();
    const res = await post('/auth/recovery/get-wrapped-key', { identifier: account.username });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      recoveryWrappedPrivateKey: KEY_BLOBS.recoveryWrappedPrivateKey,
    });
  });

  it('dev-link returns a null token when none has been issued', async () => {
    // Registration now issues a token (D2), so an account always has one; a
    // never-registered email is the "no token issued" case.
    const email = `${PREFIX}notoken${crypto.randomUUID().slice(0, 8)}@identity-routes.test`;
    const res = await get(`/auth/verify-email/dev-link?email=${encodeURIComponent(email)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null });
  });

  it('propagates a verification store failure on verify-email and dev-link', async () => {
    const failing: IdentityStores = {
      users: createIdentityStores(db).users,
      verification: {
        issueEmailVerification: () => errAsync(unavailableError('down')),
        issueVerificationDecoy: () => errAsync(unavailableError('down')),
        consumeEmailVerification: () => errAsync(unavailableError('down')),
        findUnverifiedByEmail: () => errAsync(unavailableError('down')),
        findLatestVerificationToken: () => errAsync(unavailableError('down')),
      },
    };
    const manifest = createIdentityManifest({ ...manifestDeps, stores: () => failing });
    const app = applyPipeline(new Hono<AppEnv>(), {
      session: { revocation: checkSessionRevocation },
    });
    app.route(manifest.basePath, manifest.routes);
    const verify = await app.request(
      '/auth/verify-email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: crypto.randomUUID() }),
      },
      testEnv
    );
    expect(verify.status).toBe(503);
    const devLink = await app.request(
      '/auth/verify-email/dev-link?email=someone@identity-routes.test',
      {},
      testEnv
    );
    expect(devLink.status).toBe(503);
  });
});
