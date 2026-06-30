/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- json() returns any, assertions provide documentation */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { webhooksRoute } from './webhooks.js';
import { billingRoute } from './billing.js';
import { createMockHelcimClient } from '../services/helcim/index.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

// Response types for type-safe JSON parsing
interface WebhookResponse {
  received: boolean;
}

interface CreatePaymentResponse {
  paymentId: string;
  amount: string;
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

function getAuthHeaders(userId: string): Record<string, string> {
  return { 'X-Test-User-Id': userId };
}

describe('webhooks routes', () => {
  const connectionString = DATABASE_URL;
  let db: ReturnType<typeof createDb>;
  let app: Hono<AppEnv>;
  let testUserId: string;
  let helcimClient: ReturnType<typeof createMockHelcimClient>;

  const TEST_SUFFIX = String(Date.now());
  const TEST_EMAIL = `test-webhook-${TEST_SUFFIX}@example.com`;
  const TEST_USERNAME = `twh_${TEST_SUFFIX}`;

  // Track created IDs for cleanup
  const createdPaymentIds: string[] = [];
  let testWalletId: string;

  beforeAll(async () => {
    db = createDb({ connectionString, neonDev: LOCAL_NEON_DEV_CONFIG });
    helcimClient = createMockHelcimClient({
      webhookUrl: 'http://localhost:8787/api/webhooks/payment',
      webhookVerifier: 'dGVzdC12ZXJpZmllcg==', // gitleaks:allow
    });

    // Create test user directly in database
    testUserId = crypto.randomUUID();
    await db.insert(users).values(
      userFactory.build({
        id: testUserId,
        email: TEST_EMAIL,
        username: TEST_USERNAME,
        emailVerified: true,
      })
    );

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

    // Create the app with billing and webhook routes
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
      // Set env bindings - DATABASE_URL required, HELCIM_WEBHOOK_VERIFIER empty to skip signature verification
      c.env = { DATABASE_URL: connectionString, HELCIM_WEBHOOK_VERIFIER: '', APP_VERSION: 'test' };
      // Conditionally set user/session based on X-Test-User-Id header
      const testUserIdHeader = c.req.header('X-Test-User-Id');
      if (testUserIdHeader) {
        c.set('user', {
          id: testUserIdHeader,
          email: TEST_EMAIL,
          username: TEST_USERNAME,
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: true,
          publicKey: new Uint8Array(32),
        });
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
        c.set('session', sessionData);
        c.set('sessionData', sessionData);
      }
      await next();
    });
    app.route('/billing', billingRoute);
    app.route('/webhooks', webhooksRoute);
  });

  afterAll(async () => {
    // Delete ledger entries FIRST — the check constraint requires exactly one source
    // (paymentId or usageRecordId), so setting paymentId to NULL on cascade would violate it.
    if (testWalletId) {
      await db.delete(ledgerEntries).where(eq(ledgerEntries.walletId, testWalletId));
    }

    if (createdPaymentIds.length > 0) {
      await db.delete(payments).where(inArray(payments.id, createdPaymentIds));
    }

    // Clean up wallet
    if (testWalletId) {
      await db.delete(wallets).where(eq(wallets.id, testWalletId));
    }

    // Clean up test user
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  describe('POST /webhooks/payment', () => {
    it('accepts valid webhook payload', async () => {
      const res = await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'refund',
          id: 'some-transaction-id',
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as WebhookResponse;
      expect(data.received).toBe(true);
    });

    it('returns 400 for invalid JSON', async () => {
      const res = await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(res.status).toBe(400);
    });

    it('credits balance when webhook matches awaiting_webhook payment', async () => {
      // Create payment
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '50.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      // Manually set payment to awaiting_webhook with a known transaction ID
      const transactionId = `test-txn-${String(Date.now())}`;
      await db
        .update(payments)
        .set({
          status: 'awaiting_webhook',
          helcimTransactionId: transactionId,
        })
        .where(eq(payments.id, createData.paymentId));

      // Get initial balance
      const balanceRes1 = await app.request('/billing/balance', {
        headers: getAuthHeaders(testUserId),
      });
      const initialBalance = Number.parseFloat(
        ((await balanceRes1.json()) as { balance: string }).balance
      );

      // Send webhook
      const webhookRes = await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cardTransaction',
          id: transactionId,
        }),
      });

      expect(webhookRes.status).toBe(200);

      const balanceRes2 = await app.request('/billing/balance', {
        headers: getAuthHeaders(testUserId),
      });
      const newBalance = Number.parseFloat(
        ((await balanceRes2.json()) as { balance: string }).balance
      );

      expect(newBalance).toBeCloseTo(initialBalance + 50, 2);

      // Check payment status is now completed
      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, createData.paymentId));

