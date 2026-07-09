import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, wallets } from '@hushbox/db';
import { sweepLeakedTestWallets } from '../__tests__/orphan-wallet-sweep.js';
import { createBillingStores } from '../adapters/stores.js';
import { BILLING_KEYS, MAX_HOLD_TTL_SECONDS } from './keys.js';
import { COST_CIRCUIT_MULTIPLIER, HOLD_TTL_MARGIN_SECONDS } from './constants.js';
import { admitRun, refreshWalletSnapshot, releaseHold, writeThroughSnapshot } from './admission.js';
import type { AdmissionDecision, AdmissionDeps, AdmissionRequest } from './admission.js';
import type { WalletType } from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for admission tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const deadRedis = new Redis({ url: 'http://localhost:1', token: 'token' });
const stores = createBillingStores();
const NOW = new Date('2026-07-03T12:00:00Z');
const createdWalletIds: string[] = [];

async function seedWallet(
  balanceNanoUsd: bigint,
  ledgerSeq = 0n,
  type: WalletType = 'purchased'
): Promise<string> {
  const rows = await db
    .insert(wallets)
    .values({ userId: null, type, balanceNanoUsd, ledgerSeq })
    .returning({ id: wallets.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('wallet seed failed');
  createdWalletIds.push(id);
  return id;
}

function request(walletId: string, overrides?: Partial<AdmissionRequest>): AdmissionRequest {
  return {
    walletId,
    holdId: crypto.randomUUID(),
    estimateNanoUsd: 100_000_000n,
    deadlineSeconds: 300,
    concurrentRunCap: 10,
    budgets: [],
    now: NOW,
    ...overrides,
  };
}

async function decide(deps: AdmissionDeps, req: AdmissionRequest): Promise<AdmissionDecision> {
  const result = await admitRun(deps, req);
  return result._unsafeUnwrap();
}

async function snapshotWritten(
  walletId: string,
  balanceNanoUsd: bigint,
  ledgerSeq: bigint
): Promise<boolean> {
  const result = await writeThroughSnapshot(redis, {
    walletId,
    balanceNanoUsd,
    ledgerSeq,
    walletType: 'purchased',
  });
  return result._unsafeUnwrap();
}

beforeAll(async () => {
  await sweepLeakedTestWallets(db);
});

afterAll(async () => {
  if (createdWalletIds.length > 0) {
    await Promise.all(
      createdWalletIds.map((walletId) =>
        redis.del(
          BILLING_KEYS.walletSnapshot.buildKey(walletId),
          BILLING_KEYS.walletHolds.buildKey(walletId)
        )
      )
    );
    await db.delete(wallets).where(inArray(wallets.id, createdWalletIds));
  }
  await db.$client.end();
});

describe('admitRun', () => {
  it('admits an affordable run and returns the hold readout exposing the estimate and K', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const req = request(walletId);
    const decision = await decide({ redis, db, stores }, req);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) throw new Error('unreachable');
    expect(decision.hold.estimateNanoUsd).toBe(100_000_000n);
    expect(decision.hold.costCircuitMultiplier).toBe(COST_CIRCUIT_MULTIPLIER);
    expect(decision.hold.costCircuitLimitNanoUsd).toBe(500_000_000n);
    expect(decision.hold.expiresAtMs).toBe(NOW.getTime() + (300 + HOLD_TTL_MARGIN_SECONDS) * 1000);
  });

  it('refuses when the balance minus active holds cannot cover the estimate', async () => {
    const walletId = await seedWallet(150_000_000n);
    const deps = { redis, db, stores };
    const first = await decide(deps, request(walletId));
    expect(first.admitted).toBe(true);
    const second = await decide(deps, request(walletId));
    expect(second).toEqual({ admitted: false, reason: 'insufficient-balance' });
  });

  it('never over-admits a single wallet under concurrent admission', async () => {
    const walletId = await seedWallet(300_000_000n);
    const deps = { redis, db, stores };
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => admitRun(deps, request(walletId)))
    );
    const admitted = decisions.filter((d) => d._unsafeUnwrap().admitted);
    expect(admitted).toHaveLength(3);
  });

  it('enforces the per-wallet concurrent-run cap', async () => {
    const walletId = await seedWallet(10_000_000_000n);
    const deps = { redis, db, stores };
    const first = await decide(deps, request(walletId, { concurrentRunCap: 1 }));
    expect(first.admitted).toBe(true);
    const second = await decide(deps, request(walletId, { concurrentRunCap: 1 }));
    expect(second).toEqual({ admitted: false, reason: 'run-cap' });
  });

  it('refuses when a period budget scope cannot cover the estimate', async () => {
    const walletId = await seedWallet(10_000_000_000n);
    const scope = {
      scopeId: `member:${crypto.randomUUID()}:2026-07`,
      remainingNanoUsd: 50_000_000n,
    };
    const decision = await decide({ redis, db, stores }, request(walletId, { budgets: [scope] }));
    expect(decision).toEqual({ admitted: false, reason: 'budget-exceeded' });
  });

  it('counts racing holds against a shared budget scope atomically', async () => {
    const scopeId = `member:${crypto.randomUUID()}:2026-07`;
    const walletIds = await Promise.all([
      seedWallet(10_000_000_000n),
      seedWallet(10_000_000_000n),
      seedWallet(10_000_000_000n),
    ]);
    const deps = { redis, db, stores };
    const decisions = await Promise.all(
      walletIds.map((walletId) =>
        admitRun(
          deps,
          request(walletId, { budgets: [{ scopeId, remainingNanoUsd: 250_000_000n }] })
        )
      )
    );
    const admitted = decisions.filter((d) => d._unsafeUnwrap().admitted);
    expect(admitted).toHaveLength(2);
    await redis.del(BILLING_KEYS.scopeHolds.buildKey(scopeId));
  });

  it('blocks paid admission on a negative balance', async () => {
    const walletId = await seedWallet(-1n);
    const decision = await decide({ redis, db, stores }, request(walletId));
    expect(decision).toEqual({ admitted: false, reason: 'insufficient-balance' });
  });

  it('bootstraps the snapshot from Postgres on a miss, carrying the wallet type', async () => {
    const walletId = await seedWallet(1_000_000_000n, 7n);
    const decision = await decide({ redis, db, stores }, request(walletId));
    expect(decision.admitted).toBe(true);
    const stored = await redis.get<{ balanceNanoUsd: string; ledgerSeq: number; type: string }>(
      BILLING_KEYS.walletSnapshot.buildKey(walletId)
    );
    expect(stored?.balanceNanoUsd).toBe('1000000000');
    expect(stored?.ledgerSeq).toBe(7);
    expect(stored?.type).toBe('purchased');
  });

  it('fails closed with a typed error when Redis is down', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const result = await admitRun({ redis: deadRedis, db, stores }, request(walletId));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('ignores expired holds when summing reservations', async () => {
    const walletId = await seedWallet(150_000_000n);
    const deps = { redis, db, stores };
    const first = await decide(deps, request(walletId));
    expect(first.admitted).toBe(true);
    const afterExpiry = new Date(NOW.getTime() + (300 + HOLD_TTL_MARGIN_SECONDS) * 1000 + 1);
    const second = await decide(deps, request(walletId, { now: afterExpiry }));
    expect(second.admitted).toBe(true);
  });
});

