import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Redis } from '@upstash/redis';
import { and, eq, like, sql } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  accountDeletionEvents,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  epochs,
  jobs,
  ledgerEntries,
  messages,
  users,
  wallets,
} from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration as opaqueClientFinishRegistration,
  generateTotpCodeSync,
  rewrapAccountKeyForPasswordChange,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import {
  DELETE_ACCOUNT_CONFIRMATION_PHRASE,
  ERROR_CODES,
  fromBase64,
  toBase64,
} from '@hushbox/shared';
import { unsealData } from 'iron-session';
import { applyPipeline } from '../../middleware/pipeline.js';
import { routeClass } from '../../middleware/pipeline-markers.js';
import { createErrorResponse } from '../../lib/errors/index.js';
import { SESSION_COOKIE_NAME, parseSessionClaims } from '../../lib/context/index.js';
import { redisSet } from '../../lib/redis/index.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { IDENTITY_KEYS } from './domain/keys.js';
import { issueBillingLoginToken } from './domain/billing-portal.js';
import {
  checkSessionRevocation,
  createIdentityManifest,
  createIdentityStores,
  issueSession,
} from './index.js';
import { fullClaims } from './routes.js';
import {
  WELCOME_CREDIT_NANO_USD,
  createBillingStores,
  provisionWalletsWithinTx,
} from '../billing/index.js';
import { runSettlement } from '../../lib/idempotency/index.js';
import { createAppJobRegistry, enqueueWithinTx } from '../../lib/jobs/index.js';
import { MEDIA_RECLAIM_USER_JOB_TYPE, createMediaReclaimUserJob } from '../media/index.js';
import { captureContentStorageKeysWithinTx, detachMessageSendersWithinTx } from '../chat/index.js';
import type { Storage } from '../media/index.js';
import type { WelcomeEmailPort } from '../billing/index.js';
import type { ExecutionContext } from 'hono';
import type { AppEnv, Bindings, SessionClaims } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type {
  AccountDeletedEmailPort,
  AccountDeletionPurge,
  AccountLockedEmailPort,
  IdentityRouteDeps,
  IdentityStores,
  PasswordChangedEmailPort,
  PasswordResetEmailPort,
  TwoFactorDisabledEmailPort,
  TwoFactorEnabledEmailPort,
  VerificationEmailPort,
} from './index.js';

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

/** Records verification-email sends so the resend suite can assert on them. */
const sentVerifications: { to: string; token: string; userName?: string }[] = [];
/** When set, the port errs — exercises the best-effort swallow in resend. */
let emailPortShouldFail = false;
const emailPort: VerificationEmailPort = {
  sendVerificationEmail: (args) => {
    sentVerifications.push({
      to: args.to,
      token: args.token,
      ...(args.userName !== undefined && { userName: args.userName }),
    });
    return emailPortShouldFail ? errAsync(unavailableError('email sender down')) : okAsync();
  },
};

/** Records password-changed notification sends so the rotation suites can assert on them. */
const sentPasswordChanged: { to: string; userName?: string }[] = [];
const passwordChangedEmailPort: PasswordChangedEmailPort = {
  sendPasswordChangedEmail: (args) => {
    sentPasswordChanged.push({
      to: args.to,
      ...(args.userName !== undefined && { userName: args.userName }),
    });
    return okAsync();
  },
};

/** Records password-reset notification sends so the recovery-reset suite can assert on them. */
const sentPasswordReset: { to: string; userName?: string }[] = [];
const passwordResetEmailPort: PasswordResetEmailPort = {
  sendPasswordResetEmail: (args) => {
    sentPasswordReset.push({
      to: args.to,
      ...(args.userName !== undefined && { userName: args.userName }),
    });
    return okAsync();
  },
};

/** Records security-notification sends so the provisioning + 2FA + lockout suites can assert. */
const sentWelcome: { to: string; userName?: string }[] = [];
const welcomeEmailPort: WelcomeEmailPort = {
  sendWelcomeEmail: (args) => {
    sentWelcome.push({
      to: args.to,
      ...(args.userName !== undefined && { userName: args.userName }),
    });
    return okAsync();
  },
};
const sentTwoFactorEnabled: { to: string }[] = [];
const twoFactorEnabledEmailPort: TwoFactorEnabledEmailPort = {
  sendTwoFactorEnabledEmail: (args) => {
    sentTwoFactorEnabled.push({ to: args.to });
    return okAsync();
  },
};
const sentTwoFactorDisabled: { to: string }[] = [];
/** When set, the disabled-email port errs — exercises the best-effort swallow. */
let disabledEmailShouldFail = false;
const twoFactorDisabledEmailPort: TwoFactorDisabledEmailPort = {
  sendTwoFactorDisabledEmail: (args) => {
    sentTwoFactorDisabled.push({ to: args.to });
    return disabledEmailShouldFail
      ? errAsync(unavailableError('disabled-email sender down'))
      : okAsync();
  },
};
const sentAccountLocked: { to: string; lockoutMinutes: number }[] = [];
const accountLockedEmailPort: AccountLockedEmailPort = {
  sendAccountLockedEmail: (args) => {
    sentAccountLocked.push({ to: args.to, lockoutMinutes: args.lockoutMinutes });
    return okAsync();
  },
};

