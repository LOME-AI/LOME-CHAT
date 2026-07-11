import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { eq, inArray, sql } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, ledgerEntries, wallets } from '@hushbox/db';
import { sweepLeakedTestWallets } from '../__tests__/orphan-wallet-sweep.js';
import { createBillingStores } from '../adapters/stores.js';
import { BILLING_KEYS } from './keys.js';
import { writeThroughSnapshot } from './admission.js';
import {
  compareSnapshotToLedger,
  listSnapshotWalletIds,
  runConservationAudit,
} from './auditors.js';
import type { ConservationAuditFindings } from './auditors.js';

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

/**
 * A wallet id with a 48-bit millisecond prefix far beyond any real uuidv7,
 * strictly increasing with `index`. `findWalletDrift` orders by desc(id), so
 * these fixtures always sort to the top and the audit LIMIT can never drop them
 * (the wallet analog of the unbalanced-order test's future created_at); newest-
 * first is therefore this run reversed. Random low bits keep a leaked id from a
 * crashed prior run from colliding on the PK. `createdAt` stays real-now (the
 * default), so the age-gated sweep still reclaims a leaked one.
 */
function futureDriftWalletId(index: number): string {
  const prefixHex = (0xf0_00_00_00_00_00 + index).toString(16).padStart(12, '0');
  const rand = crypto.randomUUID().replaceAll('-', '');
  return `${prefixHex.slice(0, 8)}-${prefixHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 18)}`;
}

beforeAll(async () => {
  await sweepLeakedTestWallets(db);
});

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

  it('orders drifting wallets newest-first over the uuidv7 PK', async () => {
    // A two-element relative check pinned the ORDER BY only by accident: it
    // failed on removal solely when ambient drift rows overflowed the audit
    // LIMIT and pushed these out of an unordered sample. On a clean DB it would
    // pass either way. Instead seed a controlled run of drift wallets with
    // strictly increasing, always-newest ids and assert the exact newest-first
    // permutation of this run — accidental agreement is 1/6! ≈ 0.1%.
    const seededIds = Array.from({ length: 6 }, (_, index) => futureDriftWalletId(index));
    for (const id of seededIds) createdWalletIds.push(id);
    // Non-zero balance with no legs (leg sum 0) trips the drift audit.
    await db.insert(wallets).values(
      seededIds.map((id) => ({
        id,
        userId: null,
        type: 'purchased' as const,
        balanceNanoUsd: 1n,
      }))
    );
    const expectedNewestFirst = seededIds.toReversed();
    const findings = await audit();
    const seeded = new Set<string>(seededIds);
    // Filter to this run's set so unrelated drift rows the suite left behind
    // (or a concurrent file seeded) cannot perturb the assertion.
    const observedOrder = findings.walletDrift
      .map((entry) => entry.walletId)
      .filter((id) => seeded.has(id));
    expect(observedOrder).toEqual(expectedNewestFirst);
  });

  it('orders unbalanced transactions newest-first by leg created_at', async () => {
    const walletId = await seedWallet(0n);
    // A two-transaction relative check would pin the ORDER BY only ~half the
    // time: with few unbalanced rows the LIMIT never drops them, so the
    // unordered GROUP BY output lands newest-first by chance. Seed a run of
    // transactions with distinct created_at and assert the exact newest-first
    // permutation of this run — accidental agreement is 1/6! ≈ 0.1%.
    const base = Date.now();
    // seeded[i] is assigned created_at = base + i minutes, so the newest-first
    // expectation is this array reversed.
    const seeded = Array.from({ length: 6 }, (_, index) => ({
      transactionId: crypto.randomUUID(),
      createdAt: new Date(base + index * 60_000),
    }));
    for (const row of seeded) createdTransactionIds.push(row.transactionId);
    const expectedNewestFirst = seeded.toReversed().map((row) => row.transactionId);
    // The zero-sum trigger forbids unbalanced legs; disable it for the seed
    // writes only, exactly as the reporting test above does.
    await db.execute(sql`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_zero_sum`);
    try {
      for (const row of seeded) {
        await db.insert(ledgerEntries).values({
          transactionId: row.transactionId,
          kind: 'charge',
          amountNanoUsd: -13n,
          balanceAfterNanoUsd: -13n,
          walletId,
          idempotencyKey: `audit-order:${row.transactionId}`,
          createdAt: row.createdAt,
        });
      }
    } finally {
      await db.execute(sql`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_zero_sum`);
    }
    const findings = await audit();
    const seededIds = new Set<string>(seeded.map((row) => row.transactionId));
    // These rows carry the newest created_at in the table, so the LIMIT keeps
    // all of them; filtering to the seeded set makes the check robust to
    // whatever other unbalanced transactions the suite has left behind.
    const observedOrder = findings.unbalancedTransactions
      .map((entry) => entry.transactionId)
      .filter((id) => seededIds.has(id));
    // order by max(created_at) desc.
    expect(observedOrder).toEqual(expectedNewestFirst);
  });

  it('stays quiet for a conserved wallet', async () => {
    const walletId = await seedWallet(0n);
    const findings = await audit();
    expect(findings.walletDrift.some((entry) => entry.walletId === walletId)).toBe(false);
  });
});

