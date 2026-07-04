import { afterAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { eq, inArray, like } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  allowanceSpending,
  createDb,
  jobs,
  ledgerEntries,
  modelCatalog,
  payments,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { signHmacSha256Webhook } from '@hushbox/crypto';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { createJobRegistry } from '../../lib/jobs/index.js';
import { runSettlement } from '../../lib/idempotency/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import {
  PAYMENT_MINIMUM_NANO_USD,
  createPaymentVerifyJobRegistration,
  createWebhookVerifier,
} from './domain/index.js';
import { createMockPaymentProvider } from './adapters/payment-mock.js';
import { requiredIdempotencyKey } from './routes.js';
import { createBillingManifest, createBillingStores } from './index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { MockPaymentProvider } from './adapters/payment-mock.js';
import type { BillingRouteDeps } from './routes.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for billing route integration tests');
}

const SECRET = 'secret-at-least-32-characters-long!!';
const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

interface BalanceBody {
  purchased: { balanceNanoUsd: string };
  free: { balanceNanoUsd: string };
  allowance: {
    day: string;
    limitNanoUsd: string;
    spentNanoUsd: string;
    remainingNanoUsd: string;
  };
}

async function balanceBody(res: Response): Promise<BalanceBody> {
  const body: unknown = await res.json();
  return body as BalanceBody;
}

interface PaymentBody {
  paymentId: string;
  status: string;
  amountNanoUsd: string;
}

async function paymentBody(res: Response): Promise<PaymentBody> {
  const body: unknown = await res.json();
  return body as PaymentBody;
}
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
let userCounter = 0;