/** Billing's real single-writer stores — registration provisions through them. */
const billingStores = createBillingStores();

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

/**
 * Records session-revocation eviction fan-outs so the route wiring (logout,
 * 2FA-login rotation, password change, recovery reset all threading the port
 * into revocation/rotation) is observable end-to-end (ARCHITECTURE §15). The
 * port's own fan-out over live rooms is exercised in app-eviction.integration.
 */
const evictedUserIds: string[] = [];
const recordingEvictUser = (): { evictUser(userId: string): Promise<void> } => ({
  evictUser: (userId: string) => {
    evictedUserIds.push(userId);
    return Promise.resolve();
  },
});

/** Records account-deleted confirmations (sent to the pre-capture email). */
const sentAccountDeleted: { to: string }[] = [];
const accountDeletedEmailPort: AccountDeletedEmailPort = {
  sendAccountDeletedEmail: (args) => {
    sentAccountDeleted.push({ to: args.to });
    return okAsync();
  },
};

/**
 * Enqueue-only reclaim registry: the handler runs in the dispatcher DO, never
 * in these tests — the enqueue path reads only schema/lease/shard metadata.
 */
const reclaimRegistry = createAppJobRegistry([
  createMediaReclaimUserJob({ storage: {} as Storage }),
]);

/** The real cross-slice purge, exactly as app.ts composes it. */
const deletionPurge: AccountDeletionPurge = {
  captureContentStorageKeysWithinTx,
  detachMessageSendersWithinTx,
  enqueueMediaReclaimWithinTx: async (tx, args) => {
    await enqueueWithinTx(tx, reclaimRegistry, {
      type: MEDIA_RECLAIM_USER_JOB_TYPE,
      payload: args,
    });
  },
};

const manifestDeps: IdentityRouteDeps = {
  stores: createIdentityStores,
  emailPort,
  passwordChangedEmailPort,
  passwordResetEmailPort,
  billingStores,
  welcomeEmailPort,
  twoFactorEnabledEmailPort,
  twoFactorDisabledEmailPort,
  accountLockedEmailPort,
  evictUser: recordingEvictUser,
  accountDeletedEmailPort,
  deletionPurge: () => deletionPurge,
};

function createApp(deps: IdentityRouteDeps = manifestDeps): Hono<AppEnv> {
  const manifest = createIdentityManifest(deps);
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

interface PostOptions {
  readonly app?: Hono<AppEnv>;
  readonly headers?: Record<string, string>;
  readonly executionCtx?: ExecutionContext;
}

async function post(
  path: string,
  body: unknown,
  cookie?: string,
  options: PostOptions = {}
): Promise<Response> {
  return (options.app ?? createApp()).request(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
        ...options.headers,
      },
      body: JSON.stringify(body),
    },
    testEnv,
    options.executionCtx
  );
}

async function get(path: string, cookie?: string): Promise<Response> {
  return createApp().request(path, { headers: cookie === undefined ? {} : { cookie } }, testEnv);
}

async function expectStatus(pending: Promise<Response>, status: number): Promise<void> {
  const res = await pending;
  expect(res.status).toBe(status);
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
  account = uniqueAccount(),
  keyBlobs = KEY_BLOBS
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
    ...keyBlobs,
  });
  expect(res.status).toBe(201);
  const finished = await res.json<{ success: boolean; userId: string }>();
  expect(finished.success).toBe(true);
  return { ...account, userId: finished.userId };
}

