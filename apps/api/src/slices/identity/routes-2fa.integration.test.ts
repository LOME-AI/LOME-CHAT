import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import { generateTotpCodeSync } from '@hushbox/crypto';
import { ERROR_CODES } from '@hushbox/shared';
import { IDENTITY_KEYS } from './domain/keys.js';
import { issueBillingLoginToken } from './domain/billing-portal.js';
import {
  db,
  enrollTotp,
  evictedUserIds,
  expectStatus,
  get,
  login,
  post,
  redis,
  registerAccount,
  registerLoginFull,
  sessionCookieOf,
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