async function createUser(): Promise<string> {
  userCounter += 1;
  const username = `blrt${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(userCounter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@billing-routes.test`,
      username,
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

async function sessionCookie(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      userId,
      sessionId: 'session-1',
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

const WEBHOOK_VERIFIER = 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=';
const stores = createBillingStores();

interface PaymentTestApp {
  readonly app: Hono<AppEnv>;
  readonly provider: MockPaymentProvider;
  readonly defenseLocks: string[];
  readonly lockedEmails: string[];
}

function buildDeps(overrides: Partial<BillingRouteDeps> = {}): PaymentTestApp & {
  deps: BillingRouteDeps;
} {
  const defenseLocks: string[] = [];
  const lockedEmails: string[] = [];
  // Filled right below; the provider's webhook delivery closes over it so
  // the mock's signed webhooks land on this very app (the full local flow).
  const appHolder: { app?: Hono<AppEnv> } = {};
  const provider = createMockPaymentProvider({
    webhookUrl: 'http://localhost/billing/webhooks/payment',
    webhookVerifier: WEBHOOK_VERIFIER,
    webhookDelayMs: 0,
    fetchImpl: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (appHolder.app === undefined) {
        return Promise.reject(new Error('webhook delivered before the app was built'));
      }
      return Promise.resolve(appHolder.app.request(url.pathname, init, testEnv));
    },
  });
  const registry = createJobRegistry();
  registry.register(createPaymentVerifyJobRegistration({ db, stores, provider }));
  const deps: BillingRouteDeps = {
    stores,
    paymentProvider: () => provider,
    webhookVerifier: () => createWebhookVerifier({ verifier: WEBHOOK_VERIFIER }),
    jobRegistry: registry,
    accountDefense: {
      lockForChargeback: (args) => {
        defenseLocks.push(args.userId);
        return okAsync({ locked: true, email: 'victim@example.test' });
      },
    },
    accountLockedEmail: {
      sendAccountLockedEmail: (args) => {
        lockedEmails.push(args.to);
        return okAsync();
      },
    },
    ...overrides,
  };
  const manifest = createBillingManifest(deps);
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  appHolder.app = app;
  return { app, provider, defenseLocks, lockedEmails, deps };
}

function createApp(): Hono<AppEnv> {
  return buildDeps().app;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return createApp().request(path, init, testEnv);
}

async function signedWebhook(
  app: Hono<AppEnv>,
  payload: string,
  headerOverrides: Record<string, string | undefined> = {}
): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const webhookId = `wh-${crypto.randomUUID()}`;
  const signature = await signHmacSha256Webhook({
    secret: WEBHOOK_VERIFIER,
    payload,
    timestamp,
    webhookId,
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const defaults: Record<string, string> = {
    'webhook-signature': signature,
    'webhook-timestamp': timestamp,
    'webhook-id': webhookId,
  };
  for (const [name, value] of Object.entries({ ...defaults, ...headerOverrides })) {
    if (value !== undefined) headers[name] = value;
  }
  return app.request(
    '/billing/webhooks/payment',
    { method: 'POST', headers, body: payload },
    testEnv
  );
}

afterAll(async () => {
  await db.delete(jobs).where(like(jobs.dedupeKey, 'payment.verify:%'));
  if (createdUserIds.length > 0) {
    const paymentRows = await db
      .select({ id: payments.id })
      .from(payments)
      .where(inArray(payments.userId, createdUserIds));
    const paymentIds = paymentRows.map((row) => row.id);
    if (paymentIds.length > 0) {
      const legRows = await db
        .select({ transactionId: ledgerEntries.transactionId })
        .from(ledgerEntries)
        .where(inArray(ledgerEntries.paymentId, paymentIds));
      const transactionIds = [...new Set(legRows.map((row) => row.transactionId))];
      if (transactionIds.length > 0) {
        await db.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, transactionIds));
      }
      await db.delete(payments).where(inArray(payments.id, paymentIds));
    }
    await db.delete(allowanceSpending).where(inArray(allowanceSpending.userId, createdUserIds));
    const walletRows = await db
      .select({ id: wallets.id })
      .from(wallets)
      .where(inArray(wallets.userId, createdUserIds));
    const walletIds = walletRows.map((row) => row.id);
    if (walletIds.length > 0) {
      await db.delete(wallets).where(inArray(wallets.id, walletIds));
    }
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('GET /billing/balance under store failure', () => {
  it('maps a store failure onto the typed unavailable response', async () => {
    const userId = await createUser();
    const failingStores = {
      ...createBillingStores(),
      readWallets: () => errAsync(unavailableError('store down')),
    };
    const { app } = buildDeps({ stores: failingStores });
    const res = await app.request(
      '/billing/balance',
      { headers: { cookie: await sessionCookie(userId) } },
      testEnv
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});

describe('GET /billing/balance', () => {
  it('rejects an unauthenticated caller', async () => {
    const res = await request('/billing/balance');
    expect(res.status).toBe(401);
  });

  it('returns wallet balances as NanoUSD strings with the allowance readout', async () => {
    const userId = await createUser();
    await db.insert(wallets).values([
      { userId, type: 'purchased', balanceNanoUsd: 200_000_000n },
      { userId, type: 'free', balanceNanoUsd: 0n },
    ]);
    const res = await request('/billing/balance', {
      headers: { cookie: await sessionCookie(userId) },
    });
    expect(res.status).toBe(200);
    const body = await balanceBody(res);
    expect(body.purchased.balanceNanoUsd).toBe('200000000');
    expect(body.free.balanceNanoUsd).toBe('0');
    expect(body.allowance.limitNanoUsd).toBe('50000000');
    expect(body.allowance.spentNanoUsd).toBe('0');
    expect(body.allowance.remainingNanoUsd).toBe('50000000');
    expect(body.allowance.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reports zero balances before provisioning', async () => {
    const userId = await createUser();
    const res = await request('/billing/balance', {
      headers: { cookie: await sessionCookie(userId) },
    });
    expect(res.status).toBe(200);
    const body = await balanceBody(res);
    expect(body.purchased.balanceNanoUsd).toBe('0');
    expect(body.free.balanceNanoUsd).toBe('0');
  });

  it('subtracts today’s spending from the allowance without ever going negative', async () => {
    // Pin only Date so the seeded day and the route's own `new Date()` share
    // one clock — a real UTC-midnight rollover between them would flake.
    vi.useFakeTimers({ now: new Date('2026-07-03T12:00:00Z'), toFake: ['Date'] });
    try {
      const userId = await createUser();
      const day = new Date().toISOString().slice(0, 10);
      await db.insert(allowanceSpending).values({ userId, day, spentNanoUsd: 60_000_000n });
      const res = await request('/billing/balance', {
        headers: { cookie: await sessionCookie(userId) },
      });
      const body = await balanceBody(res);
      expect(body.allowance.spentNanoUsd).toBe('60000000');
      expect(body.allowance.remainingNanoUsd).toBe('0');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GET /billing/usage', () => {
  const usageModelIds: string[] = [];

  async function seedUsageModel(): Promise<string> {
    const rows = await db
      .insert(modelCatalog)
      .values({
        modelId: `billing-routes-usage/${crypto.randomUUID()}`,
        version: 1,
        descriptor: {},
      })
      .returning({ id: modelCatalog.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('usage model seed failed');
    usageModelIds.push(id);
    return id;
  }

  async function seedUsage(
    userId: string,
    modelCatalogId: string,
    costNanoUsd: bigint,
    isEstimated: boolean
  ): Promise<void> {
    await db.insert(usageRecords).values({
      userId,
      runId: crypto.randomUUID(),
      modelCatalogId,
      modality: 'text',
      costNanoUsd,
      isEstimated,
      idempotencyKey: `routes-usage:${crypto.randomUUID()}`,
    });
  }

  interface UsageBody {
    readonly models: readonly {
      readonly modelCatalogId: string;
      readonly totalNanoUsd: string;
      readonly recordCount: number;
      readonly estimatedCount: number;
    }[];
    readonly nextCursor: string | null;
  }

  afterAll(async () => {
    if (usageModelIds.length > 0) {
      await db.delete(usageRecords).where(inArray(usageRecords.modelCatalogId, usageModelIds));
      await db.delete(modelCatalog).where(inArray(modelCatalog.id, usageModelIds));
    }
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await request('/billing/usage');
    expect(res.status).toBe(401);
  });

  it('returns the caller per-model spend as NanoUSD strings', async () => {
    const userId = await createUser();
    const model = await seedUsageModel();
    await seedUsage(userId, model, 1000n, false);
    await seedUsage(userId, model, 2000n, true);
    const res = await request('/billing/usage', {
      headers: { cookie: await sessionCookie(userId) },
    });
    expect(res.status).toBe(200);
    const body: UsageBody = await res.json();
    const entry = body.models.find((m) => m.modelCatalogId === model);
    expect(entry?.totalNanoUsd).toBe('3000');
    expect(entry?.recordCount).toBe(2);
    expect(entry?.estimatedCount).toBe(1);
  });

  it('never returns another user spend', async () => {
    const userId = await createUser();
    const otherId = await createUser();
    const mine = await seedUsageModel();
    const theirs = await seedUsageModel();
    await seedUsage(userId, mine, 1000n, false);
    await seedUsage(otherId, theirs, 9000n, false);
    const res = await request('/billing/usage', {
      headers: { cookie: await sessionCookie(userId) },
    });
    const body: UsageBody = await res.json();
    const ids = body.models.map((m) => m.modelCatalogId);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it('sums only the caller rows for a model both users share', async () => {
    const userId = await createUser();
    const otherId = await createUser();
    const shared = await seedUsageModel();
    await seedUsage(userId, shared, 1000n, false);
    await seedUsage(otherId, shared, 8000n, false);
    const res = await request('/billing/usage', {
      headers: { cookie: await sessionCookie(userId) },
    });
    const body: UsageBody = await res.json();
    const entry = body.models.find((m) => m.modelCatalogId === shared);
    // The other user's 8000n row must be excluded, not summed into the total.
    expect(entry?.totalNanoUsd).toBe('1000');
    expect(entry?.recordCount).toBe(1);
  });

  it('paginates by model id with a next cursor', async () => {
    const userId = await createUser();
    const first = await seedUsageModel();
    const second = await seedUsageModel();
    await seedUsage(userId, first, 1000n, false);
    await seedUsage(userId, second, 1000n, false);
    const page1 = await request('/billing/usage?limit=1', {
      headers: { cookie: await sessionCookie(userId) },
    });
    const body1: UsageBody = await page1.json();
    expect(body1.models.map((m) => m.modelCatalogId)).toEqual([first]);
    expect(body1.nextCursor).toBe(first);
    const page2 = await request(`/billing/usage?limit=1&cursor=${String(body1.nextCursor)}`, {
      headers: { cookie: await sessionCookie(userId) },
    });
    const body2: UsageBody = await page2.json();
    expect(body2.models.map((m) => m.modelCatalogId)).toEqual([second]);
  });

  it('maps a store failure onto a 503', async () => {
    const userId = await createUser();
    const failingStores = {
      ...createBillingStores(),
      aggregateUsageByModel: () => errAsync(unavailableError('store down')),
    };
    const { app } = buildDeps({ stores: failingStores });
    const res = await app.request(
      '/billing/usage',
      { headers: { cookie: await sessionCookie(userId) } },
      testEnv
    );
    expect(res.status).toBe(503);
    // Code only — no internal store detail leaks to the client.
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});

describe('POST /billing/payments', () => {
  it('rejects an unauthenticated caller', async () => {
    const { app } = buildDeps();
    const res = await app.request(
      '/billing/payments',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          amountNanoUsd: '5000000000',
          cardToken: 'tok',
          customerCode: 'cust',
        }),
      },
      testEnv
    );
    expect(res.status).toBe(401);
  });

  it('requires the Idempotency-Key header', async () => {
    const userId = await createUser();
    const { app } = buildDeps();
    const res = await app.request(
      '/billing/payments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: await sessionCookie(userId),
        },
        body: JSON.stringify({
          amountNanoUsd: '5000000000',
          cardToken: 'tok',
          customerCode: 'cust',
        }),
      },
      testEnv
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('rejects a malformed body', async () => {
    const userId = await createUser();
    const { app } = buildDeps();
    const res = await app.request(
      '/billing/payments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          cookie: await sessionCookie(userId),
        },
        body: JSON.stringify({ amountNanoUsd: 5, cardToken: 'tok', customerCode: 'cust' }),
      },
      testEnv
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('rejects an amount below the five dollar minimum', async () => {
    const userId = await createUser();
    const { app } = buildDeps();
    const res = await app.request(
      '/billing/payments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          cookie: await sessionCookie(userId),
        },
        body: JSON.stringify({
          amountNanoUsd: '1000000000',
          cardToken: 'tok',
          customerCode: 'cust',
        }),
      },
      testEnv
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('charges, awaits the webhook, and credits the balance end to end', async () => {
    const userId = await createUser();
    const { app, provider } = buildDeps();
    const res = await app.request(
      '/billing/payments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          cookie: await sessionCookie(userId),
        },
        body: JSON.stringify({
          amountNanoUsd: '5000000000',
          cardToken: 'tok',
          customerCode: 'cust',
        }),
      },
      testEnv
    );
    expect(res.status).toBe(200);
    const body = await paymentBody(res);
    expect(body.status).toBe('awaiting_webhook');
    expect(body.amountNanoUsd).toBe('5000000000');
    // The mock delivers its signed webhook to this very app.
    await provider.flushWebhooks();
    expect(provider.getWebhookDeliveryFailures()).toHaveLength(0);
    const row = await stores.readPayment(db, body.paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('completed');
    const balanceRes = await app.request(
      '/billing/balance',
      { headers: { cookie: await sessionCookie(userId) } },
      testEnv
    );
    const balance = await balanceBody(balanceRes);
    expect(balance.purchased.balanceNanoUsd).toBe('5000000000');
  });

  it('replays the same response for a repeated Idempotency-Key', async () => {
    const userId = await createUser();
    const { app, provider } = buildDeps();
    const key = crypto.randomUUID();
    const send = async (): Promise<Response> =>
      app.request(
        '/billing/payments',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
            cookie: await sessionCookie(userId),
          },
          body: JSON.stringify({
            amountNanoUsd: '5000000000',
            cardToken: 'tok',
            customerCode: 'cust',
          }),
        },
        testEnv
      );
    const first = await paymentBody(await send());
    const second = await paymentBody(await send());
    expect(second.paymentId).toBe(first.paymentId);
    expect(provider.getChargeRequests()).toHaveLength(1);
    await provider.flushWebhooks();
  });
});

describe('POST /billing/webhooks/payment signature gate', () => {
  it('answers 401 when the signature headers are missing', async () => {
    const { app } = buildDeps();
    const res = await signedWebhook(app, JSON.stringify({ type: 'cardTransaction', id: 'x' }), {
      'webhook-signature': undefined,
      'webhook-timestamp': undefined,
      'webhook-id': undefined,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('answers 401 for an invalid signature', async () => {
    const { app } = buildDeps();
    const res = await signedWebhook(app, JSON.stringify({ type: 'cardTransaction', id: 'x' }), {
      'webhook-signature': 'bm90LXRoZS1zaWduYXR1cmU=',
    });
    expect(res.status).toBe(401);
  });

  it('rejects a verified delivery whose body is not JSON', async () => {
    const { app } = buildDeps();
    const res = await signedWebhook(app, 'not json at all');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });
});

describe('POST /billing/webhooks/payment processing', () => {
  async function seedChargedPayment(
    userId: string
  ): Promise<{ paymentId: string; transactionId: string }> {
    const { payment } = await runSettlement(db, (tx) =>
      stores.insertPaymentIfAbsentWithinTx(tx, {
        userId,
        amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
        idempotencyKey: `pay:${userId}:${crypto.randomUUID()}`,
      })
    );
    const transactionId = `txn-${crypto.randomUUID()}`;
    await runSettlement(db, (tx) =>
      stores.markPaymentChargedWithinTx(tx, payment.id, { helcimTransactionId: transactionId })
    );
    return { paymentId: payment.id, transactionId };
  }

  it('answers 404 for a completed event with no matching pre-claim', async () => {
    const { app } = buildDeps();
    const res = await signedWebhook(
      app,
      JSON.stringify({ type: 'cardTransaction', id: `txn-${crypto.randomUUID()}` })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('credits once and absorbs the duplicate delivery', async () => {
    const userId = await createUser();
    const { app } = buildDeps();
    const { paymentId, transactionId } = await seedChargedPayment(userId);
    const payload = JSON.stringify({ type: 'cardTransaction', id: transactionId });
    const first = await signedWebhook(app, payload);
    const second = await signedWebhook(app, payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const legs = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    expect(legs).toHaveLength(2);
  });

  it('claws back and locks on a chargeback event', async () => {
    const userId = await createUser();
    const { app, defenseLocks, lockedEmails } = buildDeps();
    const { paymentId, transactionId } = await seedChargedPayment(userId);
    const completed = await signedWebhook(
      app,
      JSON.stringify({ type: 'cardTransaction', id: transactionId })
    );
    expect(completed.status).toBe(200);
    const dispute = await signedWebhook(
      app,
      JSON.stringify({ type: 'chargeback', id: transactionId })
    );
    expect(dispute.status).toBe(200);
    expect(defenseLocks).toEqual([userId]);
    expect(lockedEmails).toEqual(['victim@example.test']);
    const legs = await db
      .select({ kind: ledgerEntries.kind })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    expect(legs.filter((leg) => leg.kind === 'clawback')).toHaveLength(2);
  });

  it('notifies without locking on an inquiry', async () => {
    const userId = await createUser();
    const { app, defenseLocks } = buildDeps();
    const { transactionId } = await seedChargedPayment(userId);
    const res = await signedWebhook(app, JSON.stringify({ type: 'inquiry', id: transactionId }));
    expect(res.status).toBe(200);
    expect(defenseLocks).toHaveLength(0);
  });

  it('acknowledges an unrecognized event type without effect', async () => {
    const { app } = buildDeps();
    const res = await signedWebhook(app, JSON.stringify({ type: 'somethingNew', id: 'x' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });
});

describe('requiredIdempotencyKey', () => {
  it('treats a missing header after the pipeline stage as a defect', () => {
    const context = { req: { header: () => {} } } as unknown as Parameters<
      typeof requiredIdempotencyKey
    >[0];
    expect(() => requiredIdempotencyKey(context)).toThrow(/missing after the pipeline stage/);
  });
});

describe('POST /billing/webhooks/payment failure mapping', () => {
  it('maps a failed defensive lock onto the typed unavailable response', async () => {
    const userId = await createUser();
    const { app } = buildDeps({
      accountDefense: {
        lockForChargeback: () => errAsync(unavailableError('identity down')),
      },
    });
    const { payment } = await runSettlement(db, (tx) =>
      stores.insertPaymentIfAbsentWithinTx(tx, {
        userId,
        amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
        idempotencyKey: `pay:${userId}:${crypto.randomUUID()}`,
      })
    );
    const transactionId = `txn-${crypto.randomUUID()}`;
    await runSettlement(db, (tx) =>
      stores.markPaymentChargedWithinTx(tx, payment.id, { helcimTransactionId: transactionId })
    );
    // The defensive lock fires only on a dispute against a completed (captured)
    // payment, so drive the completion first; the chargeback then hits the
    // failing lock and the route surfaces it as unavailable for redelivery.
    const completed = await signedWebhook(
      app,
      JSON.stringify({ type: 'cardTransaction', id: transactionId })
    );
    expect(completed.status).toBe(200);
    const res = await signedWebhook(app, JSON.stringify({ type: 'chargeback', id: transactionId }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});