afterAll(async () => {
  const prefixPattern = `${PREFIX}%`;
  // Conversations first: their cascade removes membership rows, whose
  // userId-SET-NULL would otherwise trip the identity-or-left check.
  await db
    .delete(conversations)
    .where(
      sql`${conversations.userId} IN (SELECT ${users.id} FROM ${users} WHERE ${users.username} LIKE ${prefixPattern})`
    );
  await db.delete(users).where(like(users.username, `${PREFIX}%`));
  // Deletion events are anonymous; the run-unique userAgent markers are the
  // only handle this suite has on its own rows.
  await db.delete(accountDeletionEvents).where(like(accountDeletionEvents.userAgent, `${PREFIX}%`));
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

/**
 * Marks an account's email verified, modelling the click-through of the
 * verification link. Real accounts must verify before login (D1 gate), so the
 * many login-success paths mark verified via `login`; an unknown identifier
 * matches no row. The gate itself is covered explicitly by its own suite.
 */
async function markVerified(identifier: string): Promise<void> {
  const column = identifier.includes('@') ? users.email : users.username;
  await db.update(users).set({ emailVerified: true }).where(eq(column, identifier.toLowerCase()));
}

/** The OPAQUE login round-trip WITHOUT verifying — used to exercise the gate. */
async function loginRoundTrip(identifier: string, password: string): Promise<Response> {
  const client = createOpaqueClient();
  const { res: initRes, body } = await loginInit(identifier, password, client);
  expect(initRes.status).toBe(200);
  const { ke3 } = await opaqueClientFinishLogin(client, body.ke2, OPAQUE_SERVER_IDENTIFIER);
  return post('/auth/login/finish', { identifier, ke3, loginSessionId: body.loginSessionId });
}

async function login(identifier: string, password: string): Promise<Response> {
  await markVerified(identifier);
  return loginRoundTrip(identifier, password);
}

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

describe('identity routes: Redis unavailability fails closed', () => {
  const DEAD_ENV: Bindings & TelemetryEnv = {
    ...testEnv,
    UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:9',
  };

  /**
   * No revocation seam here: these tests target each HANDLER's own
   * fail-closed path (the session stage's fail-closed 503 is covered by the
   * pipeline-session suite).
   */
  function deadApp(): Hono<AppEnv> {
    const manifest = createIdentityManifest(manifestDeps);
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  async function postDead(path: string, body: unknown, cookie?: string): Promise<Response> {
    return deadApp().request(
      path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: JSON.stringify(body),
      },
      DEAD_ENV
    );
  }

  async function expectUnavailable(res: Response): Promise<void> {
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  }

  it('refuses register init', async () => {
    const account = uniqueAccount();
    await expectUnavailable(
      await postDead('/auth/register/init', {
        email: account.email,
        username: account.username,
        registrationRequest: [1],
      })
    );
  });

  it('refuses login init', async () => {
    await expectUnavailable(
      await postDead('/auth/login/init', { identifier: 'x@identity-routes.test', ke1: [1] })
    );
  });

  it('refuses register finish', async () => {
    const account = uniqueAccount();
    await expectUnavailable(
      await postDead('/auth/register/finish', {
        email: account.email,
        registrationRecord: [1],
        registerSessionId: crypto.randomUUID(),
        ...KEY_BLOBS,
      })
    );
  });

  it('refuses login finish', async () => {
    await expectUnavailable(
      await postDead('/auth/login/finish', {
        identifier: 'x@identity-routes.test',
        ke3: [1],
        loginSessionId: crypto.randomUUID(),
      })
    );
  });

  it('refuses logout when the revocation delete cannot be answered', async () => {
    const cookie = await fullSessionCookie();
    await expectUnavailable(await postDead('/auth/logout', {}, cookie));
  });

  it('refuses TOTP setup and verify when redis is down', async () => {
    const cookie = await fullSessionCookie();
    await expectUnavailable(await postDead('/auth/2fa/setup', {}, cookie));
    await expectUnavailable(await postDead('/auth/2fa/verify', { code: '123456' }, cookie));
  }, 40_000);

  it('refuses login-2FA and 2FA disable when redis is down', async () => {
    const pending = await pendingSessionCookie();
    const enrolled = await enrolledFullCookie();
    const { ke1: validKe1 } = await opaqueClientStartLogin(createOpaqueClient(), 'anything');
    await expectUnavailable(await postDead('/auth/login/2fa/verify', { code: '123456' }, pending));
    await expectUnavailable(await postDead('/auth/2fa/disable/init', { ke1: validKe1 }, enrolled));
    await expectUnavailable(
      await postDead(
        '/auth/2fa/disable/finish',
        { ke3: [1], code: '123456', disable2FASessionId: crypto.randomUUID() },
        enrolled
      )
    );
  }, 40_000);

  it('refuses password change and account deletion when redis is down', async () => {
    const cookie = await fullSessionCookie();
    const sid = crypto.randomUUID();
    const { ke1: validKe1 } = await opaqueClientStartLogin(createOpaqueClient(), 'anything');
    await expectUnavailable(
      await postDead(
        '/auth/change-password/init',
        { ke1: validKe1, newRegistrationRequest: [1] },
        cookie
      )
    );
    await expectUnavailable(
      await postDead(
        '/auth/change-password/finish',
        {
          ke3: [1],
          newRegistrationRecord: [1],
          newPasswordWrappedPrivateKey: 'AQID',
          changePasswordSessionId: sid,
        },
        cookie
      )
    );
    await expectUnavailable(await postDead('/auth/account/delete/init', { ke1: validKe1 }, cookie));
    await expectUnavailable(
      await postDead(
        '/auth/account/delete/finish',
        {
          ke3: [1],
          deleteAccountSessionId: sid,
          confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
        },
        cookie
      )
    );
  }, 40_000);

  it('refuses recovery and verification-resend (public) when redis is down', async () => {
    const sid = crypto.randomUUID();
    await expectUnavailable(
      await postDead('/auth/recovery/get-wrapped-key', { identifier: 'x@identity-routes.test' })
    );
    await expectUnavailable(
      await postDead('/auth/recovery/reset/init', {
        identifier: 'x@identity-routes.test',
        newRegistrationRequest: [1],
      })
    );
    await expectUnavailable(
      await postDead('/auth/recovery/reset/finish', {
        identifier: 'x@identity-routes.test',
        newRegistrationRecord: [1],
        newPasswordWrappedPrivateKey: 'AQID',
        recoverySessionId: sid,
      })
    );
    await expectUnavailable(
      await postDead('/auth/verify-email/resend', { email: 'x@identity-routes.test' })
    );
  }, 40_000);
});

const NEW_WRAPPED_KEY = toBase64(new Uint8Array([4, 5, 6]));

async function registerLoginFull(): Promise<{
  account: { email: string; username: string; password: string; userId: string };
  cookie: string;
}> {
  const account = await registerAccount();
  const res = await login(account.email, account.password);
  expect(res.status).toBe(200);
  return { account, cookie: sessionCookieOf(res) };
}

/** A full-session cookie whose account has completed TOTP enrollment. */
async function enrolledFullCookie(): Promise<string> {
  const { cookie } = await registerLoginFull();
  await enrollTotp(cookie);
  return cookie;
}

async function enrollTotp(cookie: string): Promise<string> {
  const setup = await post('/auth/2fa/setup', {}, cookie);
  expect(setup.status).toBe(200);
  const { secret } = await setup.json<{ totpUri: string; secret: string }>();
  const verify = await post('/auth/2fa/verify', { code: generateTotpCodeSync(secret) }, cookie);
  expect(verify.status).toBe(200);
  return secret;
}

/** A wrong TOTP code that is guaranteed to differ from the live one. */
function wrongCode(secret: string): string {
  return generateTotpCodeSync(secret) === '000000' ? '111111' : '000000';
}

/** Finishes the client side of an OPAQUE step-up handshake into a KE3. */
async function stepUpKe3(
  ke2: number[],
  client: ReturnType<typeof createOpaqueClient>
): Promise<number[]> {
  const { ke3 } = await opaqueClientFinishLogin(client, ke2, OPAQUE_SERVER_IDENTIFIER);
  return ke3;
}

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
    disabledEmailShouldFail = true;
    try {
      const finish = await post(
        '/auth/2fa/disable/finish',
        { ke3, code: generateTotpCodeSync(secret), disable2FASessionId: init.sessionId },
        cookie
      );
      expect(finish.status).toBe(200);
      expect(await finish.json()).toEqual({ success: true });
    } finally {
      disabledEmailShouldFail = false;
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

describe('identity routes: password change', () => {
  async function changePassword(
    cookie: string,
    oldPassword: string,
    newPassword: string
  ): Promise<Response> {
    const stepClient = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(stepClient, oldPassword);
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, newPassword);
    const init = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    expect(init.status).toBe(200);
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
    return post(
      '/auth/change-password/finish',
      {
        ke3,
        newRegistrationRecord: record,
        newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
        changePasswordSessionId: initBody.changePasswordSessionId,
      },
      cookie
    );
  }

  it('rotates the password, stales prior sessions, and logs in with the new password', async () => {
    const { account, cookie } = await registerLoginFull();
    await expectStatus(get('/t/session', cookie), 200);
    const newPassword = `${account.password} rotated`;
    const finish = await changePassword(cookie, account.password, newPassword);
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ success: true });

    // The rotation forwards the eviction port through to close staled sockets.
    expect(evictedUserIds).toContain(account.userId);

    // The security notification reaches the account's address.
    expect(sentPasswordChanged.filter((sent) => sent.to === account.email)).toHaveLength(1);

    // AC3: the cookie issued before the watermark is now rejected.
    const stale = await get('/t/session', cookie);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });

    // The new password authenticates (the old one can no longer recover its
    // OPAQUE envelope client-side, so it cannot even produce a finish request).
    const relogin = await login(account.email, newPassword);
    expect(relogin.status).toBe(200);
  });

  it('rejects a wrong old password with the typed auth failure', async () => {
    const { account, cookie } = await registerLoginFull();
    const stepClient = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(stepClient, account.password);
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'new password here');
    const init = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    const initBody = await init.json<{
      newRegistrationResponse: number[];
      changePasswordSessionId: string;
    }>();
    const { record } = await opaqueClientFinishRegistration(
      newClient,
      initBody.newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );
    const finish = await post(
      '/auth/change-password/finish',
      {
        ke3: [0, 1, 2],
        newRegistrationRecord: record,
        newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
        changePasswordSessionId: initBody.changePasswordSessionId,
      },
      cookie
    );
    expect(finish.status).toBe(401);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.AUTH_FAILED });
    // A refused change never notifies.
    expect(sentPasswordChanged.filter((sent) => sent.to === account.email)).toHaveLength(0);
  });

  it('a revoked session cannot start a step-up op', async () => {
    const { cookie } = await registerLoginFull();
    await expectStatus(post('/auth/logout', {}, cookie), 200);
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, 'whatever');
    const { serialized } = await opaqueClientStartRegistration(createOpaqueClient(), 'whatever');
    const res = await post(
      '/auth/change-password/init',
      { ke1, newRegistrationRequest: serialized },
      cookie
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });
});

