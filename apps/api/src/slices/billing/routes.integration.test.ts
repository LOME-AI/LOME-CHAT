import { afterAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { eq, inArray, like } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  allowanceSpending,
  conversationMembers,
  conversationSpending,
  conversations,
  createDb,
  idempotencyKeys,
  jobs,
  ledgerEntries,
  memberBudgets,
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
import { spendableFundsNanoUsd } from '@hushbox/shared';
import { BILLING_KEYS, admitRun } from './domain/index.js';
import { createConversationFundingReader } from '../../adapters/conversation-funding.js';
import { createMockPaymentProvider } from './adapters/payment-mock.js';
import { requiredIdempotencyKey } from './routes.js';
import { createBillingManifest, createBillingStores } from './index.js';
import { Redis } from '@upstash/redis';
import { createSessionRevokeJobRegistration } from '../identity/index.js';
import type { Database } from '@hushbox/db';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { MockPaymentProvider } from './adapters/payment-mock.js';
import type { WebhookDeliveryLifetime } from './domain/index.js';
import type { BillingRouteDeps } from './routes.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for billing route integration tests'
  );
}

const SECRET = 'secret-at-least-32-characters-long!!';
const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
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
const createdConversationIds: string[] = [];
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

// The mobile → web billing-portal handoff carries a billing-only session
// (`billingOnly: true`); it reads the wallet through the `billing-token` route
// class, scoped by the sealed claims' own userId.
async function billingOnlyCookie(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      userId,
      sessionId: 'session-1',
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
      billingOnly: true,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

const WEBHOOK_VERIFIER = 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=';
const stores = createBillingStores();
/** Mirrors the pipeline's request Redis so tests can place real admission holds. */
const testRedis = new Redis({
  url: testEnv.UPSTASH_REDIS_REST_URL,
  token: testEnv.UPSTASH_REDIS_REST_TOKEN,
});
const SPENDABLE_RUN_CAP = 5;

interface PaymentTestApp {
  readonly app: Hono<AppEnv>;
  readonly provider: MockPaymentProvider;
  readonly defenseLocks: string[];
  readonly lockedEmails: string[];
  readonly bulkWakes: string[];
}

function buildDeps(
  overrides: Partial<BillingRouteDeps> = {},
  executionCtx?: WebhookDeliveryLifetime
): PaymentTestApp & {
  deps: BillingRouteDeps;
} {
  const defenseLocks: string[] = [];
  const lockedEmails: string[] = [];
  const bulkWakes: string[] = [];
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
    ...(executionCtx === undefined ? {} : { executionCtx }),
  });
  const registry = createJobRegistry();
  registry.register(createPaymentVerifyJobRegistration({ db, stores, provider }));
  // The webhook's dispute path enqueues session.revoke.v1; the handler never
  // runs in these route tests (only the enqueue), so an unreachable Redis backs
  // the registration — the schema/shard/lease is all the enqueue reads.
  registry.register(
    createSessionRevokeJobRegistration({
      redis: new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false }),
    })
  );
  const deps: BillingRouteDeps = {
    stores,
    // The real composition-root reader: this test exercises the wiring the
    // product Worker uses, not a stand-in for it.
    conversationFunding: createConversationFundingReader,
    paymentProvider: () => provider,
    webhookVerifier: () => createWebhookVerifier({ verifier: WEBHOOK_VERIFIER }),
    jobRegistry: registry,
    accountDefense: {
      lockForChargebackWithinTx: (_tx, userId) => {
        defenseLocks.push(userId);
        return Promise.resolve({ locked: true, email: 'victim@example.test' });
      },
    },
    accountLockedEmail: {
      sendChargebackLockEmail: (args) => {
        lockedEmails.push(args.to);
        return okAsync();
      },
    },
    wakeBulkDispatcher: () => {
      bulkWakes.push('bulk');
    },
    ...overrides,
  };
  const manifest = createBillingManifest(deps);
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  appHolder.app = app;
  return { app, provider, defenseLocks, lockedEmails, bulkWakes, deps };
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
  headerOverrides: Record<string, string | undefined> = {},
  executionCtx?: ExecutionContext
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
    testEnv,
    executionCtx
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
      // The dispute path enqueues session.revoke.v1 (bulk shard); clear this
      // file's rows, scoped by payment id so a concurrent file's rows are safe.
      await db.delete(jobs).where(
        inArray(
          jobs.dedupeKey,
          paymentIds.map((id) => `chargeback-revoke:${id}`)
        )
      );
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
    if (createdConversationIds.length > 0) {
      // The member-budget and conversation-spending rows cascade from here.
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
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

  it('admits a billing-only session to read its own balance', async () => {
    const userId = await createUser();
    await db.insert(wallets).values([
      { userId, type: 'purchased', balanceNanoUsd: 150_000_000n },
      { userId, type: 'free', balanceNanoUsd: 0n },
    ]);
    const res = await request('/billing/balance', {
      headers: { cookie: await billingOnlyCookie(userId) },
    });
    expect(res.status).toBe(200);
    const body = await balanceBody(res);
    expect(body.purchased.balanceNanoUsd).toBe('150000000');
  });

  it('scopes a billing-only balance read to its own wallet, never another user’s', async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    await db.insert(wallets).values([
      { userId, type: 'purchased', balanceNanoUsd: 111_000_000n },
      { userId: otherUserId, type: 'purchased', balanceNanoUsd: 999_000_000n },
    ]);
    const res = await request('/billing/balance', {
      headers: { cookie: await billingOnlyCookie(userId) },
    });
    expect(res.status).toBe(200);
    const body = await balanceBody(res);
    // The principal's own wallet — never the other user's 999_000_000.
    expect(body.purchased.balanceNanoUsd).toBe('111000000');
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

describe('GET /billing/spendable', () => {
  interface SpendableBody {
    spendableNanoUsd: string;
    heldNanoUsd: string;
    tier: string;
    payer: string;
  }

  async function spendableBody(res: Response): Promise<SpendableBody> {
    const body: unknown = await res.json();
    return body as SpendableBody;
  }

  async function seedPurchasedWallet(userId: string, balanceNanoUsd: bigint): Promise<string> {
    const rows = await db
      .insert(wallets)
      .values([
        { userId, type: 'purchased' as const, balanceNanoUsd },
        { userId, type: 'free' as const, balanceNanoUsd: 0n },
      ])
      .returning({ id: wallets.id, type: wallets.type });
    const purchasedId = rows.find((row) => row.type === 'purchased')?.id;
    if (purchasedId === undefined) throw new Error('wallet seed failed');
    return purchasedId;
  }

  async function cleanupWalletKeys(walletId: string): Promise<void> {
    await testRedis.del(
      BILLING_KEYS.walletSnapshot.buildKey(walletId),
      BILLING_KEYS.walletHolds.buildKey(walletId)
    );
  }

  it('rejects an unauthenticated caller', async () => {
    const res = await request('/billing/spendable');
    expect(res.status).toBe(401);
  });

  it('serves the cushion- and hold-aware numbers as NanoUSD strings', async () => {
    const balance = 2_000_000_000n;
    const estimate = 700_000_000n;
    const userId = await createUser();
    const walletId = await seedPurchasedWallet(userId, balance);
    const admitted = await admitRun(
      { redis: testRedis, db, stores },
      {
        walletId,
        holdId: crypto.randomUUID(),
        estimateNanoUsd: estimate,
        deadlineSeconds: 300,
        concurrentRunCap: SPENDABLE_RUN_CAP,
        budgets: [],
        now: new Date(),
      }
    );
    expect(admitted._unsafeUnwrap().admitted).toBe(true);
    const res = await request('/billing/spendable', {
      headers: { cookie: await sessionCookie(userId) },
    });
    expect(res.status).toBe(200);
    const body = await spendableBody(res);
    expect(body.spendableNanoUsd).toBe(
      (spendableFundsNanoUsd(balance, 'paid') - estimate).toString(10)
    );
    expect(body.heldNanoUsd).toBe(estimate.toString(10));
    // The wire shape is the two money fields plus the payer identity that
    // priced them (the run cap is enforced solely at admission, never served).
    expect(Object.keys(body).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'heldNanoUsd',
      'payer',
      'spendableNanoUsd',
      'tier',
    ]);
    expect(body.payer).toBe('self');
    expect(body.tier).toBe('paid');
    await cleanupWalletKeys(walletId);
  });

  it("serves the OWNER's group figures to a free-tier member composing in the group", async () => {
    const ownerUserId = await createUser();
    const memberUserId = await createUser();
    const ownerWalletId = await seedPurchasedWallet(ownerUserId, 5_000_000_000n);
    // The member's own wallet is empty: a sender-scoped read would serve $0.
    await seedPurchasedWallet(memberUserId, 0n);
    const conversationId = crypto.randomUUID();
    await db.insert(conversations).values({
      id: conversationId,
      userId: ownerUserId,
      title: BYTES,
      conversationBudgetNanoUsd: 4_000_000_000n,
    });
    createdConversationIds.push(conversationId);
    const memberRows = await db
      .insert(conversationMembers)
      .values({
        conversationId,
        userId: memberUserId,
        privilege: 'write',
        visibleFromEpoch: 1,
        acceptedAt: new Date(),
      })
      .returning({ id: conversationMembers.id });
    const memberId = memberRows[0]?.id;
    if (memberId === undefined) throw new Error('member seed failed');
    await db
      .insert(memberBudgets)
      .values({ memberId, budgetNanoUsd: 900_000_000n, spentNanoUsd: 100_000_000n });
    await db.insert(conversationSpending).values({ conversationId, spentNanoUsd: 0n });

    const res = await request(`/billing/spendable?conversationId=${conversationId}`, {
      headers: { cookie: await sessionCookie(memberUserId) },
    });
    expect(res.status).toBe(200);
    const body = await spendableBody(res);
    // The member dimension binds: $0.90 cap − $0.10 spent.
    expect(body.spendableNanoUsd).toBe('800000000');
    expect(body.payer).toBe('owner');
    expect(body.tier).toBe('paid');
    await cleanupWalletKeys(ownerWalletId);
  });

  it('rejects a conversation id that is not a uuid', async () => {
    const userId = await createUser();
    await seedPurchasedWallet(userId, 1_000_000_000n);
    const res = await request('/billing/spendable?conversationId=nope', {
      headers: { cookie: await sessionCookie(userId) },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('admits a billing-only session scoped to its own wallet', async () => {
    const userId = await createUser();
    const walletId = await seedPurchasedWallet(userId, 1_000_000_000n);
    const res = await request('/billing/spendable', {
      headers: { cookie: await billingOnlyCookie(userId) },
    });
    expect(res.status).toBe(200);
    const body = await spendableBody(res);
    expect(body.spendableNanoUsd).toBe(spendableFundsNanoUsd(1_000_000_000n, 'paid').toString(10));
    expect(body.heldNanoUsd).toBe('0');
    await cleanupWalletKeys(walletId);
  });

  it('answers 404 for a caller without a purchased wallet', async () => {
    const userId = await createUser();
    const res = await request('/billing/spendable', {
      headers: { cookie: await sessionCookie(userId) },
    });
    expect(res.status).toBe(404);
  });

  it('fails closed with a typed 503 when Redis is down while /billing/balance still serves', async () => {
    const userId = await createUser();
    await seedPurchasedWallet(userId, 1_000_000_000n);
    const deadRedisEnv = {
      ...testEnv,
      UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:9',
    };
    const app = createApp();
    const cookie = await sessionCookie(userId);
    const spendableRes = await app.request(
      '/billing/spendable',
      { headers: { cookie } },
      deadRedisEnv
    );
    expect(spendableRes.status).toBe(503);
    expect(await spendableRes.json()).toEqual({ code: 'UNAVAILABLE' });
    // The ledger-truth balance read never touches Redis: payment polling and
    // display survive a Redis outage that fails the affordability read closed.
    const balanceRes = await app.request('/billing/balance', { headers: { cookie } }, deadRedisEnv);
    expect(balanceRes.status).toBe(200);
  });
});

describe('GET /billing/usage', () => {
  const usageModelIds: string[] = [];
  let modelCounter = 0;

  // The model is a plain string (no catalog FK). Zero-padded + increasing so
  // insertion order matches the modelId keyset ordering the pagination uses.
  function seedUsageModel(): string {
    modelCounter += 1;
    const modelId = `billing-routes-usage/${String(modelCounter).padStart(6, '0')}`;
    usageModelIds.push(modelId);
    return modelId;
  }

  async function seedUsage(
    userId: string,
    modelId: string,
    costNanoUsd: bigint,
    isEstimated: boolean
  ): Promise<void> {
    await db.insert(usageRecords).values({
      userId,
      runId: crypto.randomUUID(),
      modelId,
      providerName: 'billing-routes-usage-provider',
      modality: 'text',
      costNanoUsd,
      isEstimated,
      idempotencyKey: `routes-usage:${crypto.randomUUID()}`,
    });
  }

  interface UsageBody {
    readonly models: readonly {
      readonly modelId: string;
      readonly totalNanoUsd: string;
      readonly recordCount: number;
      readonly estimatedCount: number;
    }[];
    readonly nextCursor: string | null;
  }

  afterAll(async () => {
    if (usageModelIds.length > 0) {
      await db.delete(usageRecords).where(inArray(usageRecords.modelId, usageModelIds));
    }
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await request('/billing/usage');
    expect(res.status).toBe(401);
  });

  it('returns the caller per-model spend as NanoUSD strings', async () => {
    const userId = await createUser();
    const model = seedUsageModel();
    await seedUsage(userId, model, 1000n, false);
    await seedUsage(userId, model, 2000n, true);
    const res = await request('/billing/usage', {
      headers: { cookie: await sessionCookie(userId) },
    });
    expect(res.status).toBe(200);
    const body: UsageBody = await res.json();
    const entry = body.models.find((m) => m.modelId === model);
    expect(entry?.totalNanoUsd).toBe('3000');
    expect(entry?.recordCount).toBe(2);
    expect(entry?.estimatedCount).toBe(1);
  });

  it('never returns another user spend', async () => {
    const userId = await createUser();
    const otherId = await createUser();
    const mine = seedUsageModel();
    const theirs = seedUsageModel();
    await seedUsage(userId, mine, 1000n, false);
    await seedUsage(otherId, theirs, 9000n, false);
    const res = await request('/billing/usage', {
      headers: { cookie: await sessionCookie(userId) },
    });
    const body: UsageBody = await res.json();
    const ids = body.models.map((m) => m.modelId);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it('sums only the caller rows for a model both users share', async () => {
    const userId = await createUser();
    const otherId = await createUser();
    const shared = seedUsageModel();
    await seedUsage(userId, shared, 1000n, false);
    await seedUsage(otherId, shared, 8000n, false);
    const res = await request('/billing/usage', {
      headers: { cookie: await sessionCookie(userId) },
    });
    const body: UsageBody = await res.json();
    const entry = body.models.find((m) => m.modelId === shared);
    // The other user's 8000n row must be excluded, not summed into the total.
    expect(entry?.totalNanoUsd).toBe('1000');
    expect(entry?.recordCount).toBe(1);
  });

  it('paginates by model id with a next cursor', async () => {
    const userId = await createUser();
    const first = seedUsageModel();
    const second = seedUsageModel();
    await seedUsage(userId, first, 1000n, false);
    await seedUsage(userId, second, 1000n, false);
    const page1 = await request('/billing/usage?limit=1', {
      headers: { cookie: await sessionCookie(userId) },
    });
    const body1: UsageBody = await page1.json();
    expect(body1.models.map((m) => m.modelId)).toEqual([first]);
    expect(body1.nextCursor).toBe(first);
    const page2 = await request(`/billing/usage?limit=1&cursor=${String(body1.nextCursor)}`, {
      headers: { cookie: await sessionCookie(userId) },
    });
    const body2: UsageBody = await page2.json();
    expect(body2.models.map((m) => m.modelId)).toEqual([second]);
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

  it('credits the balance through an execution-context-registered webhook delivery', async () => {
    const userId = await createUser();
    // The mock registers its confirming webhook delivery on this handle;
    // driving only these promises (never flushWebhooks) proves the
    // lifetime-safe path credits the wallet on its own.
    const registered: Promise<unknown>[] = [];
    const { app } = buildDeps({}, { waitUntil: (promise) => registered.push(promise) });
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
    expect(registered.length).toBeGreaterThan(0);
    await Promise.all(registered);
    const balanceRes = await app.request(
      '/billing/balance',
      { headers: { cookie: await sessionCookie(userId) } },
      testEnv
    );
    const balance = await balanceBody(balanceRes);
    expect(balance.purchased.balanceNanoUsd).toBe('5000000000');
  });

  it('threads a webhook-lifetime handle into the payment provider on the charge path', async () => {
    const userId = await createUser();
    let capturedLifetime: WebhookDeliveryLifetime | undefined;
    const providerHolder: { provider?: MockPaymentProvider } = {};
    const { app, provider } = buildDeps({
      paymentProvider: (_env, _db, lifetime) => {
        capturedLifetime = lifetime;
        if (providerHolder.provider === undefined) throw new Error('provider not wired');
        return providerHolder.provider;
      },
    });
    providerHolder.provider = provider;
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
    // The route always hands the mock a lifetime handle; `waitUntil` is not
    // invoked here (that would read the absent test execution context).
    expect(capturedLifetime).toBeDefined();
    expect(typeof capturedLifetime?.waitUntil).toBe('function');
    await provider.flushWebhooks();
  });

  it('threads the request db into the payment provider on the charge path', async () => {
    const userId = await createUser();
    let capturedDb: Database | undefined;
    const providerHolder: { provider?: MockPaymentProvider } = {};
    const { app, provider } = buildDeps({
      paymentProvider: (_env, providerDb) => {
        capturedDb = providerDb;
        if (providerHolder.provider === undefined) throw new Error('provider not wired');
        return providerHolder.provider;
      },
    });
    providerHolder.provider = provider;
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
    // The real charge adapter records service evidence off this db; without it
    // threaded through, a CI charge can never prove the Helcim seam was hit.
    expect(capturedDb).toBeDefined();
    expect(typeof (capturedDb as { insert: unknown }).insert).toBe('function');
    await provider.flushWebhooks();
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

  it('claws back, locks, and wakes the bulk dispatcher on a chargeback event', async () => {
    const userId = await createUser();
    const { app, defenseLocks, lockedEmails, bulkWakes } = buildDeps();
    const { paymentId, transactionId } = await seedChargedPayment(userId);
    // A mock execution context so the route's post-commit waitUntil nudge runs.
    const ctx: ExecutionContext = {
      waitUntil: () => {
        /* the nudge is fire-and-forget; not awaited in tests */
      },
      passThroughOnException: () => {
        /* no-op in tests */
      },
      props: {},
    };
    const completed = await signedWebhook(
      app,
      JSON.stringify({ type: 'cardTransaction', id: transactionId }),
      {},
      ctx
    );
    expect(completed.status).toBe(200);
    const dispute = await signedWebhook(
      app,
      JSON.stringify({ type: 'chargeback', id: transactionId }),
      {},
      ctx
    );
    expect(dispute.status).toBe(200);
    expect(defenseLocks).toEqual([userId]);
    expect(lockedEmails).toEqual(['victim@example.test']);
    // The freshly-enqueued revoke job triggers exactly one bulk-dispatcher nudge.
    expect(bulkWakes).toEqual(['bulk']);
    const legs = await db
      .select({ kind: ledgerEntries.kind })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    expect(legs.filter((leg) => leg.kind === 'clawback')).toHaveLength(2);

    // A redelivery (reversal) enqueues nothing (dedupe), so it never re-wakes.
    const reversal = await signedWebhook(
      app,
      JSON.stringify({ type: 'reversal', id: transactionId }),
      {},
      ctx
    );
    expect(reversal.status).toBe(200);
    expect(bulkWakes).toEqual(['bulk']);
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
        lockForChargebackWithinTx: () => Promise.reject(new Error('identity down')),
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

describe('POST /billing/login-link', () => {
  // The mint writes identity's Redis handoff key, so this block uses the live
  // SRH credentials (the shared testEnv token never mattered — no other billing
  // route touches Redis).
  const REDIS_URL = process.env['UPSTASH_REDIS_REST_URL'];
  const REDIS_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error('UPSTASH_REDIS_REST_URL/TOKEN are required for the login-link tests');
  }
  const redisEnv: Bindings & TelemetryEnv = {
    ...testEnv,
    UPSTASH_REDIS_REST_URL: REDIS_URL,
    UPSTASH_REDIS_REST_TOKEN: REDIS_TOKEN,
  };
  const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });

  it('mints a billing-portal token for the session caller', async () => {
    const userId = await createUser();
    const res = await createApp().request(
      '/billing/login-link',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID(), cookie: await sessionCookie(userId) },
      },
      redisEnv
    );
    expect(res.status).toBe(200);
    const body: { token: string } = await res.json();
    expect(typeof body.token).toBe('string');
    // The minted token is a valid Redis entry resolving to the caller.
    const stored = await redis.get<{ userId: string }>(`billing:login-token:${body.token}`);
    expect(stored).toEqual({ userId });
  });

  it('rejects a request with no session', async () => {
    const res = await createApp().request(
      '/billing/login-link',
      { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() } },
      redisEnv
    );
    expect(res.status).toBe(401);
  });

  it('replays the same token for a repeated Idempotency-Key', async () => {
    const userId = await createUser();
    const key = crypto.randomUUID();
    const headers = { 'Idempotency-Key': key, cookie: await sessionCookie(userId) };
    const app = createApp();
    const first = await app.request('/billing/login-link', { method: 'POST', headers }, redisEnv);
    const second = await app.request('/billing/login-link', { method: 'POST', headers }, redisEnv);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
  });

  it('requires the Idempotency-Key header', async () => {
    const userId = await createUser();
    const res = await createApp().request(
      '/billing/login-link',
      { method: 'POST', headers: { cookie: await sessionCookie(userId) } },
      redisEnv
    );
    expect(res.status).toBe(400);
  });

  it('answers IDEMPOTENCY_BODY_MISMATCH when a reused key carries a different body', async () => {
    const userId = await createUser();
    const app = createApp();
    // A first real request records the key row so the exact stored route can be read.
    await app.request(
      '/billing/login-link',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID(), cookie: await sessionCookie(userId) },
      },
      redisEnv
    );
    const [recorded] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.userId, userId));
    if (!recorded) throw new Error('expected the mint to record an idempotency key row');
    // Seed a conflicting request-kind row: same scope shape, mismatching body hash.
    const conflictKey = crypto.randomUUID();
    await db.insert(idempotencyKeys).values({
      userId,
      route: recorded.route,
      key: conflictKey,
      kind: 'request',
      bodyHash: 'a-different-body-hash',
      claimedBy: crypto.randomUUID(),
    });
    const res = await app.request(
      '/billing/login-link',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': conflictKey, cookie: await sessionCookie(userId) },
      },
      redisEnv
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
  });
});
