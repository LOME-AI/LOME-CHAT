import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { conversations, users } from '@hushbox/db';
import {
  createOpaqueClient,
  generateTotpCodeSync,
  startLogin as opaqueClientStartLogin,
} from '@hushbox/crypto';
import { DELETE_ACCOUNT_CONFIRMATION_PHRASE, ERROR_CODES } from '@hushbox/shared';
import { IDENTITY_KEYS } from './domain/keys.js';
import {
  PREFIX,
  db,
  enrollTotp,
  post,
  redis,
  registerLoginFull,
  stepUpKe3,
  wrongCode,
} from './routes.integration.setup.js';

// Symmetry guard: this file carries the identical PREFIX-scoped `conversations`
// reclaim as its sibling so either deletion file stays self-cleaning if a test
// that seeds a conversation later lands here. It runs BEFORE the setup module's
// afterAll (vitest runs afterAll LIFO), clearing any FK dependents before the
// shared `users` delete; the cross-slice write stays inside a `*.test.ts` file,
// which the single-writer-per-table arch rule exempts.
afterAll(async () => {
  const prefixPattern = `${PREFIX}%`;
  await db
    .delete(conversations)
    .where(
      sql`${conversations.userId} IN (SELECT ${users.id} FROM ${users} WHERE ${users.username} LIKE ${prefixPattern})`
    );
});

