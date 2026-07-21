import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  jobs,
  ledgerEntries,
  payments,
  users,
  wallets,
} from '@hushbox/db';
import { createJobRegistry } from '../../../lib/jobs/index.js';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { okAsync } from '../../../lib/result/index.js';
import { createBillingStores } from '../adapters/stores.js';
import { createMockPaymentProvider } from '../adapters/payment-mock.js';
import {
  PAYMENT_MINIMUM_NANO_USD,
  PAYMENT_VERIFY_DELAY_SECONDS,
  PAYMENT_VERIFY_JOB_TYPE,
  cardPaymentOutcomeOf,
  creditPaymentWithinTx,
  enqueuePaymentVerifyWithinTx,
  initiateCardPayment,
  billingPrincipalUserId,
  paymentReference,
} from './payments.js';
import { createPaymentVerifyJobRegistration } from './payment-verify.js';
import type { MockPaymentProvider } from '../adapters/payment-mock.js';
import type { InitiateCardPaymentDeps } from './payments.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for billing payment integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([1, 2, 3]);
const WEBHOOK_VERIFIER = 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=';
const createdUserIds: string[] = [];
let userCounter = 0;

function freshProvider(): MockPaymentProvider {
  return createMockPaymentProvider({
    webhookUrl: 'http://localhost:0/billing/webhooks/payment',
    webhookVerifier: WEBHOOK_VERIFIER,
    webhookDelayMs: 0,
    fetchImpl: () => Promise.resolve(new Response('ok')),
  });
}

function freshDeps(provider: MockPaymentProvider): InitiateCardPaymentDeps {
  const registry = createJobRegistry();
  registry.register(createPaymentVerifyJobRegistration({ db, stores, provider }));
  return { db, stores, provider, registry };
}

async function createUser(): Promise<string> {
  userCounter += 1;
  const username = `blpay${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(userCounter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@billing-payments.test`,
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

function chargeArgs(
  userId: string,
  overrides: Partial<Parameters<typeof initiateCardPayment>[1]> = {}
) {
  return {
    userId,
    amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
    cardToken: 'tok-1',
    customerCode: 'cust-1',
    ipAddress: '203.0.113.7',
    idempotencyKey: crypto.randomUUID(),
    now: new Date(),
    ...overrides,
  };
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
    await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('initiateCardPayment happy path', () => {
  it('pre-claims, charges with the payment id as the provider key, and awaits the webhook', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const result = await initiateCardPayment(deps, chargeArgs(userId));
    const outcome = result._unsafeUnwrap();
    expect(outcome.status).toBe('awaiting_webhook');
    expect(outcome.amountNanoUsd).toBe(PAYMENT_MINIMUM_NANO_USD);
    const requests = provider.getChargeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.idempotencyKey).toBe(outcome.paymentId);
    const row = await stores.readPayment(db, outcome.paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('awaiting_webhook');
    expect(row._unsafeUnwrap()?.helcimTransactionId).not.toBeNull();
    await provider.flushWebhooks();
  });

  it('charges with the payment id rendered as the merchant reference', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const result = await initiateCardPayment(deps, chargeArgs(userId));
    const outcome = result._unsafeUnwrap();
    const requests = provider.getChargeRequests();
    expect(requests[0]?.reference).toBe(paymentReference(outcome.paymentId));
    await provider.flushWebhooks();
  });

  it('enqueues the delayed verify job in the pre-claim transaction', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const now = new Date();
    const result = await initiateCardPayment(deps, chargeArgs(userId, { now }));
    const outcome = result._unsafeUnwrap();
    const jobRows = await db
      .select({
        type: jobs.type,
        status: jobs.status,
        nextAttemptAt: jobs.nextAttemptAt,
        payload: jobs.payload,
      })
      .from(jobs)
      .where(eq(jobs.dedupeKey, `payment.verify:${outcome.paymentId}`));
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]?.type).toBe(PAYMENT_VERIFY_JOB_TYPE);
    expect(jobRows[0]?.status).toBe('pending');
    expect(jobRows[0]?.payload).toEqual({ paymentId: outcome.paymentId });
    const expectedAt = now.getTime() + PAYMENT_VERIFY_DELAY_SECONDS * 1000;
    expect(Math.abs((jobRows[0]?.nextAttemptAt.getTime() ?? 0) - expectedAt)).toBeLessThan(2000);
    await provider.flushWebhooks();
  });
});