      expect(payment?.status).toBe('completed');
      expect(payment?.webhookReceivedAt).not.toBeNull();
    });

    it('is idempotent - does not double-credit', async () => {
      // Create payment
      const createRes = await app.request('/billing/payments', {
        method: 'POST',
        headers: {
          ...getAuthHeaders(testUserId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: '25.00000000' }),
      });

      const createData = (await createRes.json()) as CreatePaymentResponse;
      createdPaymentIds.push(createData.paymentId);

      // Manually set payment to awaiting_webhook with a known transaction ID
      const transactionId = `test-txn-idempotent-${String(Date.now())}`;
      await db
        .update(payments)
        .set({
          status: 'awaiting_webhook',
          helcimTransactionId: transactionId,
        })
        .where(eq(payments.id, createData.paymentId));

      // Get initial balance
      const balanceRes1 = await app.request('/billing/balance', {
        headers: getAuthHeaders(testUserId),
      });
      const initialBalance = Number.parseFloat(
        ((await balanceRes1.json()) as { balance: string }).balance
      );

      // Send webhook TWICE
      await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cardTransaction',
          id: transactionId,
        }),
      });

      await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cardTransaction',
          id: transactionId,
        }),
      });

      // Check balance was only credited once
      const balanceRes2 = await app.request('/billing/balance', {
        headers: getAuthHeaders(testUserId),
      });
      const newBalance = Number.parseFloat(
        ((await balanceRes2.json()) as { balance: string }).balance
      );

      // Should be exactly +25, not +50
      expect(newBalance).toBeCloseTo(initialBalance + 25, 2);
    });

    it('ignores non-cardTransaction event types', async () => {
      // Create payment in awaiting_webhook state
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

      const transactionId = `test-txn-ignore-${String(Date.now())}`;
      await db
        .update(payments)
        .set({
          status: 'awaiting_webhook',
          helcimTransactionId: transactionId,
        })
        .where(eq(payments.id, createData.paymentId));

      // Get initial balance
      const balanceRes1 = await app.request('/billing/balance', {
        headers: getAuthHeaders(testUserId),
      });
      const initialBalance = Number.parseFloat(
        ((await balanceRes1.json()) as { balance: string }).balance
      );

      // Send webhook with different event type
      const webhookRes = await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'refund', // Different event type
          id: transactionId,
        }),
      });

      expect(webhookRes.status).toBe(200);

      const balanceRes2 = await app.request('/billing/balance', {
        headers: getAuthHeaders(testUserId),
      });
      const newBalance = Number.parseFloat(
        ((await balanceRes2.json()) as { balance: string }).balance
      );

      expect(newBalance).toBeCloseTo(initialBalance, 2);
    });

    it('returns 500 for truly unknown transaction IDs after retries', async () => {
      // Current implementation returns 200 immediately
      // After implementing retry logic, this test should pass
      const res = await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cardTransaction',
          id: 'completely-unknown-never-exists',
        }),
      });

      // Expects 500 after retries exhausted (new behavior)
      expect(res.status).toBe(500);
      const data = (await res.json()) as { code: string };
      expect(data.code).toBe('PAYMENT_NOT_FOUND');
    }, 60_000); // 60 second timeout for retries

    it('returns 200 immediately for already-completed payments (duplicate webhook)', async () => {
      // Create payment
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

      // Set payment to completed (simulating already-processed webhook)
      const transactionId = `test-txn-duplicate-${String(Date.now())}`;
      await db
        .update(payments)
        .set({
          status: 'completed',
          helcimTransactionId: transactionId,
        })
        .where(eq(payments.id, createData.paymentId));

      // Get balance before duplicate webhook
      const balanceRes1 = await app.request('/billing/balance', {
        headers: getAuthHeaders(testUserId),
      });
      const balanceBefore = Number.parseFloat(
        ((await balanceRes1.json()) as { balance: string }).balance
      );

      // Send duplicate webhook for already-completed payment
      const webhookRes = await app.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cardTransaction',
          id: transactionId,
        }),
      });

      // Should return 200 immediately (no retry needed for duplicates)
      expect(webhookRes.status).toBe(200);
      const data = (await webhookRes.json()) as WebhookResponse;
      expect(data.received).toBe(true);

      // Balance should NOT change
      const balanceRes2 = await app.request('/billing/balance', {
        headers: getAuthHeaders(testUserId),
      });
      const balanceAfter = Number.parseFloat(
        ((await balanceRes2.json()) as { balance: string }).balance
      );
      expect(balanceAfter).toBeCloseTo(balanceBefore, 2);
    });

    it('returns 500 in production when HELCIM_WEBHOOK_VERIFIER is not configured', async () => {
      // Create a separate app with production settings
      const productionApp = new Hono<AppEnv>();
      productionApp.use('*', async (c, next) => {
        c.set('db', db);
        // Production env with missing webhook verifier
        c.env = {
          DATABASE_URL: connectionString,
          NODE_ENV: 'production',
          HELCIM_WEBHOOK_VERIFIER: '',
          APP_VERSION: 'test',
        };
        await next();
      });
      productionApp.route('/webhooks', webhooksRoute);

      const res = await productionApp.request('/webhooks/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cardTransaction',
          id: 'test-transaction',
        }),
      });

      expect(res.status).toBe(500);
      const data = (await res.json()) as { code: string };
      expect(data.code).toBe('WEBHOOK_VERIFIER_MISSING');
    });
  });
});