describe('identity routes: recovery', () => {
  it('returns the stored wrapped key for a known account', async () => {
    const account = await registerAccount();
    const res = await post('/auth/recovery/get-wrapped-key', { identifier: account.email });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      recoveryWrappedPrivateKey: KEY_BLOBS.recoveryWrappedPrivateKey,
    });
  });

  it('returns a same-shape dummy for an unknown account (enumeration safety)', async () => {
    const known = await registerAccount();
    const knownRes = await post('/auth/recovery/get-wrapped-key', { identifier: known.email });
    const unknownRes = await post('/auth/recovery/get-wrapped-key', {
      identifier: `${PREFIX}nobody@identity-routes.test`,
    });
    expect(unknownRes.status).toBe(knownRes.status);
    const unknownBody = await unknownRes.json<{ recoveryWrappedPrivateKey: string }>();
    const knownBody = await knownRes.json<{ recoveryWrappedPrivateKey: string }>();
    // Same JSON shape: exactly the one key, a base64 string, on both.
    expect(Object.keys(unknownBody)).toEqual(Object.keys(knownBody));
    expect(typeof unknownBody.recoveryWrappedPrivateKey).toBe('string');
  });

  it('answers a known and an unknown account with byte-identical response length', async () => {
    // A canonical client stores an ECIES wrap of the 32-byte account private
    // key; the dummy must be the same length or the body is an existence oracle.
    const realBlob = rewrapAccountKeyForPasswordChange(new Uint8Array(32), new Uint8Array(32));
    const known = await registerAccount(uniqueAccount(), {
      ...KEY_BLOBS,
      recoveryWrappedPrivateKey: toBase64(realBlob),
    });
    const knownRes = await post('/auth/recovery/get-wrapped-key', { identifier: known.email });
    const unknownRes = await post('/auth/recovery/get-wrapped-key', {
      identifier: `${PREFIX}void@identity-routes.test`,
    });
    expect(knownRes.status).toBe(200);
    expect(unknownRes.status).toBe(200);
    const knownBody = await knownRes.text();
    const unknownBody = await unknownRes.text();
    expect(unknownBody.length).toBe(knownBody.length);
  });

  async function unknownDummyBytes(identifier: string): Promise<Uint8Array> {
    const res = await post('/auth/recovery/get-wrapped-key', { identifier });
    expect(res.status).toBe(200);
    const body = await res.json<{ recoveryWrappedPrivateKey: string }>();
    return fromBase64(body.recoveryWrappedPrivateKey);
  }

  it('answers repeated queries for the same unknown identifier with the identical dummy', async () => {
    const ghost = `${PREFIX}stable-dummy@identity-routes.test`;
    const first = await unknownDummyBytes(ghost);
    const second = await unknownDummyBytes(ghost);
    expect([...second]).toEqual([...first]);
  });

  it('answers different unknown identifiers with different dummies', async () => {
    const first = await unknownDummyBytes(`${PREFIX}dummy-a@identity-routes.test`);
    const second = await unknownDummyBytes(`${PREFIX}dummy-b@identity-routes.test`);
    expect([...second]).not.toEqual([...first]);
  });

  it('never answers an unknown identifier with an all-zero dummy body', async () => {
    const bytes = await unknownDummyBytes(`${PREFIX}nonzero@identity-routes.test`);
    expect(bytes.slice(1).some((byte) => byte !== 0)).toBe(true);
  });

  it('stamps the real ECIES version byte on the dummy', async () => {
    const realBlob = rewrapAccountKeyForPasswordChange(new Uint8Array(32), new Uint8Array(32));
    const bytes = await unknownDummyBytes(`${PREFIX}versioned@identity-routes.test`);
    expect(bytes[0]).toBe(realBlob[0]);
  });

  it('resets the password via the recovery handshake and stales prior sessions', async () => {
    const { account, cookie } = await registerLoginFull();
    const newPassword = `${account.password} recovered`;
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, newPassword);
    const init = await post('/auth/recovery/reset/init', {
      identifier: account.email,
      newRegistrationRequest: serialized,
    });
    expect(init.status).toBe(200);
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
      newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
      recoverySessionId: initBody.recoverySessionId,
    });
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ success: true });

    // The reset forwards the eviction port through to close staled sockets.
    expect(evictedUserIds).toContain(account.userId);

    // The reset sends the distinct password-reset notice, never the alarming
    // password-changed one, to the account's address.
    expect(sentPasswordReset.filter((sent) => sent.to === account.email)).toHaveLength(1);
    expect(sentPasswordChanged.filter((sent) => sent.to === account.email)).toHaveLength(0);

    await expectStatus(get('/t/session', cookie), 401);
    const relogin = await login(account.email, newPassword);
    expect(relogin.status).toBe(200);
  });

  it('answers reset init for an unknown identifier with the same started shape', async () => {
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'brand new password');
    const res = await post('/auth/recovery/reset/init', {
      identifier: `${PREFIX}ghost@identity-routes.test`,
      newRegistrationRequest: serialized,
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'newRegistrationResponse',
      'recoverySessionId',
    ]);
  });

  it('rejects a reset finish whose identifier does not match the handshake', async () => {
    const account = await registerAccount();
    const newClient = createOpaqueClient();
    const { serialized } = await opaqueClientStartRegistration(newClient, 'another password');
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
      identifier: `other-${account.email}`,
      newRegistrationRecord: record,
      newPasswordWrappedPrivateKey: NEW_WRAPPED_KEY,
      recoverySessionId: initBody.recoverySessionId,
    });
    expect(finish.status).toBe(400);
    expect(await finish.json()).toEqual({ code: ERROR_CODES.NO_PENDING_RECOVERY });
  });
});

