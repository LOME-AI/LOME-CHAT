import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  allowanceSpending,
  createDb,
  jobs,
  ledgerEntries,
  payments,
  users,
  wallets,
} from '@hushbox/db';
import { signHmacSha256Webhook } from '@hushbox/crypto';
import { createApp } from './app.js';
import { runSettlement } from './lib/idempotency/index.js';
import { createBillingStores, PAYMENT_MINIMUM_NANO_USD } from './slices/billing/index.js';
import type { Database } from '@hushbox/db';
import type { Bindings } from './lib/context/index.js';
import type { TelemetryEnv } from './lib/telemetry/index.js';

// The composition-root proof for the chargeback fix: a signed chargeback webhook
// against the fully ASSEMBLED `createApp()` must claw back, lock the account, and
// enqueue `session.revoke.v1` — which only succeeds if `app.ts` registered that
// job type on the webhook's enqueue registry. Without it the enqueue throws
// "unregistered job type", the clawback transaction rolls back, and the webhook
// 503-loops Helcim; this test would then see a non-200 and no job row.

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for chargeback mount tests');
}

const SECRET = 'secret-at-least-32-characters-long!!';
const WEBHOOK_VERIFIER = 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=';
// API_URL + HELCIM_WEBHOOK_VERIFIER let the assembled app build its local payment
// mock (constructed inside the enqueue registry factory); the mock is never
// invoked here — payments are seeded directly and webhooks posted by hand.
const webhookEnv: Bindings & TelemetryEnv & { HELCIM_WEBHOOK_VERIFIER: string; API_URL: string } = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
  HELCIM_WEBHOOK_VERIFIER: WEBHOOK_VERIFIER,
  API_URL: 'http://localhost',
};

const db: Database = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([9, 9, 9]);
const createdUserIds: string[] = [];
const createdPaymentIds: string[] = [];

// A fire-and-forget waitUntil double so the route's post-commit bulk-dispatcher
// nudge runs without an eviction runtime.
const executionCtx: ExecutionContext = {
  waitUntil: () => {
    /* the nudge is lossy and not awaited in tests */
  },
  passThroughOnException: () => {
    /* no-op in tests */
  },
  props: {},
};

async function seedUser(): Promise<string> {
  const username = `cbk${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@chargeback-mount.test`,
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
  createdPaymentIds.push(payment.id);
  const transactionId = `txn-${crypto.randomUUID()}`;
  await runSettlement(db, (tx) =>
    stores.markPaymentChargedWithinTx(tx, payment.id, { helcimTransactionId: transactionId })
  );
  return { paymentId: payment.id, transactionId };
}

async function signedWebhook(payload: string): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const webhookId = `wh-${crypto.randomUUID()}`;
  const signature = await signHmacSha256Webhook({
    secret: WEBHOOK_VERIFIER,
    payload,
    timestamp,
    webhookId,
  });
  return createApp().request(
    '/billing/webhooks/payment',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'webhook-signature': signature,
        'webhook-timestamp': timestamp,
        'webhook-id': webhookId,
      },
      body: payload,
    },
    webhookEnv,
    executionCtx
  );
}

afterAll(async () => {
  for (const paymentId of createdPaymentIds) {
    await db
      .delete(jobs)
      .where(
        inArray(jobs.dedupeKey, [`chargeback-revoke:${paymentId}`, `payment.verify:${paymentId}`])
      );
    const legRows = await db
      .select({ transactionId: ledgerEntries.transactionId })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    const transactionIds = [...new Set(legRows.map((row) => row.transactionId))];
    if (transactionIds.length > 0) {
      await db.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, transactionIds));
    }
    await db.delete(payments).where(eq(payments.id, paymentId));
  }
  if (createdUserIds.length > 0) {
    await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
    await db.delete(allowanceSpending).where(inArray(allowanceSpending.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('createApp: a chargeback webhook claws back, locks, and enqueues the revoke job', () => {
  it('enqueues session.revoke.v1 and commits the clawback + lock', async () => {
    const userId = await seedUser();
    const { paymentId, transactionId } = await seedChargedPayment(userId);

    const captured = await signedWebhook(
      JSON.stringify({ type: 'cardTransaction', id: transactionId })
    );
    expect(captured.status).toBe(200);

    const dispute = await signedWebhook(JSON.stringify({ type: 'chargeback', id: transactionId }));
    // A 503 here is the exact "unregistered job type" failure the wiring fixes.
    expect(dispute.status).toBe(200);

    const lockedRows = await db
      .select({ lockedAt: users.lockedAt })
      .from(users)
      .where(eq(users.id, userId));
    expect(lockedRows[0]?.lockedAt).not.toBeNull();

    const revokeJobs = await db
      .select({ type: jobs.type })
      .from(jobs)
      .where(eq(jobs.dedupeKey, `chargeback-revoke:${paymentId}`));
    expect(revokeJobs).toHaveLength(1);
    expect(revokeJobs[0]?.type).toBe('session.revoke.v1');

    const legs = await db
      .select({ kind: ledgerEntries.kind })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    expect(legs.filter((leg) => leg.kind === 'clawback')).toHaveLength(2);
  });
});
