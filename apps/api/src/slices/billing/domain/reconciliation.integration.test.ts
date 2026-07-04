import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, payments, users } from '@hushbox/db';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { createBillingStores } from '../adapters/stores.js';
import { PAYMENT_MINIMUM_NANO_USD } from './payments.js';
import {
  PENDING_RECONCILE_AGE_SECONDS,
  runPendingPaymentReconciliation,
} from './reconciliation.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for reconciliation integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdPaymentIds: string[] = [];
let userCounter = 0;

async function createUser(): Promise<string> {
  userCounter += 1;
  const username = `blrec${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(userCounter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@reconciliation.test`,
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

async function seedPending(userId: string, createdAt: Date): Promise<string> {
  const { payment } = await runSettlement(db, (tx) =>
    stores.insertPaymentIfAbsentWithinTx(tx, {
      userId,
      amountNanoUsd: PAYMENT_MINIMUM_NANO_USD,
      idempotencyKey: `pay:${userId}:${crypto.randomUUID()}`,
    })
  );
  await db.update(payments).set({ createdAt }).where(eq(payments.id, payment.id));
  createdPaymentIds.push(payment.id);
  return payment.id;
}

afterAll(async () => {
  if (createdPaymentIds.length > 0) {
    await db.delete(payments).where(inArray(payments.id, createdPaymentIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('runPendingPaymentReconciliation', () => {
  it('returns only pending pre-claims older than the reconcile age', async () => {
    const now = new Date();
    const userId = await createUser();
    const staleId = await seedPending(
      userId,
      new Date(now.getTime() - (PENDING_RECONCILE_AGE_SECONDS + 3600) * 1000)
    );
    const freshId = await seedPending(userId, now);

    const result = await runPendingPaymentReconciliation(stores, db, now);
    const ids = result._unsafeUnwrap().stalePending.map((row) => row.id);

    expect(ids).toContain(staleId);
    expect(ids).not.toContain(freshId);
  });

  it('excludes a charged (awaiting_webhook) pre-claim of the same age', async () => {
    const now = new Date();
    const userId = await createUser();
    const chargedId = await seedPending(
      userId,
      new Date(now.getTime() - (PENDING_RECONCILE_AGE_SECONDS + 3600) * 1000)
    );
    await runSettlement(db, (tx) =>
      stores.markPaymentChargedWithinTx(tx, chargedId, {
        helcimTransactionId: `txn-${crypto.randomUUID()}`,
      })
    );

    const result = await runPendingPaymentReconciliation(stores, db, now);

    expect(result._unsafeUnwrap().stalePending.map((row) => row.id)).not.toContain(chargedId);
  });

  it('leaves the swept rows unchanged (detection only)', async () => {
    const now = new Date();
    const userId = await createUser();
    const staleId = await seedPending(
      userId,
      new Date(now.getTime() - (PENDING_RECONCILE_AGE_SECONDS + 3600) * 1000)
    );

    const result = await runPendingPaymentReconciliation(stores, db, now);
    expect(result.isOk()).toBe(true);

    const row = await stores.readPayment(db, staleId);
    expect(row._unsafeUnwrap()?.status).toBe('pending');
  });
});
