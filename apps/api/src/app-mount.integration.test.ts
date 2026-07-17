import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { hc } from 'hono/client';
import { Redis } from '@upstash/redis';
import { sealData } from 'iron-session';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  epochs,
  jobs,
  modelCatalog,
  payments,
  users,
  wallets,
} from '@hushbox/db';
import { ERROR_CODES, Mode, envConfig } from '@hushbox/shared';
import { trialRoomName } from '@hushbox/realtime/protocol';
import { createApp, type AppType } from './app.js';
import { applyPipeline } from './middleware/pipeline.js';
import { CF_ACCESS_JWT_HEADER, mintDevAdminToken } from './middleware/pipeline-admin.js';
import { SESSION_COOKIE_NAME } from './middleware/pipeline-session.js';
import { createAppJobRegistry } from './lib/jobs/index.js';
import { okAsync } from './lib/result/index.js';
import {
  createBillingManifest,
  createBillingStores,
  createPaymentVerifyJobRegistration,
} from './slices/billing/index.js';
import { createChatManifest } from './slices/chat/index.js';
import { createLinkResolutionAdapter } from './adapters/link-resolution.js';
import { createConversationsStores } from './slices/conversations/index.js';
import { withModelCatalogLock } from './slices/models/__tests__/model-catalog-lock.js';
import type { AppEnv, Bindings } from './lib/context/index.js';
import type { TelemetryEnv } from './lib/telemetry/index.js';
import type { RealtimeBroadcast } from './slices/conversations/index.js';
import type { ChargeOutcome, PaymentProvider } from './slices/billing/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`app-mount tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

// `res.json()` is typed `unknown` by the typechecker but already-typed by the
// lint program, so an inline assertion is simultaneously required (typecheck)
// and flagged as redundant (lint). Reading through a generic seam satisfies
// both: the cast to a free type parameter is not a lint no-op.
async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const SECRET = 'secret-at-least-32-characters-long!!';
const DATABASE_URL = requiredEnv('DATABASE_URL');
const UPSTASH_REDIS_REST_URL = requiredEnv('UPSTASH_REDIS_REST_URL');
const UPSTASH_REDIS_REST_TOKEN = requiredEnv('UPSTASH_REDIS_REST_TOKEN');

// A full stack env: session-revocation is unwired on the manifest apps below
// (they mount `applyPipeline` without the revocation option), so a sealed
// cookie authenticates without a Redis round trip — matching the slice tests.
const devEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

/** devEnv plus the Access config the admin JWT stage fail-fasts on. */
const adminEnv: Bindings & TelemetryEnv = {
  ...devEnv,
  CF_ACCESS_TEAM_DOMAIN: 'hushbox-dev',
  CF_ACCESS_AUD: 'dev-admin-access-aud',
  ADMIN_ACTOR_ALLOWLIST: 'admin@hushbox.test',
  CF_ACCESS_DEV_PRIVATE_JWK: envConfig.CF_ACCESS_DEV_PRIVATE_JWK[Mode.Development],
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([7, 7, 7]);
// Unique per test run so a concurrent suite's catalog rows never collide.
const MODEL = `app-mount/${crypto.randomUUID().slice(0, 8)}`;

const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];
const createdPaymentIds: string[] = [];

afterAll(async () => {
  for (const paymentId of createdPaymentIds) {
    await db.delete(jobs).where(eq(jobs.dedupeKey, `payment.verify:${paymentId}`));
    await db.delete(payments).where(eq(payments.id, paymentId));
  }
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.delete(modelCatalog).where(eq(modelCatalog.modelId, MODEL));
  await db.$client.end();
});

