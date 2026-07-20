/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- json() returns any, assertions provide documentation */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  payments,
  wallets,
  ledgerEntries,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { billingRoute } from './billing.js';
import { createMockHelcimClient } from '../services/helcim/index.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

interface ErrorResponse {
  code: string;
}

interface BalanceResponse {
  balance: string;
  freeAllowanceCents: number;
}

interface CreatePaymentResponse {
  paymentId: string;
  amount: string;
}

interface ProcessPaymentConfirmedResponse {
  status: 'completed';
  newBalance: string;
  helcimTransactionId?: string;
}

interface ProcessPaymentProcessingResponse {
  status: 'processing';
  helcimTransactionId: string;
}

type ProcessPaymentResponse = ProcessPaymentConfirmedResponse | ProcessPaymentProcessingResponse;

interface PaymentStatusResponse {
  status: 'pending' | 'awaiting_webhook' | 'completed' | 'failed';
  newBalance?: string;
  errorMessage?: string | null;
}

interface Transaction {
  id: string;
  amount: string;
  balanceAfter: string;
  type: string;
  paymentId?: string | null;
  model?: string | null;
  inputCharacters?: number | null;
  outputCharacters?: number | null;
  deductionSource?: 'balance' | 'freeAllowance' | null;
  createdAt: string;
}

interface TransactionsResponse {
  transactions: Transaction[];
  nextCursor?: string | null;
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

function getAuthHeaders(userId: string): Record<string, string> {
  return { 'X-Test-User-Id': userId };
}

describe('billing routes', () => {
  const connectionString = DATABASE_URL;
  let db: ReturnType<typeof createDb>;
  let app: Hono<AppEnv>;
  let testUserId: string;
  let helcimClient: ReturnType<typeof createMockHelcimClient>;

  const testSuffix = String(Date.now()).slice(-8);
  const TEST_EMAIL = `test-billing-${testSuffix}@example.com`;
  const TEST_USERNAME = `tb_${testSuffix}`;

  const createdPaymentIds: string[] = [];
  const createdLedgerEntryIds: string[] = [];
  let testWalletId: string;

  beforeAll(async () => {
    db = createDb({ connectionString, neonDev: LOCAL_NEON_DEV_CONFIG });
    helcimClient = createMockHelcimClient({
      webhookUrl: 'http://localhost:8787/api/webhooks/payment',
      webhookVerifier: 'dGVzdC12ZXJpZmllcg==', // gitleaks:allow
    });

    const userData = userFactory.build({
      email: TEST_EMAIL,
      username: TEST_USERNAME,
      emailVerified: true,
    });
    const [createdUser] = await db.insert(users).values(userData).returning();
    if (!createdUser) throw new Error('Failed to create test user');
    testUserId = createdUser.id;

    // Create a purchased wallet for the test user (wallet-based balance system)
    const [createdWallet] = await db
      .insert(wallets)
      .values({
        userId: testUserId,
        type: 'purchased',
        balance: '0.00000000',
        priority: 0,
      })
      .returning();
    if (!createdWallet) throw new Error('Failed to create test wallet');
    testWalletId = createdWallet.id;

    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('helcim', helcimClient);
      c.set('envUtils', {
        isCI: false,
        isE2E: false,
        isLocalDev: false,
        isDevServer: false,
        isDev: false,
        isProduction: false,
        requiresRealServices: false,
      });
      const testUserIdHeader = c.req.header('X-Test-User-Id');
      if (testUserIdHeader) {
        const sessionData: SessionData = {
          sessionId: `test-session-${testUserIdHeader}`,
          userId: testUserIdHeader,
          email: TEST_EMAIL,
          username: TEST_USERNAME,
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        };
        c.set('user', {
          id: testUserIdHeader,
          email: TEST_EMAIL,
          username: TEST_USERNAME,
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          publicKey: new Uint8Array(32),
        });
        c.set('session', sessionData);
        c.set('sessionData', sessionData);
      }
      await next();
    });
    app.route('/billing', billingRoute);
  });

