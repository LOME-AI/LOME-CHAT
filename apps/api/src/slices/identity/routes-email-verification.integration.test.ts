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
import { ERROR_CODES } from '@hushbox/shared';
import { IDENTITY_KEYS } from './domain/keys.js';
import {
  PREFIX,
  createApp,
  db,
  enrollTotp,
  expectStatus,
  get,
  loginInit,
  loginRoundTrip,
  markVerified,
  post,
  redis,
  registerAccount,
  registerLoginFull,
  sentAccountLocked,
  sentTwoFactorDisabled,
  sentTwoFactorEnabled,
  sentVerifications,
  testEnv,
} from './routes.integration.setup.js';

describe('identity routes: email verification', () => {
  it('resends, exposes the dev link, verifies, and rejects the replay', async () => {
    const account = await registerAccount();
    sentVerifications.length = 0;
    const resend = await post('/auth/verify-email/resend', { email: account.email });
    expect(resend.status).toBe(200);
    expect(await resend.json()).toEqual({ success: true });
    // AC5: sent via the EmailSender port.
    const sent = sentVerifications.find((m) => m.to === account.email.toLowerCase());
    expect(sent).toBeDefined();

    const devLink = await get(
      `/auth/verify-email/dev-link?email=${encodeURIComponent(account.email)}`
    );
    expect(devLink.status).toBe(200);
    const { token } = await devLink.json<{ token: string }>();
    expect(token).toBe(sent?.token);

    const verify = await post('/auth/verify-email', { token });
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ success: true });
    const [row] = await db
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, account.userId));
    expect(row?.emailVerified).toBe(true);

    const replay = await post('/auth/verify-email', { token });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ code: ERROR_CODES.INVALID_VERIFICATION_TOKEN });
  });

  it('rejects an unknown token', async () => {
    const res = await post('/auth/verify-email', { token: crypto.randomUUID() });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.INVALID_VERIFICATION_TOKEN });
  });

  it('answers resend for an unknown email with the same success shape and sends nothing', async () => {
    sentVerifications.length = 0;
    const ghost = `${PREFIX}unknown@identity-routes.test`;
    const res = await post('/auth/verify-email/resend', { email: ghost });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(sentVerifications.some((m) => m.to === ghost)).toBe(false);
  });

  it('rate-limits resend at the registry window', async () => {
    const account = await registerAccount();
    const { maxAttempts } = IDENTITY_KEYS.resendVerifyRateLimit.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await expectStatus(post('/auth/verify-email/resend', { email: account.email }), 200);
    }
    const limited = await post('/auth/verify-email/resend', { email: account.email });
    expect(limited.status).toBe(429);
    const limitedBody = await limited.json<{ code: string }>();
    expect(limitedBody.code).toBe(ERROR_CODES.RATE_LIMITED);
  });

  it('rate-limits verify-email consume per token at the registry window', async () => {
    const token = crypto.randomUUID();
    const { maxAttempts } = IDENTITY_KEYS.verifyTokenRateLimit.rateLimitConfig;
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        // Unknown token: admitted past the per-token window, answers invalid.
        await expectStatus(post('/auth/verify-email', { token }), 400);
      }
      const limited = await post('/auth/verify-email', { token });
      expect(limited.status).toBe(429);
      const limitedBody = await limited.json<{ code: string }>();
      expect(limitedBody.code).toBe(ERROR_CODES.RATE_LIMITED);
    } finally {
      await redis.del(IDENTITY_KEYS.verifyTokenRateLimit.buildKey(token));
    }
  });

  it('hides the dev-link endpoint in production', async () => {
    const account = await registerAccount();
    const productionEnv = { ...testEnv, NODE_ENV: 'production' as const };
    const res = await createApp().request(
      `/auth/verify-email/dev-link?email=${encodeURIComponent(account.email)}`,
      {},
      productionEnv
    );
    expect(res.status).toBe(404);
  });
});

describe('identity routes: email-verify login gate (D1)', () => {
  it('refuses login for an unverified account and does not consume the lockout', async () => {
    const account = await registerAccount();
    const res = await loginRoundTrip(account.email, account.password);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.EMAIL_NOT_VERIFIED });
    expect(res.headers.get('set-cookie')).toBeNull();
    // The pending-login handshake was consumed (single-use), but the lockout
    // counter keeps its init reservation — an unverified login is not a
    // verified success that clears it.
    expect(await redis.get(IDENTITY_KEYS.loginLockout.buildKey(account.userId))).toBe(1);
  });

  it('logs in normally once the email is verified', async () => {
    const account = await registerAccount();
    await markVerified(account.email);
    const res = await loginRoundTrip(account.email, account.password);
    expect(res.status).toBe(200);
  });

  it('does not gate an account with no email (guest-origin)', async () => {
    const account = await registerAccount();
    // The empty email is globally unique (users_email_unique); restore a unique
    // value in a finally so no orphan `email=''` row survives to poison a
    // concurrent file or a later run with a 23505 unique violation.
    await db.update(users).set({ email: '' }).where(eq(users.id, account.userId));
    try {
      const res = await loginRoundTrip(account.username, account.password);
      expect(res.status).toBe(200);
    } finally {
      await db.update(users).set({ email: account.email }).where(eq(users.id, account.userId));
    }
  });
});

describe('identity routes: security notification emails (D3)', () => {
  it('sends the TOTP-enabled email on enrollment', async () => {
    const { account, cookie } = await registerLoginFull();
    await enrollTotp(cookie);
    expect(sentTwoFactorEnabled.some((message) => message.to === account.email.toLowerCase())).toBe(
      true
    );
  });

  it('sends the TOTP-disabled email on disable', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const init = await post('/auth/2fa/disable/init', { ke1 }, cookie);
    const initBody = await init.json<{ ke2: number[]; disable2FASessionId: string }>();
    const { ke3 } = await opaqueClientFinishLogin(client, initBody.ke2, OPAQUE_SERVER_IDENTIFIER);
    const finish = await post(
      '/auth/2fa/disable/finish',
      {
        ke3,
        code: generateTotpCodeSync(secret),
        disable2FASessionId: initBody.disable2FASessionId,
      },
      cookie
    );
    expect(finish.status).toBe(200);
    expect(
      sentTwoFactorDisabled.some((message) => message.to === account.email.toLowerCase())
    ).toBe(true);
  });

  it('sends the account-locked email once when the login lockout trips for a known account', async () => {
    const account = await registerAccount();
    sentAccountLocked.length = 0;
    const { maxAttempts, windowSeconds } = IDENTITY_KEYS.loginLockout.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await loginInit(account.email, 'wrong password entirely');
    }
    // The next init crosses the cap: it trips the lockout (429) and fires the
    // one-shot notification.
    const tripped = await loginInit(account.email, 'wrong password entirely');
    expect(tripped.res.status).toBe(429);
    const forAccount = sentAccountLocked.filter(
      (message) => message.to === account.email.toLowerCase()
    );
    expect(forAccount).toHaveLength(1);
    expect(forAccount[0]?.lockoutMinutes).toBe(Math.floor(windowSeconds / 60));
    // A further locked attempt does not re-send — justTriggered fires once.
    await loginInit(account.email, 'wrong password entirely');
    expect(
      sentAccountLocked.filter((message) => message.to === account.email.toLowerCase())
    ).toHaveLength(1);
  });
});