/**
 * Statistical enumeration-timing guards for the public flows that answer
 * known and unknown identifiers with the same shape. Medians over interleaved
 * samples (after a warm-up) are compared within a generous factor — the
 * deterministic guards (equal body length, same shape) live in the suites
 * above; these catch a gross asymmetry (an early return skipping the
 * dominant work), not microarchitectural leaks.
 */
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

  /** Seeds an owned conversation carrying one media content item. */
  async function seedOwnedMedia(userId: string): Promise<{ storageKey: string }> {
    const [conversation] = await db
      .insert(conversations)
      .values({ userId, title: new Uint8Array([1]) })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('conversation seed failed');
    await db.insert(epochs).values({
      conversationId: conversation.id,
      epochNumber: 1,
      epochPublicKey: new Uint8Array([1]),
      confirmationHash: new Uint8Array([1]),
    });
    await db
      .insert(conversationMembers)
      .values({ conversationId: conversation.id, userId, visibleFromEpoch: 1 });
    const [message] = await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        senderType: 'user',
        senderId: userId,
        wrappedContentKey: new Uint8Array([1]),
        epochNumber: 1,
        sequenceNumber: 1,
      })
      .returning({ id: messages.id });
    if (!message) throw new Error('message seed failed');
    const storageKey = `media/${conversation.id}/${message.id}/${crypto.randomUUID()}`;
    await db.insert(contentItems).values({
      messageId: message.id,
      contentType: 'image',
      storageKey,
      mimeType: 'image/png',
      sizeBytes: 3,
    });
    return { storageKey };
  }

  async function reclaimJobsFor(userId: string): Promise<{ shard: string; payload: unknown }[]> {
    return db
      .select({ shard: jobs.shard, payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${userId}`
        )
      );
  }

  it('hard-deletes the account after a verified step-up: rows gone, media reclaimed, session dead', async () => {
    const { account, cookie } = await registerLoginFull();
    const { storageKey } = await seedOwnedMedia(account.userId);
    const userAgent = `${PREFIX}-delete-agent-${crypto.randomUUID()}`;
    const init = await deleteInit(cookie, account.password);
    const ke3 = await stepUpKe3(init.ke2, init.client);

    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3,
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie,
      { headers: { 'user-agent': userAgent, 'cf-connecting-ip': '198.51.100.4' } }
    );
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ success: true });

    // The users row is gone; the deletion executed synchronously.
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);
    // The anonymous forensic event recorded the request fingerprint only.
    const events = await db
      .select({ ipAddress: accountDeletionEvents.ipAddress })
      .from(accountDeletionEvents)
      .where(eq(accountDeletionEvents.userAgent, userAgent));
    expect(events).toEqual([{ ipAddress: '198.51.100.4' }]);
    // The bulk-shard reclaim job carries exactly the owned storage keys.
    const jobRows = await reclaimJobsFor(account.userId);
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]?.shard).toBe('bulk');
    expect((jobRows[0]?.payload as { storageKeys: string[] }).storageKeys).toEqual([storageKey]);
    // Post-commit tail: eviction fan-out + confirmation to the captured email.
    expect(evictedUserIds).toContain(account.userId);
    expect(sentAccountDeleted).toContainEqual({ to: account.email });
    // Prompt cleanup: a committed pending bulk row must not linger where a
    // concurrent jobs-suite bulk pass could claim it.
    await db
      .delete(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${account.userId}`
        )
      );
    // The old cookie is dead (pw-changed watermark stales it) — repeat-finish
    // cannot even reach the flow again.
    const repeat = await post('/auth/account/delete/init', { ke1: [1, 2, 3] }, cookie);
    expect(repeat.status).toBe(401);
  });

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
    expect(locked.status).toBe(429);
    const lockedBody = await locked.json<{ code: string }>();
    expect(lockedBody.code).toBe(ERROR_CODES.TOO_MANY_ATTEMPTS);
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
    expect(locked.status).toBe(429);
    const body = await locked.json<{ code: string; details: { retryAfterSeconds: number } }>();
    expect(body.code).toBe(ERROR_CODES.TOO_MANY_ATTEMPTS);
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

  it('does not freeze deletion for a day after a short fumble under the guessing cap', async () => {
    const { account, cookie } = await registerLoginFull();
    const { maxAttempts } = IDENTITY_KEYS.deleteAccountLockout.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts - 1; attempt += 1) {
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
    }
    // No hard lock has engaged, so a correct step-up still deletes the account.
    expect(
      await redis.get(IDENTITY_KEYS.deleteAccountHardLock.buildKey(account.userId))
    ).toBeNull();
    const init = await deleteInit(cookie, account.password);
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(init.ke2, init.client),
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie
    );
    expect(finish.status).toBe(200);
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);
  });

  it('enqueues no reclaim job for an account that stored no media', async () => {
    const { account, cookie } = await registerLoginFull();
    const init = await deleteInit(cookie, account.password);
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(init.ke2, init.client),
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie
    );
    expect(finish.status).toBe(200);
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);
    expect(await reclaimJobsFor(account.userId)).toHaveLength(0);
  });

  it('rolls the whole deletion back when a step inside the transaction fails', async () => {
    const { account, cookie } = await registerLoginFull();
    const userAgent = `${PREFIX}-rollback-agent-${crypto.randomUUID()}`;
    const failingApp = createApp({
      ...manifestDeps,
      deletionPurge: () => ({
        ...deletionPurge,
        detachMessageSendersWithinTx: () => {
          throw new Error('injected failure before the users delete');
        },
      }),
    });
    const init = await deleteInit(cookie, account.password);
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(init.ke2, init.client),
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie,
      { app: failingApp, headers: { 'user-agent': userAgent } }
    );
    expect(finish.status).toBe(503);

    // Atomicity: the account survives untouched — no event, no job, live session.
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(1);
    expect(
      await db
        .select({ id: accountDeletionEvents.id })
        .from(accountDeletionEvents)
        .where(eq(accountDeletionEvents.userAgent, userAgent))
    ).toHaveLength(0);
    expect(await reclaimJobsFor(account.userId)).toHaveLength(0);
    const stillAlive = await get('/t/session', cookie);
    expect(stillAlive.status).toBe(200);
  });

  it('nudges the bulk dispatcher via waitUntil after the deletion commits', async () => {
    const { account, cookie } = await registerLoginFull();
    const wakes: string[] = [];
    const waited: Promise<unknown>[] = [];
    const wakingApp = createApp({
      ...manifestDeps,
      wakeReclaimDispatcher: () => {
        wakes.push(account.userId);
      },
    });
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => {
        waited.push(promise);
      },
      passThroughOnException: () => {},
    } as ExecutionContext;
    const init = await deleteInit(cookie, account.password);
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: await stepUpKe3(init.ke2, init.client),
        deleteAccountSessionId: init.sessionId,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      cookie,
      { app: wakingApp, executionCtx }
    );
    expect(finish.status).toBe(200);
    await Promise.all(waited);
    expect(wakes).toEqual([account.userId]);
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

  it('treats a vanished user after a verified step-up as a defect (500)', async () => {
    const { account, cookie } = await registerLoginFull();
    const init = await deleteInit(cookie, account.password);
    const ke3 = await stepUpKe3(init.ke2, init.client);
    await db.delete(users).where(eq(users.id, account.userId));
    const res = await deleteFinish(cookie, init, { ke3 });
    expect(res.status).toBe(500);
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

  it('hard-deletes the account after a verified step-up and valid TOTP code', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const init = await deleteInit(cookie, account.password);
    const res = await deleteFinish(cookie, init, { totpCode: generateTotpCodeSync(secret) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(await db.select().from(users).where(eq(users.id, account.userId))).toHaveLength(0);
  });

  it('treats a 2FA-enabled account with no configured secret as a defect (500) at deletion', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    await db.update(users).set({ totpSecretEncrypted: null }).where(eq(users.id, account.userId));
    const init = await deleteInit(cookie, account.password);
    const res = await deleteFinish(cookie, init, { totpCode: generateTotpCodeSync(secret) });
    expect(res.status).toBe(500);
  });

  it('returns too-many-attempts when the TOTP lockout is already tripped at deletion', async () => {
    const { account, cookie } = await registerLoginFull();
    const secret = await enrollTotp(cookie);
    const { maxAttempts } = IDENTITY_KEYS.twoFactorLockout.rateLimitConfig;
    await redis.set(IDENTITY_KEYS.twoFactorLockout.buildKey(account.userId), maxAttempts);
    const init = await deleteInit(cookie, account.password);
    const res = await deleteFinish(cookie, init, { totpCode: generateTotpCodeSync(secret) });
    expect(res.status).toBe(429);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe(ERROR_CODES.TOO_MANY_ATTEMPTS);
  });
});

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
    emailPortShouldFail = true;
    try {
      const res = await post('/auth/verify-email/resend', { email: account.email });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    } finally {
      emailPortShouldFail = false;
    }
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