  afterAll(async () => {
    // Clean up created records (ledger entries cascade from wallets, but clean explicitly first)
    if (createdLedgerEntryIds.length > 0) {
      await db.delete(ledgerEntries).where(inArray(ledgerEntries.id, createdLedgerEntryIds));
    }
    if (createdPaymentIds.length > 0) {
      await db.delete(payments).where(inArray(payments.id, createdPaymentIds));
    }

    // Clean up wallet (ledger entries cascade)
    if (testWalletId) {
      await db.delete(wallets).where(eq(wallets.id, testWalletId));
    }

    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  describe('GET /billing/balance', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/billing/balance');

      expect(res.status).toBe(401);
    });

    it('returns user balance and free allowance', async () => {
      const res = await app.request('/billing/balance', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as BalanceResponse;
      expect(data.balance).toBeDefined();
      expect(typeof data.balance).toBe('string');
      expect(typeof data.freeAllowanceCents).toBe('number');
      expect(data.freeAllowanceCents).toBeGreaterThanOrEqual(0);
    });

    it('returns balance as numeric string with decimal precision', async () => {
      const res = await app.request('/billing/balance', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as BalanceResponse;
      expect(Number.parseFloat(data.balance)).toBeGreaterThanOrEqual(0);
      expect(data.balance).toMatch(/^\d+(\.\d+)?$/);
    });
  });

  describe('POST /billing/payments', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/billing/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: '10.00000000' }),
      });

      expect(res.status).toBe(401);
    });

    it('creates a payment record', async () => {
      const res = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '10.00000000' }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as CreatePaymentResponse;
      expect(data.paymentId).toBeDefined();
      expect(data.amount).toBe('10.00000000');
      createdPaymentIds.push(data.paymentId);
    });

    it('validates amount is required', async () => {
      const res = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns existing payment when same idempotencyKey is used', async () => {
      const idempotencyKey = crypto.randomUUID();

      const res1 = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '10.00000000', idempotencyKey }),
      });
      expect(res1.status).toBe(201);
      const data1 = (await res1.json()) as CreatePaymentResponse;
      createdPaymentIds.push(data1.paymentId);

      const res2 = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '10.00000000', idempotencyKey }),
      });
      expect(res2.status).toBe(201);
      const data2 = (await res2.json()) as CreatePaymentResponse;

      expect(data2.paymentId).toBe(data1.paymentId);
      expect(data2.amount).toBe(data1.amount);
    });
  });

  describe('POST /billing/payments/:id/process', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/billing/payments/test-id/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardToken: 'test-token' }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 404 for non-existent payment', async () => {
      const res = await app.request('/billing/payments/non-existent-id/process', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      expect(res.status).toBe(404);
    });

    it('processes payment successfully with mock client', async () => {
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '25.00000000' }),
      });

      expect(createRes.status).toBe(201);
      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      const processRes = await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token-123', customerCode: 'CST1234' }),
      });

      expect(processRes.status).toBe(200);
      const processData = (await processRes.json()) as ProcessPaymentResponse;

      // Mock client goes through webhook flow like real client, so returns processing
      expect(processData.status).toBe('processing');
    });

    it('rejects payment with declined card', async () => {
      helcimClient.setNextResponse({
        status: 'declined',
        errorMessage: 'Card declined',
      });

      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '10.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      const processRes = await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token-456', customerCode: 'CST1234' }),
      });

      expect(processRes.status).toBe(400);
      const errorData = (await processRes.json()) as ErrorResponse;
      expect(errorData.code).toBe('PAYMENT_DECLINED');

      helcimClient.setNextResponse({
        status: 'approved',
        transactionId: 'mock-txn',
        cardType: 'Visa',
        cardLastFour: '9990',
      });
    });

    it('passes client IP from cf-connecting-ip header to Helcim', async () => {
      helcimClient.clearProcessedPayments();

      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '5.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
          'cf-connecting-ip': '203.0.113.42',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      const processedPayments = helcimClient.getProcessedPayments();
      expect(processedPayments.length).toBeGreaterThan(0);
      expect(processedPayments.at(-1)?.ipAddress).toBe('203.0.113.42');
    });

    it('passes client IP from x-forwarded-for header when cf-connecting-ip is absent', async () => {
      helcimClient.clearProcessedPayments();

      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '5.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
          'x-forwarded-for': '198.51.100.178, 70.41.3.18',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      const processedPayments = helcimClient.getProcessedPayments();
      expect(processedPayments.length).toBeGreaterThan(0);
      expect(processedPayments.at(-1)?.ipAddress).toBe('198.51.100.178');
    });

    it('uses fallback IP when no IP headers present', async () => {
      helcimClient.clearProcessedPayments();

      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '5.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      const processedPayments = helcimClient.getProcessedPayments();
      expect(processedPayments.length).toBeGreaterThan(0);
      expect(processedPayments.at(-1)?.ipAddress).toBe('0.0.0.0');
    });

    it('rejects processing already processed payment', async () => {
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '5.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      const secondProcessRes = await app.request(
        `/billing/payments/${createData.paymentId}/process`,
        {
          method: 'POST',
          headers: {
            ...getAuthHeaders(testUserId),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
        }
      );

      expect(secondProcessRes.status).toBe(400);
      const errorData = (await secondProcessRes.json()) as ErrorResponse;
      expect(errorData.code).toBe('PAYMENT_ALREADY_PROCESSED');
    });

    it('does not overwrite completed payment with failed status', async () => {
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '10.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      // Simulate webhook completed the payment before decline response
      await db
        .update(payments)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(payments.id, createData.paymentId));

      helcimClient.setNextResponse({
        status: 'declined',
        errorMessage: 'Card declined',
      });

      const processRes = await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      expect(processRes.status).toBe(400);

      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, createData.paymentId));
      expect(payment?.status).toBe('completed');

      helcimClient.setNextResponse({
        status: 'approved',
        transactionId: 'mock-txn',
        cardType: 'Visa',
        cardLastFour: '9990',
      });
    });

    it('does not overwrite completed payment with expired status', async () => {
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '10.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      // Simulate: payment was completed by webhook AND has old createdAt
      const expiredTime = new Date(Date.now() - 31 * 60 * 1000); // 31 minutes ago
      await db
        .update(payments)
        .set({
          status: 'completed',
          createdAt: expiredTime,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, createData.paymentId));

      const processRes = await app.request(`/billing/payments/${createData.paymentId}/process`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardToken: 'test-token', customerCode: 'CST1234' }),
      });

      expect(processRes.status).toBe(400);

      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, createData.paymentId));
      expect(payment?.status).toBe('completed');
    });
  });

  describe('GET /billing/payments/:id', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/billing/payments/test-id');

      expect(res.status).toBe(401);
    });

    it('returns 404 for non-existent payment', async () => {
      const res = await app.request('/billing/payments/non-existent-id', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(404);
    });

    it('returns payment status', async () => {
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '15.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      const statusRes = await app.request(`/billing/payments/${createData.paymentId}`, {
        headers: getAuthHeaders(testUserId),
      });

      expect(statusRes.status).toBe(200);
      const statusData = (await statusRes.json()) as PaymentStatusResponse;
      expect(statusData.status).toBe('pending');
    });
  });

  describe('GET /billing/transactions', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/billing/transactions');

      expect(res.status).toBe(401);
    });

    it('returns transaction history', async () => {
      const res = await app.request('/billing/transactions', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;
      expect(Array.isArray(data.transactions)).toBe(true);
    });

    it('respects limit parameter', async () => {
      const res = await app.request('/billing/transactions?limit=5', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;
      expect(data.transactions.length).toBeLessThanOrEqual(5);
    });

    it('filters by type=deposit to return only deposits', async () => {
      const [depositEntry] = await db
        .insert(ledgerEntries)
        .values({
          walletId: testWalletId,
          amount: '10.00000000',
          balanceAfter: '20.00000000',
          entryType: 'deposit',
          sourceWalletId: testWalletId,
        })
        .returning();
      if (depositEntry) {
        createdLedgerEntryIds.push(depositEntry.id);
      }

      const [usageEntry] = await db
        .insert(ledgerEntries)
        .values({
          walletId: testWalletId,
          amount: '-0.50000000',
          balanceAfter: '9.50000000',
          entryType: 'usage_charge',
          sourceWalletId: testWalletId,
        })
        .returning();
      if (usageEntry) {
        createdLedgerEntryIds.push(usageEntry.id);
      }

      const res = await app.request('/billing/transactions?type=deposit', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;

      expect(data.transactions.length).toBeGreaterThan(0);
      for (const tx of data.transactions) {
        expect(tx.type).toBe('deposit');
      }
    });

    it('filters by type=usage_charge to return only usage transactions', async () => {
      const [usageEntry] = await db
        .insert(ledgerEntries)
        .values({
          walletId: testWalletId,
          amount: '-0.25000000',
          balanceAfter: '9.25000000',
          entryType: 'usage_charge',
          sourceWalletId: testWalletId,
        })
        .returning();
      if (usageEntry) {
        createdLedgerEntryIds.push(usageEntry.id);
      }

      const res = await app.request('/billing/transactions?type=usage_charge', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;

      expect(data.transactions.length).toBeGreaterThan(0);
      for (const tx of data.transactions) {
        expect(tx.type).toBe('usage_charge');
      }
    });

    it('returns all transaction types when no type filter is provided', async () => {
      const res = await app.request('/billing/transactions', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as TransactionsResponse;

      const types = new Set(data.transactions.map((tx) => tx.type));
      expect(types.size).toBeGreaterThanOrEqual(1);
    });

    it('supports offset-based pagination with type filter', async () => {
      const firstPageRes = await app.request(
        '/billing/transactions?type=deposit&limit=2&offset=0',
        {
          headers: getAuthHeaders(testUserId),
        }
      );

      expect(firstPageRes.status).toBe(200);
      const firstPage = (await firstPageRes.json()) as TransactionsResponse;

      const secondPageRes = await app.request(
        '/billing/transactions?type=deposit&limit=2&offset=2',
        {
          headers: getAuthHeaders(testUserId),
        }
      );

      expect(secondPageRes.status).toBe(200);
      const secondPage = (await secondPageRes.json()) as TransactionsResponse;

      if (firstPage.transactions.length > 0 && secondPage.transactions.length > 0) {
        const firstIds = firstPage.transactions.map((tx) => tx.id);
        const secondIds = new Set(secondPage.transactions.map((tx) => tx.id));
        const overlap = firstIds.filter((id) => secondIds.has(id));
        expect(overlap.length).toBe(0);
      }
    });
  });
});

interface LoginLinkResponse {
  token: string;
}

function createMapRedis(): {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  store: Map<string, unknown>;
} {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
  };
}

