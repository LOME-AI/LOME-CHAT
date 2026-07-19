import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, ledgerEntries, users, wallets } from '@hushbox/db';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { createBillingStores } from '../adapters/stores.js';
import { WELCOME_CREDIT_NANO_USD } from './constants.js';
import { provisionWalletsWithinTx } from './wallets.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for billing wallet integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
let userCounter = 0;

async function createUser(): Promise<string> {
  userCounter += 1;
  const username = `blwal${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(userCounter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@billing-wallets.test`,
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

afterAll(async () => {
  if (createdUserIds.length > 0) {
    const walletRows = await db
      .select({ id: wallets.id })
      .from(wallets)
      .where(inArray(wallets.userId, createdUserIds));
    const walletIds = walletRows.map((row) => row.id);
    if (walletIds.length > 0) {
      // Delete whole transaction groups: removing only the wallet legs would
      // trip the zero-sum commit trigger.
      const legRows = await db
        .select({ transactionId: ledgerEntries.transactionId })
        .from(ledgerEntries)
        .where(inArray(ledgerEntries.walletId, walletIds));
      const transactionIds = [...new Set(legRows.map((row) => row.transactionId))];
      if (transactionIds.length > 0) {
        await db.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, transactionIds));
      }
      await db.delete(wallets).where(inArray(wallets.id, walletIds));
    }
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('provisionWalletsWithinTx', () => {
  it('creates a purchased wallet carrying the welcome credit', async () => {
    const userId = await createUser();
    const result = await runSettlement(db, (tx) => provisionWalletsWithinTx(stores, tx, userId));
    expect(result.welcomeCreditGranted).toBe(true);
    const rows = await db.select().from(wallets).where(eq(wallets.id, result.purchasedWalletId));
    expect(rows[0]?.balanceNanoUsd).toBe(WELCOME_CREDIT_NANO_USD);
    expect(rows[0]?.ledgerSeq).toBe(1n);
  });

  it('creates a free wallet with a zero balance', async () => {
    const userId = await createUser();
    const result = await runSettlement(db, (tx) => provisionWalletsWithinTx(stores, tx, userId));
    const rows = await db.select().from(wallets).where(eq(wallets.id, result.freeWalletId));
    expect(rows[0]?.type).toBe('free');
    expect(rows[0]?.balanceNanoUsd).toBe(0n);
  });

  it('writes the welcome credit as a zero-sum promo leg pair', async () => {
    const userId = await createUser();
    const result = await runSettlement(db, (tx) => provisionWalletsWithinTx(stores, tx, userId));
    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, result.purchasedWalletId));
    expect(legs).toHaveLength(1);
    const userLeg = legs[0];
    expect(userLeg?.kind).toBe('promo');
    expect(userLeg?.amountNanoUsd).toBe(WELCOME_CREDIT_NANO_USD);
    expect(userLeg?.balanceAfterNanoUsd).toBe(WELCOME_CREDIT_NANO_USD);
    const houseLegs = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, userLeg?.transactionId ?? ''));
    const total = houseLegs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n);
    expect(houseLegs).toHaveLength(2);
    expect(total).toBe(0n);
    expect(houseLegs.some((leg) => leg.houseAccount === 'promo')).toBe(true);
  });

  it('replays as a no-op when the wallets already exist', async () => {
    const userId = await createUser();
    const first = await runSettlement(db, (tx) => provisionWalletsWithinTx(stores, tx, userId));
    const second = await runSettlement(db, (tx) => provisionWalletsWithinTx(stores, tx, userId));
    expect(second.purchasedWalletId).toBe(first.purchasedWalletId);
    expect(second.freeWalletId).toBe(first.freeWalletId);
    expect(second.welcomeCreditGranted).toBe(false);
    const rows = await db.select().from(wallets).where(eq(wallets.id, first.purchasedWalletId));
    expect(rows[0]?.balanceNanoUsd).toBe(WELCOME_CREDIT_NANO_USD);
  });

  it('grants the welcome credit exactly once under concurrent provisioning', async () => {
    const userId = await createUser();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        runSettlement(db, (tx) => provisionWalletsWithinTx(stores, tx, userId))
      )
    );
    const grants = results.filter((result) => result.welcomeCreditGranted);
    expect(grants).toHaveLength(1);
    const walletId = results[0]?.purchasedWalletId ?? '';
    const rows = await db.select().from(wallets).where(eq(wallets.id, walletId));
    expect(rows[0]?.balanceNanoUsd).toBe(WELCOME_CREDIT_NANO_USD);
    const legs = await db.select().from(ledgerEntries).where(eq(ledgerEntries.walletId, walletId));
    expect(legs).toHaveLength(1);
  });
});