describe('free-tier admission (allowance as budget, balance check derived from wallet type)', () => {
  it('admits a zero-balance free wallet against its allowance scope', async () => {
    const walletId = await seedWallet(0n, 0n, 'free');
    const scopeId = `allowance:${walletId}:2026-07-03`;
    const decision = await decide(
      { redis, db, stores },
      request(walletId, { budgets: [{ scopeId, remainingNanoUsd: 150_000_000n }] })
    );
    expect(decision.admitted).toBe(true);
    await redis.del(BILLING_KEYS.scopeHolds.buildKey(scopeId));
  });

  it('fails closed to the balance check when a cached snapshot carries no wallet type', async () => {
    const walletId = await seedWallet(0n, 0n, 'free');
    await redis.set(
      BILLING_KEYS.walletSnapshot.buildKey(walletId),
      JSON.stringify({ balanceNanoUsd: '0', ledgerSeq: 0 })
    );
    const scopeId = `allowance:${walletId}:2026-07-03`;
    const decision = await decide(
      { redis, db, stores },
      request(walletId, { budgets: [{ scopeId, remainingNanoUsd: 150_000_000n }] })
    );
    expect(decision).toEqual({ admitted: false, reason: 'insufficient-balance' });
    await redis.del(BILLING_KEYS.scopeHolds.buildKey(scopeId));
  });
});

