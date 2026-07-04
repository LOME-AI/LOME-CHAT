import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  ledgerEntries,
  payments,
  users,
  wallets,
} from '@hushbox/db';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { errAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { createBillingStores } from '../adapters/stores.js';
import { createMockPaymentProvider } from '../adapters/payment-mock.js';
import { PAYMENT_MINIMUM_NANO_USD, PAYMENT_VERIFY_JOB_TYPE, paymentReference } from './payments.js';
import {
  PAYMENT_VERIFY_MAX_FAILURES,
  createPaymentVerifyJobRegistration,
} from './payment-verify.js';
import type { JobExecution } from '../../../lib/jobs/index.js';
import type { MockPaymentProvider } from '../adapters/payment-mock.js';
import type { BillingStores, PaymentProvider } from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for payment verify integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([1, 2, 3]);
const WEBHOOK_VERIFIER = 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=';
const createdUserIds: string[] = [];
const createdPaymentIds: string[] = [];
let userCounter = 0;

function freshProvider(): MockPaymentProvider {
  return createMockPaymentProvider({
    webhookUrl: 'http://localhost:0/billing/webhooks/payment',
    webhookVerifier: WEBHOOK_VERIFIER,
    webhookDelayMs: 0,
    fetchImpl: () => Promise.resolve(new Response('ok')),
  });
}

async function createUser(): Promise<string> {
  userCounter += 1;
  const username = `blvfy${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(userCounter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@payment-verify.test`,
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

async function seedPayment(
  userId: string,
  status: 'pending' | 'awaiting_webhook',
  transactionId?: string
): Promise<string> {
  const { payment } = await runSettlement(db, (tx) =>
    stores.insertPaymentIfAbsentWithinTx(tx, {
      userId,
      amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
      idempotencyKey: `pay:${userId}:${crypto.randomUUID()}`,
    })
  );
  createdPaymentIds.push(payment.id);
  if (status === 'awaiting_webhook') {
    await runSettlement(db, (tx) =>
      stores.markPaymentChargedWithinTx(tx, payment.id, {
        helcimTransactionId: transactionId ?? `txn-${crypto.randomUUID()}`,
      })
    );
  }
  return payment.id;
}

function execution(paymentId: string): JobExecution<{ paymentId: string }> {
  return {
    jobId: crypto.randomUUID(),
    payload: { paymentId },
    claims: 1,
    heartbeat: () => Promise.resolve('alive' as const),
    completeWithinTx: () => {
      throw new Error('payment.verify.v1 is not a txn-class job');
    },
  };
}

function handlerWith(provider: PaymentProvider) {
  return createPaymentVerifyJobRegistration({ db, stores, provider }).handler;
}

/** An approved provider transaction the mock will confirm on getChargeStatus. */
async function approvedTransaction(provider: MockPaymentProvider): Promise<string> {
  const outcome = await provider.charge({
    idempotencyKey: crypto.randomUUID(),
    reference: crypto.randomUUID().replaceAll('-', ''),
    amount: PAYMENT_MINIMUM_NANO_USD as never,
    cardToken: 'tok',
    customerCode: 'cust',
    ipAddress: '203.0.113.7',
  });
  const charged = outcome._unsafeUnwrap();
  if (charged.status !== 'approved') throw new Error('mock charge should approve');
  await provider.flushWebhooks();
  return charged.transactionId;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    const paymentIds = [...createdPaymentIds];
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
    await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('payment.verify.v1 registration', () => {
  it('declares the delayed reconciler contract', () => {
    const provider = freshProvider();
    const registration = createPaymentVerifyJobRegistration({ db, stores, provider });
    expect(registration.type).toBe(PAYMENT_VERIFY_JOB_TYPE);
    expect(registration.idempotency).toBe('byEventId');
    expect(registration.maxFailures).toBe(PAYMENT_VERIFY_MAX_FAILURES);
  });
});

describe('payment.verify.v1 terminal handling', () => {
  it('dead-letters a payload whose pre-claim row does not exist', async () => {
    const provider = freshProvider();
    const outcome = await handlerWith(provider)(execution(crypto.randomUUID()));
    expect(outcome.kind).toBe('dead');
  });

  it('no-ops a payment the webhook already completed', async () => {
    const userId = await createUser();
    const paymentId = await seedPayment(userId, 'awaiting_webhook');
    await runSettlement(db, (tx) => stores.claimPaymentCompletedWithinTx(tx, { paymentId }));
    const provider = freshProvider();
    const outcome = await handlerWith(provider)(execution(paymentId));
    expect(outcome).toEqual({ kind: 'ok', result: 'already-final' });
    const legs = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    expect(legs).toHaveLength(0);
  });

  it('expires a pre-claim that never reached the provider', async () => {
    const userId = await createUser();
    const paymentId = await seedPayment(userId, 'pending');
    const provider = freshProvider();
    const outcome = await handlerWith(provider)(execution(paymentId));
    expect(outcome).toEqual({ kind: 'ok', result: 'expired' });
    const row = await stores.readPayment(db, paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('expired');
  });

  it('dead-letters a charged row whose transaction id is missing', async () => {
    const userId = await createUser();
    const paymentId = await seedPayment(userId, 'pending');
    // Force the impossible-in-practice state the defensive guard exists for:
    // a charged row without the transaction id that is always recorded with it.
    await db.update(payments).set({ status: 'awaiting_webhook' }).where(eq(payments.id, paymentId));
    const provider = freshProvider();
    const outcome = await handlerWith(provider)(execution(paymentId));
    expect(outcome.kind).toBe('dead');
  });
});

describe('payment.verify.v1 crash-after-charge reconciliation', () => {
  it('credits a lost-webhook payment exactly once across duplicate runs', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const transactionId = await approvedTransaction(provider);
    const paymentId = await seedPayment(userId, 'awaiting_webhook', transactionId);
    const handler = handlerWith(provider);
    const first = await handler(execution(paymentId));
    const second = await handler(execution(paymentId));
    expect(first).toEqual({ kind: 'ok', result: 'credited' });
    expect(second).toEqual({ kind: 'ok', result: 'already-final' });
    const legs = await db
      .select({ amountNanoUsd: ledgerEntries.amountNanoUsd })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    expect(legs).toHaveLength(2);
    const walletRows = await db
      .select({ balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.userId, userId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(PAYMENT_MINIMUM_NANO_USD);
  });

  it('credits exactly once under concurrent duplicate claims', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const transactionId = await approvedTransaction(provider);
    const paymentId = await seedPayment(userId, 'awaiting_webhook', transactionId);
    const handler = handlerWith(provider);
    const outcomes = await Promise.all([
      handler(execution(paymentId)),
      handler(execution(paymentId)),
    ]);
    const credited = outcomes.filter(
      (outcome) => outcome.kind === 'ok' && outcome.result === 'credited'
    );
    expect(credited).toHaveLength(1);
    const legs = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    expect(legs).toHaveLength(2);
  });

  it('completes without crediting when the user was hard-deleted', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const transactionId = await approvedTransaction(provider);
    const paymentId = await seedPayment(userId, 'awaiting_webhook', transactionId);
    await db.update(payments).set({ userId: null }).where(eq(payments.id, paymentId));
    const outcome = await handlerWith(provider)(execution(paymentId));
    expect(outcome).toEqual({ kind: 'ok', result: 'completed-without-wallet' });
    const legs = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    expect(legs).toHaveLength(0);
    const row = await stores.readPayment(db, paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('completed');
  });
});

describe('payment.verify.v1 orphaned-capture reconciliation', () => {
  it('reconciles a pending pre-claim whose capture the reference lookup finds', async () => {
    const userId = await createUser();
    const paymentId = await seedPayment(userId, 'pending');
    const provider = freshProvider();
    provider.setCaptureForReference(paymentReference(paymentId), {
      transactionId: `txn-${crypto.randomUUID()}`,
      status: 'approved',
    });
    const outcome = await handlerWith(provider)(execution(paymentId));
    expect(outcome).toEqual({ kind: 'ok', result: 'credited' });
    const row = await stores.readPayment(db, paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('completed');
    const walletRows = await db
      .select({ balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.userId, userId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(PAYMENT_MINIMUM_NANO_USD);
  });

  it('credits a reconciled orphaned capture exactly once across duplicate runs', async () => {
    const userId = await createUser();
    const paymentId = await seedPayment(userId, 'pending');
    const provider = freshProvider();
    provider.setCaptureForReference(paymentReference(paymentId), {
      transactionId: `txn-${crypto.randomUUID()}`,
      status: 'approved',
    });
    const handler = handlerWith(provider);
    const first = await handler(execution(paymentId));
    const second = await handler(execution(paymentId));
    expect(first).toEqual({ kind: 'ok', result: 'credited' });
    expect(second).toEqual({ kind: 'ok', result: 'already-final' });
    const legs = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    expect(legs).toHaveLength(2);
  });

  it('credits a reconciled orphaned capture exactly once under concurrent runs', async () => {
    const userId = await createUser();
    const paymentId = await seedPayment(userId, 'pending');
    const provider = freshProvider();
    provider.setCaptureForReference(paymentReference(paymentId), {
      transactionId: `txn-${crypto.randomUUID()}`,
      status: 'approved',
    });
    const handler = handlerWith(provider);
    const outcomes = await Promise.all([
      handler(execution(paymentId)),
      handler(execution(paymentId)),
    ]);
    const credited = outcomes.filter(
      (outcome) => outcome.kind === 'ok' && outcome.result === 'credited'
    );
    expect(credited).toHaveLength(1);
    const legs = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    expect(legs).toHaveLength(2);
  });

  it('fails a pending pre-claim whose reference capture the provider reports declined', async () => {
    const userId = await createUser();
    const paymentId = await seedPayment(userId, 'pending');
    const provider = freshProvider();
    provider.setCaptureForReference(paymentReference(paymentId), {
      transactionId: `txn-${crypto.randomUUID()}`,
      status: 'declined',
    });
    const outcome = await handlerWith(provider)(execution(paymentId));
    expect(outcome).toEqual({ kind: 'ok', result: 'failed' });
    const row = await stores.readPayment(db, paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('failed');
    const legs = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, paymentId));
    expect(legs).toHaveLength(0);
  });

  it('re-resolves a declined pre-claim that advanced out of pending mid-fail', async () => {
    const userId = await createUser();
    const paymentId = await seedPayment(userId, 'pending');
    const provider = freshProvider();
    provider.setCaptureForReference(paymentReference(paymentId), {
      transactionId: `txn-${crypto.randomUUID()}`,
      status: 'declined',
    });
    const racingStores: BillingStores = {
      ...stores,
      markPaymentFailedWithinTx: async (tx, id) => {
        // A concurrent transition advances the row first, so the guarded fail
        // matches 0 rows and the reconcile re-resolves the new terminal state.
        await stores.markPaymentExpiredWithinTx(tx, id);
        return false;
      },
    };
    const handler = createPaymentVerifyJobRegistration({
      db,
      stores: racingStores,
      provider,
    }).handler;
    const outcome = await handler(execution(paymentId));
    expect(outcome).toEqual({ kind: 'ok', result: 'already-final' });
  });

  it('retries when the reference lookup fails transiently', async () => {
    const userId = await createUser();
    const paymentId = await seedPayment(userId, 'pending');
    const provider = freshProvider();
    const downProvider: PaymentProvider = {
      ...provider,
      findCaptureByReference: () => errAsync(unavailableError('provider down')),
    };
    const outcome = await handlerWith(downProvider)(execution(paymentId));
    expect(outcome).toEqual({ kind: 'fail', error: 'unavailable' });
    const row = await stores.readPayment(db, paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('pending');
  });
});

describe('payment.verify.v1 provider resolution', () => {
  it('fails a payment the provider reports declined', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const transactionId = await approvedTransaction(provider);
    const paymentId = await seedPayment(userId, 'awaiting_webhook', transactionId);
    const decliningProvider: PaymentProvider = {
      ...provider,
      getChargeStatus: (id) =>
        provider
          .getChargeStatus(id)
          .map(() => ({ status: 'declined' as const, transactionId: id })),
    };
    const outcome = await handlerWith(decliningProvider)(execution(paymentId));
    expect(outcome).toEqual({ kind: 'ok', result: 'failed' });
    const row = await stores.readPayment(db, paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('failed');
  });

  it('does not report failed when a declined row completed mid-fail', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const transactionId = await approvedTransaction(provider);
    const paymentId = await seedPayment(userId, 'awaiting_webhook', transactionId);
    const decliningProvider: PaymentProvider = {
      ...provider,
      getChargeStatus: (id) =>
        provider
          .getChargeStatus(id)
          .map(() => ({ status: 'declined' as const, transactionId: id })),
    };
    const racingStores: BillingStores = {
      ...stores,
      markPaymentFailedWithinTx: async (tx, id) => {
        // A racing webhook completes the row before the decline fail lands, so
        // the guarded awaiting_webhook→failed update matches 0 rows.
        await stores.claimPaymentCompletedWithinTx(tx, { paymentId: id });
        return false;
      },
    };
    const handler = createPaymentVerifyJobRegistration({
      db,
      stores: racingStores,
      provider: decliningProvider,
    }).handler;
    const outcome = await handler(execution(paymentId));
    expect(outcome).toEqual({ kind: 'ok', result: 'already-final' });
    const row = await stores.readPayment(db, paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('completed');
  });

  it('dead-letters when the provider does not know the transaction', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const paymentId = await seedPayment(userId, 'awaiting_webhook', `txn-${crypto.randomUUID()}`);
    const outcome = await handlerWith(provider)(execution(paymentId));
    expect(outcome.kind).toBe('dead');
  });

  it('retries on a transient provider failure', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const transactionId = await approvedTransaction(provider);
    const paymentId = await seedPayment(userId, 'awaiting_webhook', transactionId);
    const downProvider: PaymentProvider = {
      ...provider,
      getChargeStatus: () => errAsync(unavailableError('provider down')),
    };
    const outcome = await handlerWith(downProvider)(execution(paymentId));
    expect(outcome).toEqual({ kind: 'fail', error: 'unavailable' });
    const row = await stores.readPayment(db, paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('awaiting_webhook');
  });
});

describe('payment.verify.v1 failure and race arms', () => {
  it('retries when the pre-claim row cannot be read', async () => {
    const provider = freshProvider();
    const failingStores = {
      ...stores,
      readPayment: () => errAsync(unavailableError('database down')),
    };
    const handler = createPaymentVerifyJobRegistration({
      db,
      stores: failingStores,
      provider,
    }).handler;
    const outcome = await handler(execution(crypto.randomUUID()));
    expect(outcome).toEqual({ kind: 'fail', error: 'unavailable' });
  });

  it('resolves a charge finalize that raced ahead of the expiry', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const transactionId = await approvedTransaction(provider);
    const paymentId = await seedPayment(userId, 'pending');
    const racingStores = {
      ...stores,
      markPaymentExpiredWithinTx: async (
        ...parameters: Parameters<typeof stores.markPaymentExpiredWithinTx>
      ) => {
        // The charge finalize lands between the status read and the expiry.
        const [tx, id] = parameters;
        await stores.markPaymentChargedWithinTx(tx, id, { helcimTransactionId: transactionId });
        return false;
      },
    };
    const handler = createPaymentVerifyJobRegistration({
      db,
      stores: racingStores,
      provider,
    }).handler;
    const outcome = await handler(execution(paymentId));
    expect(outcome).toEqual({ kind: 'ok', result: 'credited' });
    const row = await stores.readPayment(db, paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('completed');
  });
});