async function seedUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values({
      email: `${suffix}@app-mount.test`,
      username: `am${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

async function seedConversationWithMember(userId: string): Promise<string> {
  const rows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = rows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(conversationId);
  await db
    .insert(epochs)
    .values({ conversationId, epochNumber: 1, epochPublicKey: BYTES, confirmationHash: BYTES });
  await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });
  return conversationId;
}

async function seedPurchasedWallet(userId: string): Promise<void> {
  await db.insert(wallets).values({ userId, type: 'purchased', balanceNanoUsd: 10_000_000n });
}

async function seedModel(): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId: MODEL,
      descriptor: {
        id: MODEL,
        provider: 'p',
        version: '1',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: [],
        limits: { contextLength: 1000 },
        pricing: { inputPerToken: '2', outputPerToken: '3' },
        zdrReachable: true,
        releasedAt: 1_600_000_000,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

async function cookie(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      userId,
      sessionId: 's1',
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

/** A Hono ExecutionContext double: records the tasks `waitUntil` receives. */
function recordingExecutionCtx(): { ctx: ExecutionContext; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (task: Promise<unknown>): void => {
      tasks.push(task);
    },
    passThroughOnException: (): void => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, tasks };
}

describe('createApp: chat and billing are mounted behind the default-deny pipeline', () => {
  it('reaches the chat turn route — the session class denies the anonymous caller (not 404)', async () => {
    const res = await createApp().request(
      '/chat',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      devEnv
    );
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });

  it('reaches the billing balance route — session class denies the anonymous caller (not 404)', async () => {
    const res = await createApp().request('/billing/balance', {}, devEnv);
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });

  it('reaches the billing payments route — billing-token class denies the anonymous caller (not 404)', async () => {
    const res = await createApp().request(
      '/billing/payments',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      devEnv
    );
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });

  it('reaches the media download-url route — the handler resolves the caller and denies anonymous (not 404)', async () => {
    const res = await createApp().request(`/media/${crypto.randomUUID()}/download-url`, {}, devEnv);
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });

  it('reaches the admin ops catalog — the admin class denies the anonymous caller (not 404)', async () => {
    const res = await createApp().request('/admin/ops', {}, adminEnv);
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });

  it('serves the admin ops catalog to a verified dev-minted admin assertion', async () => {
    const token = await mintDevAdminToken(adminEnv, { email: 'admin@hushbox.test' });
    const res = await createApp().request(
      '/admin/ops',
      { headers: { [CF_ACCESS_JWT_HEADER]: token } },
      adminEnv
    );
    expect(res.status).toBe(200);
    // The composition root registers the full op set; the exact
    // names and op flows are pinned by the admin-ops mount suite — this
    // proves the verified assertion reaches a populated catalog.
    const body = await jsonBody<{ ops: unknown[] }>(res);
    expect(body.ops).toHaveLength(12);
  });

  it('still answers 404 for a genuinely unknown path under a mounted base', async () => {
    const res = await createApp().request('/billing/no-such-route', {}, devEnv);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});

describe('AppType retains chat, billing, and media route inference', () => {
  it('exposes all three slices on the typed hc client', () => {
    const client = hc<AppType>('http://localhost');
    // Compile-time proof: a slice erased from AppType would make these `never`
    // and fail typecheck; the runtime assertions keep the references live.
    const balanceGet = client.billing.balance.$get;
    const paymentsPost = client.billing.payments.$post;
    const regeneratePost = client.chat.regenerate.$post;
    // Media too: annotating createMediaManifest's return type would erase the
    // slice from the typed client — this keeps that regression a compile error.
    const mediaDownloadGet = client.media[':contentItemId']['download-url'].$get;
    // Admin too: the generic ops routes must stay on the typed client for
    // the CLI and SPA.
    const adminOpsGet = client.admin.ops.$get;
    const adminExecutePost = client.admin.ops[':name'].execute.$post;
    expect(typeof adminOpsGet).toBe('function');
    expect(typeof adminExecutePost).toBe('function');
    expect(typeof balanceGet).toBe('function');
    expect(typeof paymentsPost).toBe('function');
    expect(typeof regeneratePost).toBe('function');
    expect(typeof mediaDownloadGet).toBe('function');
  });
});

describe('billing /payments fires the dispatcher wake post-commit', () => {
  const stores = createBillingStores();
  const approvingProvider: PaymentProvider = {
    isMock: true,
    charge: () =>
      okAsync<ChargeOutcome>({ status: 'approved', transactionId: crypto.randomUUID() }),
    getChargeStatus: () => {
      throw new Error('getChargeStatus unexpectedly invoked');
    },
    findCaptureByReference: () => {
      throw new Error('findCaptureByReference unexpectedly invoked');
    },
  };
  const wakes: string[] = [];

  function buildApp(): Hono<AppEnv> {
    const manifest = createBillingManifest({
      stores,
      paymentProvider: () => approvingProvider,
      // Unused on the success/validation paths under test.
      webhookVerifier: () => {
        throw new Error('webhookVerifier unexpectedly invoked');
      },
      jobRegistry: (_env, requestDb) =>
        createAppJobRegistry([
          createPaymentVerifyJobRegistration({
            db: requestDb,
            stores,
            provider: approvingProvider,
          }),
        ]),
      accountDefense: {
        lockForChargebackWithinTx: () => {
          throw new Error('lockForChargebackWithinTx unexpectedly invoked');
        },
      },
      accountLockedEmail: { sendChargebackLockEmail: () => okAsync() },
      wakeDispatcher: () => {
        wakes.push('woke');
      },
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  it('fires the wake via waitUntil after a successful pre-claim commit', async () => {
    wakes.length = 0;
    const userId = await seedUser();
    const { ctx } = recordingExecutionCtx();
    const res = await buildApp().request(
      '/billing/payments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          cookie: await cookie(userId),
        },
        body: JSON.stringify({
          amountNanoUsd: '5000000000',
          cardToken: 'tok',
          customerCode: 'cust',
        }),
      },
      devEnv,
      ctx
    );
    expect(res.status).toBe(200);
    const outcome = await jsonBody<{ paymentId: string }>(res);
    createdPaymentIds.push(outcome.paymentId);
    expect(wakes).toEqual(['woke']);
  });

  it('does not fire the wake when the mutation is refused (no successful commit)', async () => {
    wakes.length = 0;
    const userId = await seedUser();
    const { ctx } = recordingExecutionCtx();
    const res = await buildApp().request(
      '/billing/payments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          cookie: await cookie(userId),
        },
        // Below the minimum: validated (and refused) before any transaction opens.
        body: JSON.stringify({ amountNanoUsd: '5', cardToken: 'tok', customerCode: 'cust' }),
      },
      devEnv,
      ctx
    );
    expect(res.status).toBe(400);
    expect(wakes).toEqual([]);
  });
});

describe('J3: an admission-refused paid turn returns synchronous HTTP over /chat', () => {
  let userId: string;
  let conversationId: string;

  beforeAll(async () => {
    // The catalog seed is per-send (under the lock, below), not here: a concurrent
    // global-read suite deletes foreign catalog rows under the same lock, so a
    // seed held only across beforeAll would be wiped before this suite's reads.
    userId = await seedUser();
    conversationId = await seedConversationWithMember(userId);
    await seedPurchasedWallet(userId);
  });

  function refusingRealtime(
    code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
  ): RealtimeBroadcast {
    return {
      broadcast: () => okAsync({ delivered: 0, paused: 0, evicted: 0 }),
      evict: () => okAsync(0),
      presence: () => okAsync([]),
      startRun: () => okAsync({ started: false, code }),
      stopRun: () => okAsync(false),
      upgrade: () => okAsync(new Response(null, { status: 200 })),
    };
  }

  function buildApp(code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES]): Hono<AppEnv> {
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: createBillingStores(),
      realtime: () => refusingRealtime(code),
      trialRoomName,
      linkResolution: (db) => createLinkResolutionAdapter(db),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  // A concurrent global-read suite (chat routes) clears every foreign catalog row
  // under `withModelCatalogLock` — its Smart Model derivation must see only its own
  // set — which wipes this suite's MODEL between a bare seed and a bare read,
  // starving the definition build into a VALIDATION 400 instead of the admission
  // refusal under test. So each send (re)seeds and reads the catalog while holding
  // the same lock: MODEL is guaranteed present at definition-build read time, and
  // no concurrent suite can delete it mid-request. The refusal `code` is returned
  // so a future catalog-starvation shows up as a distinguishable code, not a bare
  // status mismatch.
  async function sendTurn(
    code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
  ): Promise<{ status: number; code: string | undefined }> {
    return withModelCatalogLock(redis, async () => {
      await seedModel();
      const res = await buildApp(code).request(
        '/chat',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
            cookie: await cookie(userId),
          },
          body: JSON.stringify({
            conversationId,
            model: MODEL,
            userMessage: { id: crypto.randomUUID(), content: 'hello' },
          }),
        },
        devEnv
      );
      const body = await jsonBody<{ code?: string }>(res);
      return { status: res.status, code: body.code };
    });
  }

  it('maps INSUFFICIENT_ADMISSION to 402', async () => {
    const { status, code } = await sendTurn(ERROR_CODES.INSUFFICIENT_ADMISSION);
    expect(status, `refusal code: ${code ?? 'none'}`).toBe(402);
  });

  it('maps ADMISSION_UNAVAILABLE to 503', async () => {
    const { status, code } = await sendTurn(ERROR_CODES.ADMISSION_UNAVAILABLE);
    expect(status, `refusal code: ${code ?? 'none'}`).toBe(503);
  });

  it('maps TRIAL_CAPACITY_REACHED to 429', async () => {
    const { status, code } = await sendTurn(ERROR_CODES.TRIAL_CAPACITY_REACHED);
    expect(status, `refusal code: ${code ?? 'none'}`).toBe(429);
  });
});