describe('initiateCardPayment validation', () => {
  it('rejects an amount below the five dollar minimum', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const result = await initiateCardPayment(
      deps,
      chargeArgs(userId, { amountNanoUsd: PAYMENT_MINIMUM_NANO_USD - 10_000_000n })
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(provider.getChargeRequests()).toHaveLength(0);
  });

  it('rejects an amount that is not whole cents', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const result = await initiateCardPayment(
      deps,
      chargeArgs(userId, { amountNanoUsd: PAYMENT_MINIMUM_NANO_USD + 1n })
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(provider.getChargeRequests()).toHaveLength(0);
  });
});

describe('initiateCardPayment decline', () => {
  it('records the decline on the pre-claim and reports failed', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    provider.setNextChargeOutcome({ status: 'declined', declineReason: 'insufficient funds' });
    const result = await initiateCardPayment(deps, chargeArgs(userId));
    const outcome = result._unsafeUnwrap();
    expect(outcome.status).toBe('failed');
    const row = await stores.readPayment(db, outcome.paymentId);
    expect(row._unsafeUnwrap()?.status).toBe('failed');
    expect(row._unsafeUnwrap()?.errorCode).toBe('card_declined');
  });
});

describe('initiateCardPayment idempotency', () => {
  it('replays a finished payment without charging again', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const key = crypto.randomUUID();
    const first = await initiateCardPayment(deps, chargeArgs(userId, { idempotencyKey: key }));
    const second = await initiateCardPayment(deps, chargeArgs(userId, { idempotencyKey: key }));
    expect(second._unsafeUnwrap().paymentId).toBe(first._unsafeUnwrap().paymentId);
    expect(second._unsafeUnwrap().status).toBe('awaiting_webhook');
    expect(provider.getChargeRequests()).toHaveLength(1);
    await provider.flushWebhooks();
  });

  it('rejects the same key with a different amount', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const key = crypto.randomUUID();
    const first = await initiateCardPayment(deps, chargeArgs(userId, { idempotencyKey: key }));
    expect(first.isOk()).toBe(true);
    const mismatch = await initiateCardPayment(
      deps,
      chargeArgs(userId, { idempotencyKey: key, amountNanoUsd: PAYMENT_MINIMUM_NANO_USD * 2n })
    );
    expect(mismatch._unsafeUnwrapErr().code).toBe('conflict');
    await provider.flushWebhooks();
  });

  it('scopes the same client key to each user', async () => {
    const userA = await createUser();
    const userB = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const key = crypto.randomUUID();
    const first = await initiateCardPayment(deps, chargeArgs(userA, { idempotencyKey: key }));
    const second = await initiateCardPayment(deps, chargeArgs(userB, { idempotencyKey: key }));
    expect(first._unsafeUnwrap().paymentId).not.toBe(second._unsafeUnwrap().paymentId);
    await provider.flushWebhooks();
  });

  it('retries a crash between charge and finalize with the same provider key', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    let failFinalize = true;
    const crashingStores = {
      ...stores,
      markPaymentChargedWithinTx: async (
        ...parameters: Parameters<typeof stores.markPaymentChargedWithinTx>
      ) => {
        if (failFinalize) {
          failFinalize = false;
          throw new Error('process died before finalize');
        }
        return stores.markPaymentChargedWithinTx(...parameters);
      },
    };
    const key = crypto.randomUUID();
    const crashed = await initiateCardPayment(
      { ...deps, stores: crashingStores },
      chargeArgs(userId, { idempotencyKey: key })
    );
    expect(crashed._unsafeUnwrapErr().code).toBe('unavailable');
    const pendingRow = await db
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.idempotencyKey, `pay:${userId}:${key}`));
    expect(pendingRow[0]?.status).toBe('pending');
    const retried = await initiateCardPayment(
      { ...deps, stores: crashingStores },
      chargeArgs(userId, { idempotencyKey: key })
    );
    expect(retried._unsafeUnwrap().status).toBe('awaiting_webhook');
    const requests = provider.getChargeRequests();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.idempotencyKey).toBe(requests[1]?.idempotencyKey);
    await provider.flushWebhooks();
  });
});

describe('cardPaymentOutcomeOf', () => {
  it('treats a pending record as a defect', async () => {
    const userId = await createUser();
    const key = `pay:${userId}:${crypto.randomUUID()}`;
    const { payment } = await runSettlement(db, (tx) =>
      stores.insertPaymentIfAbsentWithinTx(tx, {
        userId,
        amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
        idempotencyKey: key,
      })
    );
    expect(() => cardPaymentOutcomeOf(payment)).toThrow(/pending/);
  });
});

