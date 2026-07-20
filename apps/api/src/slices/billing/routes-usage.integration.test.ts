import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { and, eq, inArray, like } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversations,
  createDb,
  ledgerEntries,
  llmCompletions,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { createJobRegistry } from '../../lib/jobs/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { createWebhookVerifier } from './domain/index.js';
import { createMockPaymentProvider } from './adapters/payment-mock.js';
import { createBillingManifest, createBillingStores } from './index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { BillingRouteDeps } from './routes.js';
import type { BillingStores } from './ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for billing usage-routes integration tests');
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
const stores = createBillingStores();
const BYTES = new Uint8Array([1, 2, 3]);

// Two whole UTC days the fixtures land in; queried inclusively below.
const DAY1 = '2026-03-10';
const DAY2 = '2026-03-11';
const at = (day: string): Date => new Date(`${day}T12:00:00.000Z`);
// Distinct within-day times give the ledger reads a deterministic order.
const atHour = (day: string, hour: number): Date =>
  new Date(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);

const MODEL_A = 'usage-reads/model-a';
const MODEL_B = 'usage-reads/model-b';
const MODEL_IMG = 'usage-reads/model-image';
const PROVIDER = 'usage-reads-provider';

const createdUserIds: string[] = [];
let counter = 0;

function buildApp(overrides: Partial<BillingRouteDeps> = {}): Hono<AppEnv> {
  const provider = createMockPaymentProvider({
    webhookUrl: 'http://localhost/billing/webhooks/payment',
    webhookVerifier: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=',
    webhookDelayMs: 0,
    fetchImpl: () => Promise.reject(new Error('unused')),
  });
  const deps: BillingRouteDeps = {
    stores,
    paymentProvider: () => provider,
    webhookVerifier: () => createWebhookVerifier({ verifier: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=' }),
    jobRegistry: createJobRegistry(),
    accountDefense: { lockForChargebackWithinTx: () => Promise.reject(new Error('unused')) },
    accountLockedEmail: { sendChargebackLockEmail: () => errAsync(unavailableError('unused')) },
    ...overrides,
  };
  const manifest = createBillingManifest(deps);
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
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

async function seedUser(): Promise<string> {
  counter += 1;
  const username = `blur${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(counter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@usage-reads.test`,
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

async function seedConversation(userId: string): Promise<string> {
  const rows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('conversation seed failed');
  return id;
}

async function seedTextUsage(args: {
  userId: string;
  conversationId: string;
  modelId: string;
  costNanoUsd: bigint;
  createdAt: Date;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}): Promise<void> {
  const inserted = await db
    .insert(usageRecords)
    .values({
      userId: args.userId,
      conversationId: args.conversationId,
      runId: crypto.randomUUID(),
      modelId: args.modelId,
      providerName: PROVIDER,
      modality: 'text',
      costNanoUsd: args.costNanoUsd,
      isEstimated: false,
      idempotencyKey: `usage-reads:${crypto.randomUUID()}`,
      createdAt: args.createdAt,
    })
    .returning({ id: usageRecords.id });
  const usageRecordId = inserted[0]?.id;
  if (usageRecordId === undefined) throw new Error('usage seed failed');
  await db.insert(llmCompletions).values({
    usageRecordId,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    cachedInputTokens: args.cachedInputTokens,
  });
}

async function seedImageUsage(args: {
  userId: string;
  conversationId: string;
  costNanoUsd: bigint;
  createdAt: Date;
}): Promise<void> {
  // No llm_completions row — an image generation is deliberately absent from the
  // token-joined aggregations but present in the per-conversation total.
  await db.insert(usageRecords).values({
    userId: args.userId,
    conversationId: args.conversationId,
    runId: crypto.randomUUID(),
    modelId: MODEL_IMG,
    providerName: PROVIDER,
    modality: 'image',
    costNanoUsd: args.costNanoUsd,
    isEstimated: false,
    idempotencyKey: `usage-reads:${crypto.randomUUID()}`,
    createdAt: args.createdAt,
  });
}

async function seedWallet(userId: string): Promise<string> {
  const rows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased' })
    .returning({ id: wallets.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('wallet seed failed');
  return id;
}

async function seedLeg(args: {
  walletId: string;
  kind: 'deposit' | 'charge' | 'clawback' | 'promo' | 'refund';
  amountNanoUsd: bigint;
  balanceAfterNanoUsd: bigint;
  createdAt: Date;
}): Promise<void> {
  // Double-entry: the user-wallet leg plus a balancing house leg (excluded from
  // every read here) sharing a transactionId — the deferred zero-sum trigger
  // checks the pair at commit, so both must land in one transaction.
  const transactionId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(ledgerEntries).values([
      {
        transactionId,
        walletId: args.walletId,
        kind: args.kind,
        amountNanoUsd: args.amountNanoUsd,
        balanceAfterNanoUsd: args.balanceAfterNanoUsd,
        idempotencyKey: `usage-reads-leg:${crypto.randomUUID()}`,
        createdAt: args.createdAt,
      },
      {
        transactionId,
        houseAccount: 'revenue',
        kind: args.kind,
        amountNanoUsd: -args.amountNanoUsd,
        idempotencyKey: `usage-reads-house:${crypto.randomUUID()}`,
        createdAt: args.createdAt,
      },
    ]);
  });
}

let userId: string;
let otherUserId: string;
let convA: string;
let convB: string;
let cookie: string;
let walletId: string;

beforeAll(async () => {
  userId = await seedUser();
  otherUserId = await seedUser();
  cookie = await sessionCookie(userId);
  convA = await seedConversation(userId);
  convB = await seedConversation(userId);
  walletId = await seedWallet(userId);

  await seedTextUsage({
    userId,
    conversationId: convA,
    modelId: MODEL_A,
    costNanoUsd: 1000n,
    createdAt: at(DAY1),
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 10,
  });
  await seedTextUsage({
    userId,
    conversationId: convA,
    modelId: MODEL_A,
    costNanoUsd: 2000n,
    createdAt: at(DAY1),
    inputTokens: 200,
    outputTokens: 100,
    cachedInputTokens: 20,
  });
  await seedTextUsage({
    userId,
    conversationId: convB,
    modelId: MODEL_B,
    costNanoUsd: 5000n,
    createdAt: at(DAY2),
    inputTokens: 300,
    outputTokens: 150,
    cachedInputTokens: 0,
  });
  await seedImageUsage({ userId, conversationId: convB, costNanoUsd: 3000n, createdAt: at(DAY2) });
  // Another user's usage must never leak into the caller's reads.
  const otherConv = await seedConversation(otherUserId);
  await seedTextUsage({
    userId: otherUserId,
    conversationId: otherConv,
    modelId: MODEL_A,
    costNanoUsd: 9000n,
    createdAt: at(DAY1),
    inputTokens: 999,
    outputTokens: 999,
    cachedInputTokens: 999,
  });

  // One ledger leg of every kind (covers the kind → legacy-type mapping), plus a
  // house-account leg that the user-leg reads must exclude.
  await seedLeg({
    walletId,
    kind: 'deposit',
    amountNanoUsd: 10_000n,
    balanceAfterNanoUsd: 10_000n,
    createdAt: atHour(DAY1, 10),
  });
  await seedLeg({
    walletId,
    kind: 'charge',
    amountNanoUsd: -3000n,
    balanceAfterNanoUsd: 7000n,
    createdAt: atHour(DAY1, 11),
  });
  await seedLeg({
    walletId,
    kind: 'clawback',
    amountNanoUsd: -500n,
    balanceAfterNanoUsd: 6500n,
    createdAt: atHour(DAY2, 10),
  });
  await seedLeg({
    walletId,
    kind: 'promo',
    amountNanoUsd: 200n,
    balanceAfterNanoUsd: 6700n,
    createdAt: atHour(DAY2, 11),
  });
  await seedLeg({
    walletId,
    kind: 'refund',
    amountNanoUsd: 300n,
    balanceAfterNanoUsd: 7000n,
    createdAt: atHour(DAY2, 12),
  });
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    const walletRows = await db
      .select({ id: wallets.id })
      .from(wallets)
      .where(inArray(wallets.userId, createdUserIds));
    const walletIds = walletRows.map((row) => row.id);
    // Both legs of each seeded transaction go in one statement — a partial
    // delete would leave an unbalanced transaction and trip the zero-sum trigger.
    await db.delete(ledgerEntries).where(like(ledgerEntries.idempotencyKey, 'usage-reads-%'));
    await db.delete(usageRecords).where(inArray(usageRecords.userId, createdUserIds));
    if (walletIds.length > 0) {
      await db.delete(wallets).where(inArray(wallets.id, walletIds));
    }
    await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

function get(app: Hono<AppEnv>, path: string, authed = true): Promise<Response> {
  return Promise.resolve(app.request(path, authed ? { headers: { cookie } } : {}, testEnv));
}

async function jsonBody<T>(res: Response): Promise<T> {
  const body: unknown = await res.json();
  return body as T;
}

interface Series<Row> {
  data: Row[];
}

interface Page {
  transactions: { type: string }[];
  nextCursor: string | null;
}

const RANGE = `startDate=${DAY1}&endDate=${DAY2}`;

describe('GET /billing/usage/summary', () => {
  it('rejects an unauthenticated caller', async () => {
    const res = await get(buildApp(), `/billing/usage/summary?${RANGE}`, false);
    expect(res.status).toBe(401);
  });

  it('totals cost + tokens over the caller’s language generations', async () => {
    const res = await get(buildApp(), `/billing/usage/summary?${RANGE}`);
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      totalSpent: string;
      messageCount: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCachedTokens: number;
    }>(res);
    // Text rows only (image has no llm_completions): 1000 + 2000 + 5000.
    expect(body.totalSpent).toBe('8000');
    expect(body.messageCount).toBe(3);
    expect(body.totalInputTokens).toBe(600);
    expect(body.totalOutputTokens).toBe(300);
    expect(body.totalCachedTokens).toBe(30);
  });

  it('returns zeros for a range with no usage', async () => {
    const res = await get(
      buildApp(),
      `/billing/usage/summary?startDate=2020-01-01&endDate=2020-01-02`
    );
    const body = await jsonBody<{ totalSpent: string; messageCount: number }>(res);
    expect(body.totalSpent).toBe('0');
    expect(body.messageCount).toBe(0);
  });

  it('rejects a malformed date range', async () => {
    const res = await get(buildApp(), `/billing/usage/summary?startDate=nope&endDate=${DAY2}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });
});

describe('GET /billing/usage/spending-over-time', () => {
  it('buckets spend by day and model', async () => {
    const res = await get(buildApp(), `/billing/usage/spending-over-time?${RANGE}&granularity=day`);
    expect(res.status).toBe(200);
    const { data } =
      await jsonBody<Series<{ period: string; model: string; totalCost: string; count: number }>>(
        res
      );
    const a = data.find((row) => row.model === MODEL_A);
    expect(a?.totalCost).toBe('3000');
    expect(a?.count).toBe(2);
    const b = data.find((row) => row.model === MODEL_B);
    expect(b?.totalCost).toBe('5000');
    expect(b?.count).toBe(1);
  });

  it('narrows to a single model when filtered', async () => {
    const res = await get(
      buildApp(),
      `/billing/usage/spending-over-time?${RANGE}&granularity=week&model=${MODEL_A}`
    );
    const { data } = await jsonBody<Series<{ model: string }>>(res);
    expect(data.every((row) => row.model === MODEL_A)).toBe(true);
  });
});

describe('GET /billing/usage/cost-by-model', () => {
  it('breaks down spend + tokens per model, priciest first, excluding media', async () => {
    const res = await get(buildApp(), `/billing/usage/cost-by-model?${RANGE}`);
    const { data } = await jsonBody<
      Series<{
        model: string;
        provider: string;
        totalCost: string;
        messageCount: number;
        totalInputTokens: number;
        totalOutputTokens: number;
      }>
    >(res);
    expect(data.map((row) => row.model)).toEqual([MODEL_B, MODEL_A]);
    expect(data.some((row) => row.model === MODEL_IMG)).toBe(false);
    const a = data.find((row) => row.model === MODEL_A);
    expect(a?.totalCost).toBe('3000');
    expect(a?.provider).toBe(PROVIDER);
    expect(a?.totalInputTokens).toBe(300);
    expect(a?.totalOutputTokens).toBe(150);
  });
});

describe('GET /billing/usage/token-usage-over-time', () => {
  it('sums token counts per period', async () => {
    const res = await get(
      buildApp(),
      `/billing/usage/token-usage-over-time?${RANGE}&granularity=day`
    );
    const { data } =
      await jsonBody<
        Series<{ period: string; inputTokens: number; outputTokens: number; cachedTokens: number }>
      >(res);
    const totalInput = data.reduce((sum, row) => sum + row.inputTokens, 0);
    expect(totalInput).toBe(600);
    const totalCached = data.reduce((sum, row) => sum + row.cachedTokens, 0);
    expect(totalCached).toBe(30);
  });

  it('narrows tokens to a single model when filtered', async () => {
    const res = await get(
      buildApp(),
      `/billing/usage/token-usage-over-time?${RANGE}&granularity=day&model=${MODEL_B}`
    );
    const { data } = await jsonBody<Series<{ inputTokens: number }>>(res);
    expect(data.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(300);
  });
});

describe('GET /billing/usage/spending-by-conversation', () => {
  it('groups spend by conversation (all modalities), priciest first', async () => {
    const res = await get(buildApp(), `/billing/usage/spending-by-conversation?${RANGE}`);
    const { data } = await jsonBody<Series<{ conversationId: string; totalSpent: string }>>(res);
    expect(data.map((row) => row.conversationId)).toEqual([convB, convA]);
    // convB carries the text (5000) and the image (3000) generation.
    expect(data.find((row) => row.conversationId === convB)?.totalSpent).toBe('8000');
    expect(data.find((row) => row.conversationId === convA)?.totalSpent).toBe('3000');
  });
});

describe('GET /billing/usage/balance-history', () => {
  it('returns user-wallet legs oldest-first, excluding house legs', async () => {
    const res = await get(buildApp(), `/billing/usage/balance-history?${RANGE}`);
    const { data } =
      await jsonBody<
        Series<{ createdAt: string; balanceAfter: string; entryType: string; amount: string }>
      >(res);
    expect(data).toHaveLength(5);
    expect(data.map((row) => row.entryType)).toEqual([
      'deposit',
      'charge',
      'clawback',
      'promo',
      'refund',
    ]);
    expect(data[0]?.amount).toBe('10000');
    expect(data[0]?.balanceAfter).toBe('10000');
    expect(data[1]?.amount).toBe('-3000');
  });

  it('respects the row limit', async () => {
    const res = await get(buildApp(), `/billing/usage/balance-history?${RANGE}&limit=2`);
    const { data } = await jsonBody<Series<unknown>>(res);
    expect(data).toHaveLength(2);
  });
});

describe('GET /billing/usage/models', () => {
  it('lists the caller’s distinct models ascending', async () => {
    const res = await get(buildApp(), '/billing/usage/models');
    const { models } = await jsonBody<{ models: string[] }>(res);
    expect(models).toEqual([MODEL_A, MODEL_B, MODEL_IMG]);
  });
});

describe('GET /billing/transactions', () => {
  it('pages newest-first with a next cursor, serializing the ledger kind', async () => {
    const res = await get(buildApp(), '/billing/transactions?limit=2');
    const body = await jsonBody<{
      transactions: { type: string; amount: string; balanceAfter: string; model: null }[];
      nextCursor: string | null;
    }>(res);
    expect(body.transactions).toHaveLength(2);
    // Newest-first: refund then promo (both on DAY2, insertion order).
    expect(body.transactions[0]?.type).toBe('refund');
    expect(body.transactions[0]?.model).toBeNull();
    expect(body.nextCursor).not.toBeNull();
  });

  it('walks the whole history across a cursor and back-fills every kind', async () => {
    const firstRes = await get(buildApp(), '/billing/transactions?limit=3');
    const first = await jsonBody<Page>(firstRes);
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('expected a next cursor');
    const secondRes = await get(
      buildApp(),
      `/billing/transactions?limit=3&cursor=${encodeURIComponent(cursor)}`
    );
    const second = await jsonBody<Page>(secondRes);
    const types = [...first.transactions, ...second.transactions].map((txn) => txn.type);
    expect(new Set(types)).toEqual(new Set(['deposit', 'charge', 'clawback', 'promo', 'refund']));
    expect(second.nextCursor).toBeNull();
  });

  it.each([['deposit'], ['charge'], ['refund'], ['clawback'], ['promo']])(
    'filters by ledger kind %s',
    async (filter) => {
      const res = await get(buildApp(), `/billing/transactions?type=${filter}`);
      const { transactions } = await jsonBody<Page>(res);
      expect(transactions).toHaveLength(1);
      expect(transactions[0]?.type).toBe(filter);
    }
  );

  it('rejects the retired `renewal` type at the query schema', async () => {
    // `renewal` is a retired legacy ledger kind — the new ledger writes no such
    // rows, so the value is gone from the enum and the filter is schema-rejected
    // rather than silently returning an empty page.
    const res = await get(buildApp(), '/billing/transactions?type=renewal');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('honors an offset page', async () => {
    const res = await get(buildApp(), '/billing/transactions?limit=2&offset=2');
    const { transactions } = await jsonBody<Page>(res);
    expect(transactions.length).toBeGreaterThan(0);
  });
});

describe('usage reads under store failure', () => {
  const failing: Partial<BillingStores> = {
    summarizeUsage: () => errAsync(unavailableError('down')),
    usageSpendingOverTime: () => errAsync(unavailableError('down')),
    usageCostByModel: () => errAsync(unavailableError('down')),
    usageTokensOverTime: () => errAsync(unavailableError('down')),
    usageSpendingByConversation: () => errAsync(unavailableError('down')),
    readLedgerHistory: () => errAsync(unavailableError('down')),
    distinctUsageModels: () => errAsync(unavailableError('down')),
    listLedgerTransactions: () => errAsync(unavailableError('down')),
  };
  const app = () => buildApp({ stores: { ...createBillingStores(), ...failing } });

  it.each([
    `/billing/usage/summary?${RANGE}`,
    `/billing/usage/spending-over-time?${RANGE}`,
    `/billing/usage/cost-by-model?${RANGE}`,
    `/billing/usage/token-usage-over-time?${RANGE}`,
    `/billing/usage/spending-by-conversation?${RANGE}`,
    `/billing/usage/balance-history?${RANGE}`,
    '/billing/usage/models',
    '/billing/transactions',
  ])('maps a store failure to 503 for %s', async (path) => {
    const res = await get(app(), path);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});

// Referenced to keep the eslint no-unused import guard satisfied where `and`/`eq`
// help future assertions; a lightweight sanity read of a seeded row.
describe('seed sanity', () => {
  it('stamped the conversation onto a seeded usage row', async () => {
    const rows = await db
      .select({ conversationId: usageRecords.conversationId })
      .from(usageRecords)
      .where(and(eq(usageRecords.userId, userId), eq(usageRecords.modelId, MODEL_B)));
    expect(rows[0]?.conversationId).toBe(convB);
  });
});
