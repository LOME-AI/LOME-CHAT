import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { ledgerEntries, users, wallets } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration as opaqueClientFinishRegistration,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { ERROR_CODES } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { runSettlement } from '../../lib/idempotency/index.js';
import { IDENTITY_KEYS } from './domain/keys.js';
import { checkSessionRevocation, createIdentityManifest, createIdentityStores } from './index.js';
import { WELCOME_CREDIT_NANO_USD, provisionWalletsWithinTx } from '../billing/index.js';
import {
  KEY_BLOBS,
  KEY_BYTES,
  billingStores,
  db,
  emailPortFailure,
  expectStatus,
  get,
  loginInit,
  manifestDeps,
  post,
  redis,
  registerAccount,
  registerInit,
  sentVerifications,
  sentWelcome,
  testEnv,
  uniqueAccount,
} from './routes.integration.setup.js';
import type { AppEnv } from '../../lib/context/index.js';

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
    const finished = await res.json<{ success: boolean; userId: string }>();
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
    await expectStatus(post('/auth/register/finish', finishBody), 201);
    const replay = await post('/auth/register/finish', finishBody);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ code: ERROR_CODES.NO_PENDING_REGISTRATION });
  });

  it('creates exactly one row when two finish deliveries race the same handshake', async () => {
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
    const [first, second] = await Promise.all([
      post('/auth/register/finish', finishBody),
      post('/auth/register/finish', finishBody),
    ]);
    const statuses = [first.status, second.status].toSorted((a, b) => a - b);
    // The atomic consume gives the handshake to one delivery; the loser sees
    // no pending state — never a second INSERT attempt on the same account.
    expect(statuses).toEqual([201, 400]);
    const loser = first.status === 400 ? first : second;
    expect(await loser.json()).toEqual({ code: ERROR_CODES.NO_PENDING_REGISTRATION });
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, account.email));
    expect(rows).toHaveLength(1);
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
    const body = await res.json<{ code: string; details: { retryAfterSeconds: number } }>();
    expect(body.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.details.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
  });
});