describe('creditPaymentWithinTx', () => {
  it('credits the purchased wallet with a zero-sum deposit pair', async () => {
    const userId = await createUser();
    const key = `pay:${userId}:${crypto.randomUUID()}`;
    const { payment } = await runSettlement(db, (tx) =>
      stores.insertPaymentIfAbsentWithinTx(tx, {
        userId,
        amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
        idempotencyKey: key,
      })
    );
    await runSettlement(db, (tx) =>
      creditPaymentWithinTx(stores, tx, {
        paymentId: payment.id,
        userId,
        amountNanoUsd: payment.amountNanoUsd,
      })
    );
    const legs = await db
      .select({ amountNanoUsd: ledgerEntries.amountNanoUsd, kind: ledgerEntries.kind })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.paymentId, payment.id));
    expect(legs).toHaveLength(2);
    expect(legs.every((leg) => leg.kind === 'deposit')).toBe(true);
    expect(legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
    const walletRows = await db
      .select({ balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.userId, userId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(PAYMENT_MINIMUM_NANO_USD);
  });
});

describe('enqueuePaymentVerifyWithinTx', () => {
  it('dedupes a second enqueue for the same payment', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const key = `pay:${userId}:${crypto.randomUUID()}`;
    const { payment } = await runSettlement(db, (tx) =>
      stores.insertPaymentIfAbsentWithinTx(tx, {
        userId,
        amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
        idempotencyKey: key,
      })
    );
    const now = new Date();
    const first = await runSettlement(db, (tx) =>
      enqueuePaymentVerifyWithinTx(tx, deps.registry, { paymentId: payment.id, now })
    );
    const second = await runSettlement(db, (tx) =>
      enqueuePaymentVerifyWithinTx(tx, deps.registry, { paymentId: payment.id, now })
    );
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
  });
});

describe('billingPrincipalUserId', () => {
  it('accepts a billing-only session', () => {
    const principal = {
      kind: 'billing-only' as const,
      claims: {
        userId: 'user-1',
        sessionId: 's',
        createdAt: 0,
        pending2FA: false,
        pending2FAExpiresAt: 0,
      },
    };
    expect(billingPrincipalUserId(principal)).toBe('user-1');
  });

  it('treats a sessionless principal as a composition defect', () => {
    expect(() => billingPrincipalUserId({ kind: 'none' })).toThrow(/without a session principal/);
  });
});

describe('initiateCardPayment failure mapping', () => {
  it('maps a failed pre-claim onto the unavailable channel', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const failingStores = {
      ...stores,
      insertPaymentIfAbsentWithinTx: () => {
        throw new Error('database down');
      },
    };
    const result = await initiateCardPayment(
      { ...deps, stores: failingStores },
      chargeArgs(userId)
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(provider.getChargeRequests()).toHaveLength(0);
  });

  it('records an approval that carries no card identifiers', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    provider.setNextChargeOutcome({
      status: 'approved',
      transactionId: `mock-txn-${crypto.randomUUID()}`,
    });
    const result = await initiateCardPayment(deps, chargeArgs(userId));
    const outcome = result._unsafeUnwrap();
    expect(outcome.status).toBe('awaiting_webhook');
    const row = await stores.readPayment(db, outcome.paymentId);
    expect(row._unsafeUnwrap()?.cardType).toBeNull();
    expect(row._unsafeUnwrap()?.cardLastFour).toBeNull();
    await provider.flushWebhooks();
  });

  it('replays the winner state when a concurrent retry finalized first', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const racingStores = {
      ...stores,
      markPaymentChargedWithinTx: async (
        ...parameters: Parameters<typeof stores.markPaymentChargedWithinTx>
      ) => {
        // The concurrent retry lands the transition; this caller observes 0 rows.
        await stores.markPaymentChargedWithinTx(...parameters);
        return false;
      },
    };
    const result = await initiateCardPayment({ ...deps, stores: racingStores }, chargeArgs(userId));
    const outcome = result._unsafeUnwrap();
    expect(outcome.status).toBe('awaiting_webhook');
    await provider.flushWebhooks();
  });

  it('treats a vanished pre-claim row during finalize as a defect', async () => {
    const userId = await createUser();
    const provider = freshProvider();
    const deps = freshDeps(provider);
    const vanishedStores = {
      ...stores,
      markPaymentChargedWithinTx: () => Promise.resolve(false),
      readPayment: () => okAsync(null),
    };
    await expect(
      initiateCardPayment({ ...deps, stores: vanishedStores }, chargeArgs(userId))
    ).rejects.toThrow(/vanished/);
    await provider.flushWebhooks();
  });
});