describe('identity routes: account-deletion request', () => {
  async function deleteInit(
    cookie: string,
    password: string
  ): Promise<{ ke2: number[]; sessionId: string; client: ReturnType<typeof createOpaqueClient> }> {
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, password);
    const res = await post('/auth/account/delete/init', { ke1 }, cookie);
    expect(res.status).toBe(200);
    const body = await res.json<{ ke2: number[]; deleteAccountSessionId: string }>();
    return { ke2: body.ke2, sessionId: body.deleteAccountSessionId, client };
  }

  async function deleteFinish(
    cookie: string,
    init: { ke2: number[]; sessionId: string; client: ReturnType<typeof createOpaqueClient> },
    extra: { ke3?: number[]; confirmationPhrase?: string; totpCode?: string } = {}
  ): Promise<Response> {
    const ke3 = extra.ke3 ?? (await stepUpKe3(init.ke2, init.client));
    return post(
      '/auth/account/delete/finish',
      {
        ke3,
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: extra.confirmationPhrase ?? DELETE_ACCOUNT_CONFIRMATION_PHRASE,
        ...(extra.totpCode !== undefined && { totpCode: extra.totpCode }),
      },
      cookie
    );
  }

  it('locks out after the registry number of failed deletion step-ups', async () => {
    const { account, cookie } = await registerLoginFull();
    const { maxAttempts } = IDENTITY_KEYS.deleteAccountLockout.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const init = await deleteInit(cookie, account.password);
      const bad = await post(
        '/auth/account/delete/finish',
        {
          ke3: [0, 1, 2],
          deleteAccountSessionId: init.sessionId,
          confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
        },
        cookie
      );
      expect(bad.status).toBe(401);
      expect(await bad.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
    }
    const init = await deleteInit(cookie, account.password);
    const locked = await post(
      '/auth/account/delete/finish',
      {
        ke3: [0, 1, 2],
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie
    );
    expect(locked.status).toBe(403);
    const lockedBody = await locked.json<{ code: string }>();
    expect(lockedBody.code).toBe(ERROR_CODES.DELETE_ACCOUNT_LOCKED);
  });

  it('engages the delete-account lock on the 3rd consecutive failed step-up', async () => {
    // Legacy parity (`legacy/apps/api/src/legacy/lib/rate-limit.ts:180`,
    // `count >= maxAttempts`): the first two failed step-ups answer AUTH_FAILED,
    // and the 3rd surfaces DELETE_ACCOUNT_LOCKED — the reserve-before-verify gate
    // admits exactly two before the third reservation locks.
    const { account, cookie } = await registerLoginFull();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const init = await deleteInit(cookie, account.password);
      const bad = await post(
        '/auth/account/delete/finish',
        {
          ke3: [0, 1, 2],
          deleteAccountSessionId: init.sessionId,
          confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
        },
        cookie
      );
      expect(bad.status).toBe(401);
      expect(await bad.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
    }
    const init = await deleteInit(cookie, account.password);
    const locked = await post(
      '/auth/account/delete/finish',
      {
        ke3: [0, 1, 2],
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie
    );
    expect(locked.status).toBe(403);
    const lockedBody = await locked.json<{
      code: string;
      details: { retryAfterSeconds: number };
    }>();
    expect(lockedBody.code).toBe(ERROR_CODES.DELETE_ACCOUNT_LOCKED);
    expect(lockedBody.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('locks out a 2FA account after the registry number of wrong-TOTP deletion attempts', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const { maxAttempts } = IDENTITY_KEYS.deleteAccountLockout.rateLimitConfig;
    // Valid password proof + wrong TOTP burns a deletion-gate attempt each time
    // (the gate reserves before the TOTP verdict), so each is a plain 400 until
    // the gate exhausts.
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const init = await deleteInit(cookie, account.password);
      const bad = await deleteFinish(cookie, init, { totpCode: wrongCode(secret) });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ code: ERROR_CODES.INVALID_TOTP_CODE });
    }
    const init = await deleteInit(cookie, account.password);
    const locked = await deleteFinish(cookie, init, { totpCode: wrongCode(secret) });
    expect(locked.status).toBe(403);
    const lockedBody = await locked.json<{
      code: string;
      details: { retryAfterSeconds: number };
    }>();
    expect(lockedBody.code).toBe(ERROR_CODES.DELETE_ACCOUNT_LOCKED);
    expect(typeof lockedBody.details.retryAfterSeconds).toBe('number');
    expect(lockedBody.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('engages a separate 24-hour hard lock once the 1-hour guessing gate is exhausted', async () => {
    const { account, cookie } = await registerLoginFull();
    const { maxAttempts, windowSeconds } = IDENTITY_KEYS.deleteAccountLockout.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const init = await deleteInit(cookie, account.password);
      await post(
        '/auth/account/delete/finish',
        {
          ke3: [0, 1, 2],
          deleteAccountSessionId: init.sessionId,
          confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
        },
        cookie
      );
    }
    const init = await deleteInit(cookie, account.password);
    const locked = await post(
      '/auth/account/delete/finish',
      {
        ke3: [0, 1, 2],
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie
    );
    expect(locked.status).toBe(403);
    const body = await locked.json<{ code: string; details: { retryAfterSeconds: number } }>();
    expect(body.code).toBe(ERROR_CODES.DELETE_ACCOUNT_LOCKED);
    // The engaged lock freezes deletion for a full day, not the guessing window.
    expect(body.details.retryAfterSeconds).toBeGreaterThan(windowSeconds);

    // Two distinct Redis keys with distinct windows: the 1-hour guessing gate
    // and the 24-hour hard lock (the restored legacy split).
    const gateTtl = await redis.ttl(IDENTITY_KEYS.deleteAccountLockout.buildKey(account.userId));
    const hardLockTtl = await redis.ttl(
      IDENTITY_KEYS.deleteAccountHardLock.buildKey(account.userId)
    );
    expect(gateTtl).toBeGreaterThan(0);
    expect(gateTtl).toBeLessThanOrEqual(windowSeconds);
    expect(hardLockTtl).toBeGreaterThan(windowSeconds);
  });

  it('collapses a stolen handshake bound to another account onto no-step-up', async () => {
    const victim = await registerLoginFull();
    const attacker = await registerLoginFull();
    const victimInit = await deleteInit(victim.cookie, victim.account.password);
    // The attacker replays the victim's handshake id from their own session.
    const res = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(victimInit.ke2, victimInit.client),
        deleteAccountSessionId: victimInit.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      attacker.cookie
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NO_PENDING_STEP_UP });
  });

  it('rejects a wrong confirmation phrase without burning a lockout attempt', async () => {
    const { account, cookie } = await registerLoginFull();
    const init = await deleteInit(cookie, account.password);
    const res = await deleteFinish(cookie, init, { confirmationPhrase: 'delete my acount' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.INVALID_CONFIRMATION_PHRASE });
    // No deletion attempt was reserved (the phrase gate runs first).
    expect(await redis.get(IDENTITY_KEYS.deleteAccountLockout.buildKey(account.userId))).toBeNull();
    // And nothing was deleted.
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(1);
  });

  it('requires a TOTP code when the account has 2FA enabled', async () => {
    const { account, cookie } = await registerLoginFull();
    await enrollTotp(cookie);
    const init = await deleteInit(cookie, account.password);
    const res = await deleteFinish(cookie, init);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.TOTP_CODE_REQUIRED });
  });

  it('rejects a wrong TOTP code at deletion with the typed invalid-code error', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const init = await deleteInit(cookie, account.password);
    const res = await deleteFinish(cookie, init, { totpCode: wrongCode(secret) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.INVALID_TOTP_CODE });
  });

  it('returns the delete-account lock when the TOTP lockout is already tripped at deletion', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const { maxAttempts } = IDENTITY_KEYS.twoFactorLockout.rateLimitConfig;
    await redis.set(IDENTITY_KEYS.twoFactorLockout.buildKey(account.userId), maxAttempts);
    const init = await deleteInit(cookie, account.password);
    const res = await deleteFinish(cookie, init, { totpCode: generateTotpCodeSync(secret) });
    expect(res.status).toBe(403);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe(ERROR_CODES.DELETE_ACCOUNT_LOCKED);
  });
});
