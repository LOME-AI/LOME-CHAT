import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { eq, inArray, sql } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, ledgerEntries, wallets } from '@hushbox/db';
import { createBillingStores } from '../adapters/stores.js';
import { BILLING_KEYS } from './keys.js';
import { writeThroughSnapshot } from './admission.js';
import { findSnapshotDrift, runConservationAudit } from './auditors.js';
import type { ConservationAuditFindings, SnapshotDrift } from './auditors.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and Redis env are required for billing auditor tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const stores = createBillingStores();
const createdWalletIds: string[] = [];
const createdTransactionIds: string[] = [];

async function audit(): Promise<ConservationAuditFindings> {
  const result = await runConservationAudit(stores, db);
  return result._unsafeUnwrap();
}

async function drift(walletId: string): Promise<SnapshotDrift | null> {
  const result = await findSnapshotDrift({ redis, db, stores }, walletId);
  return result._unsafeUnwrap();
}

async function seedWallet(balanceNanoUsd: bigint): Promise<string> {
  const rows = await db
    .insert(wallets)
    .values({ userId: null, type: 'purchased', balanceNanoUsd })
    .returning({ id: wallets.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('wallet seed failed');
  createdWalletIds.push(id);
  return id;
}

afterAll(async () => {
  if (createdTransactionIds.length > 0) {
    await db.execute(sql`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_zero_sum`);
    await db
      .delete(ledgerEntries)
      .where(inArray(ledgerEntries.transactionId, createdTransactionIds));
    await db.execute(sql`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_zero_sum`);
  }
  if (createdWalletIds.length > 0) {
    await Promise.all(
      createdWalletIds.map((walletId) => redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId)))
    );
    await db.delete(wallets).where(inArray(wallets.id, createdWalletIds));
  }
  await db.$client.end();
});

describe('runConservationAudit', () => {
  it('reports a wallet whose balance drifted from its leg sum', async () => {
    const walletId = await seedWallet(0n);
    // Simulated bug: balance moved with no ledger legs.
    await db.update(wallets).set({ balanceNanoUsd: 123n }).where(eq(wallets.id, walletId));
    const findings = await audit();
    const finding = findings.walletDrift.find((entry) => entry.walletId === walletId);
    expect(finding).toEqual({ walletId, balanceNanoUsd: 123n, legSumNanoUsd: 0n });
  });

  it('reports a transaction whose legs do not sum to zero', async () => {
    const walletId = await seedWallet(0n);
    const transactionId = crypto.randomUUID();
    createdTransactionIds.push(transactionId);
    // The commit trigger forbids this by construction; the auditor is the
    // detector for repairs/bugs that bypass it — simulate one by disabling
    // the trigger for the seed write only.
    await db.execute(sql`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_zero_sum`);
    try {
      await db.insert(ledgerEntries).values({
        transactionId,
        kind: 'charge',
        amountNanoUsd: -77n,
        balanceAfterNanoUsd: -77n,
        walletId,
        idempotencyKey: `audit-unbalanced:${transactionId}`,
      });
    } finally {
      await db.execute(sql`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_zero_sum`);
    }
    const findings = await audit();
    const unbalanced = findings.unbalancedTransactions.find(
      (entry) => entry.transactionId === transactionId
    );
    expect(unbalanced).toEqual({ transactionId, totalNanoUsd: -77n });
  });

  it('stays quiet for a conserved wallet', async () => {
    const walletId = await seedWallet(0n);
    const findings = await audit();
    expect(findings.walletDrift.some((entry) => entry.walletId === walletId)).toBe(false);
  });
});

describe('findSnapshotDrift edge handling', () => {
  it('fails typed when Redis is unreachable', async () => {
    const deadRedis = new Redis({ url: 'http://localhost:1', token: 'token' });
    const walletId = await seedWallet(0n);
    const result = await findSnapshotDrift({ redis: deadRedis, db, stores }, walletId);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('rejects a malformed cached snapshot', async () => {
    const walletId = await seedWallet(0n);
    await redis.set(BILLING_KEYS.walletSnapshot.buildKey(walletId), { junk: true });
    const result = await findSnapshotDrift({ redis, db, stores }, walletId);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('returns null when the wallet row is gone', async () => {
    const walletId = crypto.randomUUID();
    const written = await writeThroughSnapshot(redis, {
      walletId,
      balanceNanoUsd: 1n,
      ledgerSeq: 1n,
      walletType: 'purchased',
    });
    written._unsafeUnwrap();
    const observed = await findSnapshotDrift({ redis, db, stores }, walletId);
    expect(observed._unsafeUnwrap()).toBeNull();
    await redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId));
  });
});

describe('findSnapshotDrift', () => {
  it('returns null when no snapshot is cached', async () => {
    const walletId = await seedWallet(500n);
    const observed = await drift(walletId);
    expect(observed).toBeNull();
  });

  it('reports the divergence between the cached snapshot and the ledger balance', async () => {
    const walletId = await seedWallet(500n);
    const written = await writeThroughSnapshot(redis, {
      walletId,
      balanceNanoUsd: 500n,
      ledgerSeq: 1n,
      walletType: 'purchased',
    });
    written._unsafeUnwrap();
    await db.update(wallets).set({ balanceNanoUsd: 800n }).where(eq(wallets.id, walletId));
    const observed = await drift(walletId);
    expect(observed).toEqual({
      walletId,
      snapshotBalanceNanoUsd: 500n,
      ledgerBalanceNanoUsd: 800n,
      driftNanoUsd: -300n,
    });
  });
});