function createLoginLinkTestApp(options?: {
  user?: AppEnv['Variables']['user'] | null;
  redis?: unknown;
}): { app: Hono<AppEnv>; redis: ReturnType<typeof createMapRedis> } {
  const redis = options?.redis
    ? (options.redis as ReturnType<typeof createMapRedis>)
    : createMapRedis();
  const user =
    options?.user === undefined
      ? {
          id: 'user-login-link',
          email: 'login-link@example.com',
          username: 'login_link_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: true,
          publicKey: new Uint8Array(32),
        }
      : options.user;

  const testApp = new Hono<AppEnv>();

  testApp.use('*', async (c, next) => {
    c.set('redis', redis as unknown as AppEnv['Variables']['redis']);
    if (user) {
      c.set('user', user);
      const sessionData: SessionData = {
        sessionId: `test-session-${user.id}`,
        userId: user.id,
        email: user.email,
        username: user.username,
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: true,
        pending2FA: false,
        pending2FAExpiresAt: 0,
        createdAt: Date.now(),
      };
      c.set('session', sessionData);
      c.set('sessionData', sessionData);
    }
    await next();
  });

  testApp.route('/billing', billingRoute);
  return { app: testApp, redis };
}

describe('POST /billing/login-link', () => {
  it('returns 401 when not authenticated', async () => {
    const { app: testApp } = createLoginLinkTestApp({ user: null });

    const res = await testApp.request('/billing/login-link', { method: 'POST' });

    expect(res.status).toBe(401);
  });

  it('returns a token string on success', async () => {
    const { app: testApp } = createLoginLinkTestApp();

    const res = await testApp.request('/billing/login-link', { method: 'POST' });

    expect(res.status).toBe(200);
    const data = (await res.json()) as LoginLinkResponse;
    expect(typeof data.token).toBe('string');
    expect(data.token.length).toBeGreaterThan(0);
  });

  it('stores userId in Redis under the token key', async () => {
    const { app: testApp, redis } = createLoginLinkTestApp();

    const res = await testApp.request('/billing/login-link', { method: 'POST' });
    const data = (await res.json()) as LoginLinkResponse;

    // redisSet uses the billingLoginToken buildKey: `billing:login-token:${token}`
    const expectedKey = `billing:login-token:${data.token}`;
    expect(redis.set).toHaveBeenCalledWith(expectedKey, { userId: 'user-login-link' }, { ex: 60 });
  });

  it('generates unique tokens on repeated calls', async () => {
    const { app: testApp } = createLoginLinkTestApp();

    const res1 = await testApp.request('/billing/login-link', { method: 'POST' });
    const data1 = (await res1.json()) as LoginLinkResponse;

    const res2 = await testApp.request('/billing/login-link', { method: 'POST' });
    const data2 = (await res2.json()) as LoginLinkResponse;

    expect(data1.token).not.toBe(data2.token);
  });
});