describe('admitRun input and defect handling', () => {
  it('returns not_found for a wallet that does not exist', async () => {
    const result = await admitRun({ redis, db, stores }, request(crypto.randomUUID()));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('rejects a non-positive estimate as a caller bug', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    expect(() =>
      admitRun({ redis, db, stores }, request(walletId, { estimateNanoUsd: 0n }))
    ).toThrow(/estimate must be positive/);
  });

  it('rejects a non-positive deadline as a caller bug', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    expect(() =>
      admitRun({ redis, db, stores }, request(walletId, { deadlineSeconds: 0 }))
    ).toThrow(/deadline must be positive/);
  });

  it('admits at the deadline that exactly fills the hold-TTL ceiling', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const deadlineSeconds = MAX_HOLD_TTL_SECONDS - HOLD_TTL_MARGIN_SECONDS;
    const decision = await decide({ redis, db, stores }, request(walletId, { deadlineSeconds }));
    expect(decision.admitted).toBe(true);
  });

  it('rejects a deadline whose hold TTL would exceed the registry ceiling', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const deadlineSeconds = MAX_HOLD_TTL_SECONDS - HOLD_TTL_MARGIN_SECONDS + 1;
    const result = await admitRun({ redis, db, stores }, request(walletId, { deadlineSeconds }));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces an unknown script outcome as unavailable', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const fakeRedis = {
      createScript: () => ({ exec: () => Promise.resolve('garbage') }),
    } as unknown as typeof redis;
    const result = await admitRun({ redis: fakeRedis, db, stores }, request(walletId));
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('fails when the snapshot bootstrap does not stick', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const fakeRedis = {
      createScript: (source: string) => ({
        // The admission script keeps missing its snapshot; the CAS "works".
        exec: () => Promise.resolve(source.includes('no-snapshot') ? 'no-snapshot' : 1),
      }),
    } as unknown as typeof redis;
    const result = await admitRun({ redis: fakeRedis, db, stores }, request(walletId));
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('releaseHold', () => {
  it('frees the reserved capacity for the next run', async () => {
    const walletId = await seedWallet(150_000_000n);
    const deps = { redis, db, stores };
    const req = request(walletId);
    const first = await decide(deps, req);
    expect(first.admitted).toBe(true);
    const released = await releaseHold(redis, {
      walletId,
      holdId: req.holdId,
      scopeIds: [`member:${walletId}:2026-07`],
    });
    released._unsafeUnwrap();
    const second = await decide(deps, request(walletId));
    expect(second.admitted).toBe(true);
  });
});

describe('writeThroughSnapshot', () => {
  it('writes a newer snapshot and reports it', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const written = await snapshotWritten(walletId, 900_000_000n, 1n);
    expect(written).toBe(true);
  });

  it('CASes on the ledger sequence — an older write can never regress the snapshot', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    await snapshotWritten(walletId, 800_000_000n, 5n);
    const stale = await snapshotWritten(walletId, 999_000_000n, 4n);
    expect(stale).toBe(false);
    const stored = await redis.get<{ balanceNanoUsd: string; ledgerSeq: number }>(
      BILLING_KEYS.walletSnapshot.buildKey(walletId)
    );
    expect(stored?.balanceNanoUsd).toBe('800000000');
    expect(stored?.ledgerSeq).toBe(5);
  });
});

describe('refreshWalletSnapshot (post-settlement write-through)', () => {
  it('reads the committed wallet and writes the snapshot through', async () => {
    const walletId = await seedWallet(700_000_000n, 3n);
    // A stale cached snapshot from admission time must be superseded.
    await snapshotWritten(walletId, 1_000_000_000n, 2n);
    const refreshed = await refreshWalletSnapshot({ redis, db, stores }, walletId);
    refreshed._unsafeUnwrap();
    const stored = await redis.get<{ balanceNanoUsd: string; ledgerSeq: number; type: string }>(
      BILLING_KEYS.walletSnapshot.buildKey(walletId)
    );
    expect(stored?.balanceNanoUsd).toBe('700000000');
    expect(stored?.ledgerSeq).toBe(3);
    expect(stored?.type).toBe('purchased');
  });

  it('never regresses a newer snapshot (CAS on the ledger sequence)', async () => {
    const walletId = await seedWallet(700_000_000n, 3n);
    await snapshotWritten(walletId, 500_000_000n, 9n);
    const refreshed = await refreshWalletSnapshot({ redis, db, stores }, walletId);
    refreshed._unsafeUnwrap();
    const stored = await redis.get<{ balanceNanoUsd: string; ledgerSeq: number }>(
      BILLING_KEYS.walletSnapshot.buildKey(walletId)
    );
    expect(stored?.ledgerSeq).toBe(9);
  });

  it('fails with not_found for a wallet that does not exist', async () => {
    const result = await refreshWalletSnapshot(
      { redis, db, stores },
      '00000000-0000-0000-0000-000000000001'
    );
    expect(result.isErr()).toBe(true);
  });
});