describe('identity routes: recovery/save', () => {
  it('persists the recovery-wrapped key and flags phrase acknowledgement', async () => {
    const { account, cookie } = await registerLoginFull();
    const blob = new Uint8Array([9, 8, 7]);
    const res = await post(
      '/auth/recovery/save',
      { recoveryWrappedPrivateKey: toBase64(blob) },
      cookie
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const [row] = await db
      .select({
        recoveryWrappedPrivateKey: users.recoveryWrappedPrivateKey,
        hasAcknowledgedPhrase: users.hasAcknowledgedPhrase,
      })
      .from(users)
      .where(eq(users.id, account.userId));
    expect([...(row?.recoveryWrappedPrivateKey ?? [])]).toEqual([...blob]);
    expect(row?.hasAcknowledgedPhrase).toBe(true);
  });

  it('rejects a malformed base64 body with a validation error', async () => {
    const { cookie } = await registerLoginFull();
    const res = await post('/auth/recovery/save', { recoveryWrappedPrivateKey: '!' }, cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('denies recovery/save without a session (session-class default-deny)', async () => {
    const res = await post('/auth/recovery/save', {
      recoveryWrappedPrivateKey: toBase64(new Uint8Array([1])),
    });
    expect(res.status).toBe(401);
  });
});

describe('identity routes: principal guards', () => {
  it('rejects a session-class route reached without a full principal', () => {
    const ctx = { var: { principal: { kind: 'none' as const } } } as never;
    expect(() => fullClaims(ctx)).toThrow(/full principal/);
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
    emailPortShouldFail = true;
    try {
      // registerAccount asserts a 201 internally — the best-effort send failure
      // must not fail registration.
      const account = await registerAccount();
      expect(account.userId).toBeTruthy();
    } finally {
      emailPortShouldFail = false;
    }
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
    await db.update(users).set({ email: '' }).where(eq(users.id, account.userId));
    const res = await loginRoundTrip(account.username, account.password);
    expect(res.status).toBe(200);
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