describe('identity routes: input hardening', () => {
  it('rejects a schema-invalid body with the uniform validation shape', async () => {
    const res = await post('/auth/login/init', { identifier: 'x@identity-routes.test', ke1: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a malformed base64 key blob with the uniform validation shape', async () => {
    const account = uniqueAccount();
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
      accountPublicKey: '!!!!!',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('answers a typed conflict when the email is claimed between init and finish', async () => {
    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { body } = await registerInit(account, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    // The same email completes a full registration through a second
    // handshake while the first is still pending.
    await registerAccount({ ...uniqueAccount(), email: account.email });
    const res = await post('/auth/register/finish', {
      email: account.email,
      registrationRecord: record,
      registerSessionId: body.registerSessionId,
      ...KEY_BLOBS,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.EMAIL_TAKEN });
  });

  it('treats an account whose stored OPAQUE record is corrupt as a defect, not a 400', async () => {
    const account = uniqueAccount();
    const inserted = await createIdentityStores(db).users.insertRegistered({
      id: crypto.randomUUID(),
      email: account.email,
      username: account.username,
      opaqueRegistration: new Uint8Array([9, 9, 9]),
      publicKey: KEY_BYTES,
      passwordWrappedPrivateKey: KEY_BYTES,
      recoveryWrappedPrivateKey: KEY_BYTES,
    });
    inserted._unsafeUnwrap();
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, account.password);
    const res = await post('/auth/login/init', { identifier: account.email, ke1 });
    // Server-side data corruption is a DEFECT: it surfaces as a 500 (the
    // assembly's onError maps that to {code: INTERNAL} for telemetry as an
    // invariant break) and must NOT be the distinguishable 400 VALIDATION a
    // healthy account never returns. A malformed CLIENT record stays 400.
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(ERROR_CODES.VALIDATION);
  });

  it('collapses a user deleted mid-handshake onto auth-failed', async () => {
    const account = await registerAccount();
    const client = createOpaqueClient();
    const { body } = await loginInit(account.email, account.password, client);
    const { ke3 } = await opaqueClientFinishLogin(client, body.ke2, OPAQUE_SERVER_IDENTIFIER);
    await db.delete(users).where(eq(users.id, account.userId));
    const res = await post('/auth/login/finish', {
      identifier: account.email,
      ke3,
      loginSessionId: body.loginSessionId,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
  });
});

describe('identity routes: registration provisioning (wallets + welcome credit)', () => {
  it('provisions a purchased and free wallet with the welcome credit in one transaction', async () => {
    const account = await registerAccount();
    const rows = await db
      .select({ id: wallets.id, type: wallets.type, balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.userId, account.userId));
    const byType = new Map(rows.map((row) => [row.type, row]));
    const purchased = byType.get('purchased');
    expect(purchased).toBeDefined();
    expect(byType.get('free')).toBeDefined();
    // The welcome credit landed on the purchased wallet as a promo grant.
    expect(purchased?.balanceNanoUsd).toBe(WELCOME_CREDIT_NANO_USD);
    const legs = await db
      .select({ amountNanoUsd: ledgerEntries.amountNanoUsd, kind: ledgerEntries.kind })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, purchased?.id ?? ''));
    expect(legs).toEqual([{ amountNanoUsd: WELCOME_CREDIT_NANO_USD, kind: 'promo' }]);
  });

  it('sends the welcome email when the credit is granted', async () => {
    const account = await registerAccount();
    expect(sentWelcome.some((message) => message.to === account.email.toLowerCase())).toBe(true);
  });

  it('grants the welcome credit at most once per user (idempotent re-provision)', async () => {
    const account = await registerAccount();
    // A second provisioning pass (a retry) must not double-grant — the
    // welcome:<userId> ledger idempotency keys are the guard.
    await runSettlement(db, (tx) => provisionWalletsWithinTx(billingStores, tx, account.userId));
    const [purchased] = await db
      .select({ id: wallets.id, balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(and(eq(wallets.userId, account.userId), eq(wallets.type, 'purchased')));
    expect(purchased?.balanceNanoUsd).toBe(WELCOME_CREDIT_NANO_USD);
    const legs = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, purchased?.id ?? ''));
    expect(legs).toHaveLength(1);
  });

  it('rolls back the account when provisioning fails — no walletless user', async () => {
    const brokenBilling = {
      ...billingStores,
      insertWalletIfAbsentWithinTx: () => {
        throw new Error('provision boom');
      },
    };
    const brokenManifest = createIdentityManifest({
      ...manifestDeps,
      billingStores: brokenBilling,
    });
    const brokenApp = applyPipeline(new Hono<AppEnv>(), {
      session: { revocation: checkSessionRevocation },
    });
    brokenApp.route(brokenManifest.basePath, brokenManifest.routes);

    const account = uniqueAccount();
    const client = createOpaqueClient();
    const { body } = await registerInit(account, client);
    const { record } = await opaqueClientFinishRegistration(
      client,
      body.registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finish = await brokenApp.request(
      '/auth/register/finish',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: account.email,
          registrationRecord: record,
          registerSessionId: body.registerSessionId,
          ...KEY_BLOBS,
        }),
      },
      testEnv
    );
    // The settlement threw during provisioning, rolling back the account INSERT
    // (single-settlement): the user must not exist, so there is no walletless
    // account that would 403 on its first turn.
    expect(finish.status).toBe(503);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, account.email));
    expect(rows).toHaveLength(0);
  });
});

describe('identity routes: registration verification email (D2)', () => {
  it('issues a verification token and sends the link on registration', async () => {
    sentVerifications.length = 0;
    const account = await registerAccount();
    expect(sentVerifications.some((message) => message.to === account.email.toLowerCase())).toBe(
      true
    );
    // A live token exists (the dev-link reads the newest unexpired one).
    const devLink = await get(
      `/auth/verify-email/dev-link?email=${encodeURIComponent(account.email)}`
    );
    expect(devLink.status).toBe(200);
    const { token } = await devLink.json<{ token: string }>();
    expect(token).toBeTruthy();
  });

  it('still returns 201 when the verification email send fails', async () => {
    emailPortFailure.shouldFail = true;
    try {
      // registerAccount asserts a 201 internally — the best-effort send failure
      // must not fail registration.
      const account = await registerAccount();
      expect(account.userId).toBeTruthy();
    } finally {
      emailPortFailure.shouldFail = false;
    }
  });
});