describe('compareSnapshotToLedger', () => {
  it('fails typed when Redis is unreachable', async () => {
    const deadRedis = new Redis({ url: 'http://localhost:1', token: 'token' });
    const walletId = await seedWallet(0n);
    const result = await compareSnapshotToLedger({ redis: deadRedis, db, stores }, walletId);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('rejects a malformed cached snapshot', async () => {
    const walletId = await seedWallet(0n);
    await redis.set(BILLING_KEYS.walletSnapshot.buildKey(walletId), { junk: true });
    const result = await compareSnapshotToLedger({ redis, db, stores }, walletId);
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
    const observed = await compareSnapshotToLedger({ redis, db, stores }, walletId);
    expect(observed._unsafeUnwrap()).toBeNull();
    await redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId));
  });

  it('returns null when no snapshot is cached', async () => {
    const walletId = await seedWallet(500n);
    const observed = await compareSnapshotToLedger({ redis, db, stores }, walletId);
    expect(observed._unsafeUnwrap()).toBeNull();
  });

  it('reports balances, drift, and both ledger sequences', async () => {
    const walletId = await seedWallet(500n);
    const written = await writeThroughSnapshot(redis, {
      walletId,
      balanceNanoUsd: 500n,
      ledgerSeq: 1n,
      walletType: 'purchased',
    });
    written._unsafeUnwrap();
    await db
      .update(wallets)
      .set({ balanceNanoUsd: 800n, ledgerSeq: 5n })
      .where(eq(wallets.id, walletId));
    const observed = await compareSnapshotToLedger({ redis, db, stores }, walletId);
    expect(observed._unsafeUnwrap()).toEqual({
      walletId,
      snapshotBalanceNanoUsd: 500n,
      ledgerBalanceNanoUsd: 800n,
      driftNanoUsd: -300n,
      snapshotLedgerSeq: 1n,
      walletLedgerSeq: 5n,
    });
  });

  it('surfaces a snapshot sequence ahead of the ledger (the impossible state)', async () => {
    const walletId = await seedWallet(100n);
    const written = await writeThroughSnapshot(redis, {
      walletId,
      balanceNanoUsd: 100n,
      ledgerSeq: 9n,
      walletType: 'purchased',
    });
    written._unsafeUnwrap();
    const observed = await compareSnapshotToLedger({ redis, db, stores }, walletId);
    const comparison = observed._unsafeUnwrap();
    if (comparison === null) throw new Error('expected a comparison');
    expect(comparison.snapshotLedgerSeq).toBe(9n);
    expect(comparison.snapshotLedgerSeq > comparison.walletLedgerSeq).toBe(true);
  });
});

describe('listSnapshotWalletIds', () => {
  it('lists the wallets that currently hold a cached snapshot', async () => {
    const first = await seedWallet(10n);
    const second = await seedWallet(20n);
    for (const walletId of [first, second]) {
      const written = await writeThroughSnapshot(redis, {
        walletId,
        balanceNanoUsd: 10n,
        ledgerSeq: 1n,
        walletType: 'purchased',
      });
      written._unsafeUnwrap();
    }
    const observed = await listSnapshotWalletIds(redis);
    const walletIds = observed._unsafeUnwrap();
    expect(walletIds).toContain(first);
    expect(walletIds).toContain(second);
  });

  it('fails typed when Redis is unreachable', async () => {
    const deadRedis = new Redis({ url: 'http://localhost:1', token: 'token' });
    const observed = await listSnapshotWalletIds(deadRedis);
    expect(observed._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
