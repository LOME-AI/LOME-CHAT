import { describe, expect, it } from 'vitest';
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
import {
  PREFIX,
  db,
  enrollTotp,
  expectStatus,
  login,
  post,
  registerAccount,
  registerLoginFull,
  sessionCookieOf,
  stepUpKe3,
} from './routes.integration.setup.js';

describe('identity routes: enumeration timing', () => {
  const TIMING_FACTOR = 3.5;
  const WARMUP = 2;

  function median(values: number[]): number {
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  }

  /** Interleaves the two classes so drift (GC, pool warmth) hits both alike. */
  async function sampleMedians(
    known: (sample: number) => Promise<Response>,
    unknown: (sample: number) => Promise<Response>,
    samples: number
  ): Promise<{ knownMedian: number; unknownMedian: number }> {
    for (let warm = 0; warm < WARMUP; warm += 1) {
      await expectStatus(unknown(-1 - warm), 200);
    }
    const knownTimings: number[] = [];
    const unknownTimings: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      for (const [runner, timings] of [
        [known, knownTimings],
        [unknown, unknownTimings],
      ] as const) {
        const start = performance.now();
        await expectStatus(runner(sample), 200);
        timings.push(performance.now() - start);
      }
    }
    return { knownMedian: median(knownTimings), unknownMedian: median(unknownTimings) };
  }

  function expectComparable(knownMedian: number, unknownMedian: number): void {
    expect(knownMedian).toBeGreaterThan(0);
    expect(unknownMedian).toBeGreaterThan(0);
    expect(unknownMedian).toBeGreaterThanOrEqual(knownMedian / TIMING_FACTOR);
    expect(knownMedian).toBeGreaterThanOrEqual(unknownMedian / TIMING_FACTOR);
  }

  function ghost(tag: string, sample: number): string {
    return `${PREFIX}ghost-${tag}-${String(sample + WARMUP + 1)}@identity-routes.test`;
  }

  it('answers recovery get-wrapped-key in comparable time for known and unknown accounts', async () => {
    // Two accounts, alternated: the per-identifier throttle allows 3 reads, so
    // 6 samples keep each real account at exactly the cap (3 reads apiece).
    const accounts = [await registerAccount(), await registerAccount()];
    const { knownMedian, unknownMedian } = await sampleMedians(
      (sample) =>
        post('/auth/recovery/get-wrapped-key', {
          identifier: accounts[sample % accounts.length]?.email,
        }),
      (sample) => post('/auth/recovery/get-wrapped-key', { identifier: ghost('getkey', sample) }),
      6
    );
    expectComparable(knownMedian, unknownMedian);
  });

  it('answers recovery reset init in comparable time for known and unknown accounts', async () => {
    const accounts = [await registerAccount(), await registerAccount()];
    async function resetInit(identifier: string): Promise<Response> {
      const { serialized } = await opaqueClientStartRegistration(
        createOpaqueClient(),
        'a fresh password'
      );
      return post('/auth/recovery/reset/init', {
        identifier,
        newRegistrationRequest: serialized,
      });
    }
    const { knownMedian, unknownMedian } = await sampleMedians(
      (sample) => resetInit(accounts[sample % accounts.length]?.email ?? ''),
      (sample) => resetInit(ghost('reset', sample)),
      6
    );
    expectComparable(knownMedian, unknownMedian);
  });

  it('answers verification resend in comparable time for known and unknown emails', async () => {
    // The resend throttle is 1 per email per 60s, so each sample needs a fresh
    // known account (a second resend for the same email would 429) — mirroring
    // the unknown side, which already uses a distinct ghost per sample.
    const accounts = [await registerAccount(), await registerAccount(), await registerAccount()];
    const { knownMedian, unknownMedian } = await sampleMedians(
      (sample) => post('/auth/verify-email/resend', { email: accounts[sample]?.email }),
      (sample) => post('/auth/verify-email/resend', { email: ghost('resend', sample) }),
      3
    );
    expectComparable(knownMedian, unknownMedian);
  });
});

describe('identity routes: store-outcome and decode edges', () => {
  it('answers already-enabled when the account gets enabled between setup and verify', async () => {
    const { account, cookie } = await registerLoginFull();
    const setup = await post('/auth/2fa/setup', {}, cookie);
    const { secret } = await setup.json<{ secret: string }>();
    // Flip enabled directly so the atomic enable transition matches 0 rows.
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, account.userId));
    const verify = await post('/auth/2fa/verify', { code: generateTotpCodeSync(secret) }, cookie);
    expect(verify.status).toBe(400);
    expect(await verify.json()).toEqual({ code: ERROR_CODES.TOTP_ALREADY_ENABLED });
  });

  it('answers not-enabled when TOTP is disabled between disable init and finish', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const init = await post('/auth/2fa/disable/init', { ke1 }, cookie);
    const initBody = await init.json<{ ke2: number[]; disable2FASessionId: string }>();
    const ke3 = await stepUpKe3(initBody.ke2, client);
    // Disable the flag (keep the secret) so the atomic disable matches 0 rows.
    await db.update(users).set({ totpEnabled: false }).where(eq(users.id, account.userId));
    const finish = await post(
      '/auth/2fa/disable/finish',
      {
        ke3,
        code: generateTotpCodeSync(secret),
        disable2FASessionId: initBody.disable2FASessionId,
      },
      cookie
    );
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.TOTP_NOT_ENABLED });
  });

  it('rejects a replayed TOTP code at login 2FA', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const code = generateTotpCodeSync(secret);
    const first = await login(account.email, account.password);
    const firstVerify = await post('/auth/login/2fa/verify', { code }, sessionCookieOf(first));
    expect(firstVerify.status).toBe(200);
    // A second login reusing the same (still-in-window) code hits replay guard.
    const second = await login(account.email, account.password);
    const replay = await post('/auth/login/2fa/verify', { code }, sessionCookieOf(second));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ code: ERROR_CODES.INVALID_TOTP_CODE });
  });

  it('rejects a change-password finish with a malformed wrapped key', async () => {
    const { account, cookie } = await registerLoginFull();
    const stepClient = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(stepClient, account.password);
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'decode-edge pw');
    const init = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    const initBody = await init.json<{
      ke2: number[];
      newRegistrationResponse: number[];
      changePasswordSessionId: string;
    }>();
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
        newPasswordWrappedPrivateKey: '!!!not-base64!!!',
        changePasswordSessionId: initBody.changePasswordSessionId,
      },
      cookie
    );
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a recovery reset finish with a malformed wrapped key', async () => {
    const account = await registerAccount();
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'decode recovery pw');
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
    const finish = await post('/auth/recovery/reset/finish', {
      identifier: account.email,
      newRegistrationRecord: record,
      newPasswordWrappedPrivateKey: '!!!not-base64!!!',
      recoverySessionId: initBody.recoverySessionId,
    });
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });
});
