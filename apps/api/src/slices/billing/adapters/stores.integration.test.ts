import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  ledgerEntries,
  payments,
  users,
  wallets,
} from '@hushbox/db';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { createBillingStores, requireRow } from './stores.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for billing store integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const createdWalletIds: string[] = [];
const createdUserIds: string[] = [];
const BYTES = new Uint8Array([1, 2, 3]);
let userCounter = 0;

async function seedWallet(): Promise<string> {
  const rows = await db
    .insert(wallets)
    .values({ userId: null, type: 'purchased', balanceNanoUsd: 0n })
    .returning({ id: wallets.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('wallet seed failed');
  createdWalletIds.push(id);
  return id;
}

async function seedUser(): Promise<string> {
  userCounter += 1;
  const username = `blst${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(userCounter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@billing-stores.test`,
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

async function seedPendingPayment(
  userId: string,
  amountNanoUsd = 5_000_000_000n
): Promise<{ id: string; idempotencyKey: string }> {
  const idempotencyKey = `pay:${userId}:${crypto.randomUUID()}`;
  const created = await runSettlement(db, (tx) =>
    stores.insertPaymentIfAbsentWithinTx(tx, { userId, amountNanoUsd, idempotencyKey })
  );
  return { id: created.payment.id, idempotencyKey };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(payments).where(inArray(payments.userId, createdUserIds));
  }
  if (createdWalletIds.length > 0) {
    const legRows = await db
      .select({ transactionId: ledgerEntries.transactionId })
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.walletId, createdWalletIds));
    const transactionIds = [...new Set(legRows.map((row) => row.transactionId))];
    if (transactionIds.length > 0) {
      await db.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, transactionIds));
    }
    await db.delete(wallets).where(inArray(wallets.id, createdWalletIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('requireRow', () => {
  it('returns a present row', () => {
    expect(requireRow('row', 'missing')).toBe('row');
  });

  it('throws the defect message for an absent row', () => {
    expect(() => {
      requireRow(undefined, 'wallet to lock does not exist');
    }).toThrow(/wallet to lock does not exist/);
  });
});

describe('settlement defect guards', () => {
  it('aborts on locking a wallet that does not exist', async () => {
    await expect(
      runSettlement(db, (tx) => stores.lockWalletWithinTx(tx, crypto.randomUUID()))
    ).rejects.toThrow(/wallet to lock does not exist/);
  });

  it('aborts on a balance update that hits no wallet', async () => {
    await expect(
      runSettlement(db, (tx) => stores.updateWalletBalanceWithinTx(tx, crypto.randomUUID(), 0n, 1n))
    ).rejects.toThrow(/wallet balance update affected no row/);
  });

  it('rejects a ledger write with no legs', async () => {
    await expect(
      runSettlement(db, (tx) => stores.insertLedgerLegsWithinTx(tx, []))
    ).rejects.toThrow(/at least one leg/);
  });
});

describe('reads', () => {
  it('reads an absent member budget as null', async () => {
    const result = await stores.readMemberBudget(db, crypto.randomUUID(), '2026-07');
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('reads absent conversation spending as zero', async () => {
    const result = await stores.readConversationSpent(db, crypto.randomUUID(), '2026-07');
    expect(result._unsafeUnwrap()).toBe(0n);
  });

  it('reads an absent usage record as null', async () => {
    const result = await stores.readUsageRecord(db, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('reads a chargeless usage record wallet as null', async () => {
    const result = await stores.readUsageChargeWallet(db, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('reads an absent wallet snapshot as null', async () => {
    const result = await stores.readWalletSnapshot(db, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('finds no drift or unbalanced groups on a fresh wallet', async () => {
    const walletId = await seedWallet();
    const drift = await stores.findWalletDrift(db, 1000);
    expect(drift._unsafeUnwrap().some((entry) => entry.walletId === walletId)).toBe(false);
  });

  it('maps an unreachable database onto the unavailable error channel', async () => {
    const badDb = createDb('postgresql://user:pw@localhost:1/nope', {
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
    const result = await stores.readWallets(badDb, crypto.randomUUID());
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    await badDb.$client.end();
  });
});

describe('payment pre-claim insert', () => {
  it('creates a pending payment row on first insert', async () => {
    const userId = await seedUser();
    const idempotencyKey = `pay:${userId}:${crypto.randomUUID()}`;
    const result = await runSettlement(db, (tx) =>
      stores.insertPaymentIfAbsentWithinTx(tx, {
        userId,
        amountNanoUsd: 5_000_000_000n,
        idempotencyKey,
      })
    );
    expect(result.created).toBe(true);
    expect(result.payment.status).toBe('pending');
    expect(result.payment.userId).toBe(userId);
    expect(result.payment.amountNanoUsd).toBe(5_000_000_000n);
  });

  it('returns the existing row on a duplicate idempotency key', async () => {
    const userId = await seedUser();
    const idempotencyKey = `pay:${userId}:${crypto.randomUUID()}`;
    const first = await runSettlement(db, (tx) =>
      stores.insertPaymentIfAbsentWithinTx(tx, {
        userId,
        amountNanoUsd: 5_000_000_000n,
        idempotencyKey,
      })
    );
    const second = await runSettlement(db, (tx) =>
      stores.insertPaymentIfAbsentWithinTx(tx, {
        userId,
        amountNanoUsd: 9_000_000_000n,
        idempotencyKey,
      })
    );
    expect(second.created).toBe(false);
    expect(second.payment.id).toBe(first.payment.id);
    expect(second.payment.amountNanoUsd).toBe(5_000_000_000n);
  });
});

describe('payment state transitions', () => {
  it('marks a pending payment charged with the provider identifiers', async () => {
    const userId = await seedUser();
    const { id } = await seedPendingPayment(userId);
    const transitioned = await runSettlement(db, (tx) =>
      stores.markPaymentChargedWithinTx(tx, id, {
        helcimTransactionId: `txn-${crypto.randomUUID()}`,
        cardType: 'Visa',
        cardLastFour: '9990',
      })
    );
    expect(transitioned).toBe(true);
    const row = await stores.readPayment(db, id);
    expect(row._unsafeUnwrap()?.status).toBe('awaiting_webhook');
    expect(row._unsafeUnwrap()?.cardLastFour).toBe('9990');
  });

  it('refuses to re-mark an already charged payment', async () => {
    const userId = await seedUser();
    const { id } = await seedPendingPayment(userId);
    await runSettlement(db, (tx) =>
      stores.markPaymentChargedWithinTx(tx, id, {
        helcimTransactionId: `txn-${crypto.randomUUID()}`,
      })
    );
    const again = await runSettlement(db, (tx) =>
      stores.markPaymentChargedWithinTx(tx, id, {
        helcimTransactionId: `txn-${crypto.randomUUID()}`,
      })
    );
    expect(again).toBe(false);
  });

  it('marks a pending payment failed with an error code', async () => {
    const userId = await seedUser();
    const { id } = await seedPendingPayment(userId);
    const transitioned = await runSettlement(db, (tx) =>
      stores.markPaymentFailedWithinTx(tx, id, 'card_declined', 'pending')
    );
    expect(transitioned).toBe(true);
    const row = await stores.readPayment(db, id);
    expect(row._unsafeUnwrap()?.status).toBe('failed');
    expect(row._unsafeUnwrap()?.errorCode).toBe('card_declined');
  });

  it('refuses to fail a payment from the wrong expected status', async () => {
    const userId = await seedUser();
    const { id } = await seedPendingPayment(userId);
    const transitioned = await runSettlement(db, (tx) =>
      stores.markPaymentFailedWithinTx(tx, id, 'card_declined', 'awaiting_webhook')
    );
    expect(transitioned).toBe(false);
  });

  it('expires a pending payment', async () => {
    const userId = await seedUser();
    const { id } = await seedPendingPayment(userId);
    const expired = await runSettlement(db, (tx) => stores.markPaymentExpiredWithinTx(tx, id));
    expect(expired).toBe(true);
    const row = await stores.readPayment(db, id);
    expect(row._unsafeUnwrap()?.status).toBe('expired');
  });

  it('refuses to expire a payment that is already charged', async () => {
    const userId = await seedUser();
    const { id } = await seedPendingPayment(userId);
    await runSettlement(db, (tx) =>
      stores.markPaymentChargedWithinTx(tx, id, {
        helcimTransactionId: `txn-${crypto.randomUUID()}`,
      })
    );
    const expired = await runSettlement(db, (tx) => stores.markPaymentExpiredWithinTx(tx, id));
    expect(expired).toBe(false);
  });
});

describe('payment completed claim', () => {
  it('claims an awaiting-webhook payment by transaction id exactly once', async () => {
    const userId = await seedUser();
    const { id } = await seedPendingPayment(userId);
    const transactionId = `txn-${crypto.randomUUID()}`;
    await runSettlement(db, (tx) =>
      stores.markPaymentChargedWithinTx(tx, id, { helcimTransactionId: transactionId })
    );
    const first = await runSettlement(db, (tx) =>
      stores.claimPaymentCompletedWithinTx(tx, { helcimTransactionId: transactionId })
    );
    const second = await runSettlement(db, (tx) =>
      stores.claimPaymentCompletedWithinTx(tx, { helcimTransactionId: transactionId })
    );
    expect(first?.id).toBe(id);
    expect(first?.status).toBe('completed');
    expect(second).toBeNull();
  });

  it('claims an awaiting-webhook payment by payment id', async () => {
    const userId = await seedUser();
    const { id } = await seedPendingPayment(userId);
    await runSettlement(db, (tx) =>
      stores.markPaymentChargedWithinTx(tx, id, {
        helcimTransactionId: `txn-${crypto.randomUUID()}`,
      })
    );
    const claimed = await runSettlement(db, (tx) =>
      stores.claimPaymentCompletedWithinTx(tx, { paymentId: id })
    );
    expect(claimed?.id).toBe(id);
  });

  it('never claims a payment that is still pending', async () => {
    const userId = await seedUser();
    const { id } = await seedPendingPayment(userId);
    const claimed = await runSettlement(db, (tx) =>
      stores.claimPaymentCompletedWithinTx(tx, { paymentId: id })
    );
    expect(claimed).toBeNull();
  });
});

describe('payment reads', () => {
  it('reads an absent payment as null', async () => {
    const result = await stores.readPayment(db, crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('reads an absent transaction id as null', async () => {
    const result = await stores.readPaymentByTransactionId(db, `txn-${crypto.randomUUID()}`);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('reads a payment back by its provider transaction id', async () => {
    const userId = await seedUser();
    const { id } = await seedPendingPayment(userId);
    const transactionId = `txn-${crypto.randomUUID()}`;
    await runSettlement(db, (tx) =>
      stores.markPaymentChargedWithinTx(tx, id, { helcimTransactionId: transactionId })
    );
    const result = await stores.readPaymentByTransactionId(db, transactionId);
    expect(result._unsafeUnwrap()?.id).toBe(id);
  });
});

describe('guarded ledger leg insert', () => {
  it('inserts a zero-sum pair once and reports the duplicate', async () => {
    const walletId = await seedWallet();
    const key = crypto.randomUUID();
    const legs = [
      {
        transactionId: crypto.randomUUID(),
        kind: 'clawback' as const,
        amountNanoUsd: -5_000_000_000n,
        balanceAfterNanoUsd: -5_000_000_000n,
        walletId,
        idempotencyKey: `clawback:${key}:user`,
      },
      {
        transactionId: crypto.randomUUID(),
        kind: 'clawback' as const,
        amountNanoUsd: 5_000_000_000n,
        houseAccount: 'payments-in' as const,
        idempotencyKey: `clawback:${key}:house`,
      },
    ];
    // Distinct transactionIds would break zero-sum; share one.
    const transactionId = crypto.randomUUID();
    const sharedLegs = legs.map((leg) => ({ ...leg, transactionId }));
    const first = await runSettlement(db, (tx) =>
      stores.insertLedgerLegsIfAbsentWithinTx(tx, sharedLegs)
    );
    const second = await runSettlement(db, (tx) =>
      stores.insertLedgerLegsIfAbsentWithinTx(tx, sharedLegs)
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('rejects a guarded insert with no legs', async () => {
    await expect(
      runSettlement(db, (tx) => stores.insertLedgerLegsIfAbsentWithinTx(tx, []))
    ).rejects.toThrow(/at least one leg/);
  });
});
