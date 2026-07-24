import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { inArray } from 'drizzle-orm';
import { spendableFundsNanoUsd } from '@hushbox/shared';
import { LOCAL_NEON_DEV_CONFIG, createDb, users, wallets } from '@hushbox/db';
import { sweepLeakedTestWallets } from '../__tests__/orphan-wallet-sweep.js';
import { createBillingStores } from '../adapters/stores.js';
import { BILLING_KEYS } from './keys.js';
import { admitRun } from './admission.js';
import { conversationBudgetScopeId, memberBudgetScopeId } from './budget-resolution.js';
import {
  holdReadoutAt,
  readActiveHolds,
  readBudgetScopeHolds,
  readSpendable,
} from './spendable.js';
import type { AdmissionDeps } from './admission.js';
import type { BudgetScopeHoldRef, SpendableView } from './spendable.js';
import type { WalletType } from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for spendable tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const deadRedis = new Redis({ url: 'http://localhost:1', token: 'token', retry: false });
const stores = createBillingStores();
const deps: AdmissionDeps = { redis, db, stores };
const NOW = new Date('2026-07-03T12:00:00Z');
const RUN_CAP = 5;

const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdWalletIds: string[] = [];

async function createUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const rows = await db
    .insert(users)
    .values({
      email: `spend${suffix}@spendable.test`,
      username: `spend${suffix}`,
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

async function seedWallet(
  userId: string,
  balanceNanoUsd: bigint,
  type: WalletType = 'purchased'
): Promise<string> {
  const rows = await db
    .insert(wallets)
    .values({ userId, type, balanceNanoUsd, ledgerSeq: 0n })
    .returning({ id: wallets.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('wallet seed failed');
  createdWalletIds.push(id);
  return id;
}

async function view(userId: string): Promise<SpendableView> {
  const result = await readSpendable(deps, { userId, now: NOW });
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
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('readActiveHolds', () => {
  it('sums active holds per key', async () => {
    const key = BILLING_KEYS.walletHolds.buildKey(`ah-${crypto.randomUUID()}`);
    const active = String(NOW.getTime() + 60_000);
    await redis.hset(key, { a: `100:${active}`, b: `250:${active}` });
    const result = await readActiveHolds(redis, [key], NOW);
    expect(result._unsafeUnwrap()).toEqual([{ heldNanoUsd: 350n }]);
    await redis.del(key);
  });

  it('prunes expired holds on read and excludes them from the sum', async () => {
    const key = BILLING_KEYS.walletHolds.buildKey(`ah-${crypto.randomUUID()}`);
    await redis.hset(key, {
      live: `100:${String(NOW.getTime() + 60_000)}`,
      gone: `900:${String(NOW.getTime() - 1)}`,
    });
    const result = await readActiveHolds(redis, [key], NOW);
    expect(result._unsafeUnwrap()).toEqual([{ heldNanoUsd: 100n }]);
    expect(await redis.hgetall(key)).toEqual({ live: `100:${String(NOW.getTime() + 60_000)}` });
    await redis.del(key);
  });

  it('reads an absent hash as zero holds', async () => {
    const key = BILLING_KEYS.walletHolds.buildKey(`ah-${crypto.randomUUID()}`);
    const result = await readActiveHolds(redis, [key], NOW);
    expect(result._unsafeUnwrap()).toEqual([{ heldNanoUsd: 0n }]);
  });

  it('reads multiple keys in one round trip, pairing each key with its own readout', async () => {
    const first = BILLING_KEYS.scopeHolds.buildKey(`ah-${crypto.randomUUID()}`);
    const second = BILLING_KEYS.scopeHolds.buildKey(`ah-${crypto.randomUUID()}`);
    await redis.hset(first, { a: `7:${String(NOW.getTime() + 60_000)}` });
    const result = await readActiveHolds(redis, [first, second], NOW);
    expect(result._unsafeUnwrap()).toEqual([{ heldNanoUsd: 7n }, { heldNanoUsd: 0n }]);
    await redis.del(first);
  });

  it('answers an empty key list without touching Redis', async () => {
    const result = await readActiveHolds(deadRedis, [], NOW);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('fails closed with a typed unavailable error when Redis is down', async () => {
    const result = await readActiveHolds(deadRedis, ['billing:admission:wallet:x'], NOW);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('readBudgetScopeHolds', () => {
  it('reads the member and conversation scope holds admission places, one readout per ref in order', async () => {
    const memberId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const userId = await createUser();
    const walletId = await seedWallet(userId, 10_000_000_000n);
    const estimate = 300_000_000n;
    const memberScopeKey = BILLING_KEYS.scopeHolds.buildKey(memberBudgetScopeId(memberId));
    const conversationScopeKey = BILLING_KEYS.scopeHolds.buildKey(
      conversationBudgetScopeId(conversationId)
    );

    const admitted = await admitRun(deps, {
      walletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: estimate,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: [
        { scopeId: memberBudgetScopeId(memberId), remainingNanoUsd: 1_000_000_000n },
        { scopeId: conversationBudgetScopeId(conversationId), remainingNanoUsd: 2_000_000_000n },
      ],
      now: NOW,
    });
    expect(admitted._unsafeUnwrap().admitted).toBe(true);

    const result = await readBudgetScopeHolds(
      redis,
      [
        { scope: 'member', memberId },
        { scope: 'conversation', conversationId },
      ],
      NOW
    );
    expect(result._unsafeUnwrap()).toEqual([{ heldNanoUsd: estimate }, { heldNanoUsd: estimate }]);
    await redis.del(memberScopeKey, conversationScopeKey);
  });

  it('issues exactly one Redis script exec regardless of the number of scopes', async () => {
    let execs = 0;
    // A counting seam over the real client: Redis is a true external seam, so
    // instrumenting the script path (not any internal slice) is legitimate.
    const counting = {
      createScript: (source: string) => {
        const script = redis.createScript(source);
        return {
          exec: (keys: string[], args: string[]): Promise<unknown> => {
            execs += 1;
            return script.exec(keys, args);
          },
        };
      },
    } as unknown as typeof redis;

    const scopes: BudgetScopeHoldRef[] = [
      { scope: 'conversation', conversationId: crypto.randomUUID() },
      { scope: 'member', memberId: crypto.randomUUID() },
      { scope: 'member', memberId: crypto.randomUUID() },
    ];
    const result = await readBudgetScopeHolds(counting, scopes, NOW);
    expect(result._unsafeUnwrap()).toHaveLength(3);
    expect(execs).toBe(1);
  });

  it('fails closed with a typed unavailable error when Redis is down', async () => {
    const result = await readBudgetScopeHolds(
      deadRedis,
      [{ scope: 'member', memberId: crypto.randomUUID() }],
      NOW
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('holdReadoutAt', () => {
  it('returns the readout at the index', () => {
    expect(holdReadoutAt([{ heldNanoUsd: 5n }], 0)).toEqual({ heldNanoUsd: 5n });
  });

  it('throws on a missing readout — a defect, never a legal state', () => {
    expect(() => holdReadoutAt([], 0)).toThrow('holds readout missing');
  });
});

describe('readSpendable', () => {
  it('serves the exact effectiveSpendable minus held sum admission gates with under an active hold', async () => {
    const balance = 2_000_000_000n; // $2
    const estimate = 700_000_000n; // $0.70 hold
    const userId = await createUser();
    const walletId = await seedWallet(userId, balance);
    const admitted = await admitRun(deps, {
      walletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: estimate,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: [],
      now: NOW,
    });
    expect(admitted._unsafeUnwrap().admitted).toBe(true);

    const served = await view(userId);
    expect(served.spendableNanoUsd).toBe(spendableFundsNanoUsd(balance, 'paid') - estimate);
    expect(served.heldNanoUsd).toBe(estimate);
    expect(Object.keys(served).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'heldNanoUsd',
      'spendableNanoUsd',
    ]);

    // Behavioral pin: the served number IS the admission gate — an estimate of
    // exactly the served spendable admits, one nano more refuses.
    const gateAt = await admitRun(deps, {
      walletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: served.spendableNanoUsd + 1n,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: [],
      now: NOW,
    });
    expect(gateAt._unsafeUnwrap()).toEqual({ admitted: false, reason: 'insufficient-balance' });
    const gateWithin = await admitRun(deps, {
      walletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: served.spendableNanoUsd,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: [],
      now: NOW,
    });
    expect(gateWithin._unsafeUnwrap().admitted).toBe(true);
  });

  it('prunes expired holds on read and serves the full spendable', async () => {
    const balance = 1_000_000_000n;
    const userId = await createUser();
    const walletId = await seedWallet(userId, balance);
    const holdsKey = BILLING_KEYS.walletHolds.buildKey(walletId);
    await redis.hset(holdsKey, { stale: `400000000:${String(NOW.getTime() - 1)}` });

    const served = await view(userId);
    expect(served.heldNanoUsd).toBe(0n);
    expect(served.spendableNanoUsd).toBe(spendableFundsNanoUsd(balance, 'paid'));
    // The prune deleted the only field, so the hash itself is gone.
    expect(await redis.hgetall(holdsKey)).toBeNull();
  });

  it('serves a negative spendable for an overdrawn wallet instead of clamping', async () => {
    const balance = -600_000_000n; // beyond the $0.50 cushion
    const userId = await createUser();
    const walletId = await seedWallet(userId, balance);

    const served = await view(userId);
    expect(served.spendableNanoUsd).toBe(spendableFundsNanoUsd(balance, 'paid'));
    expect(served.spendableNanoUsd < 0n).toBe(true);
    expect(await redis.exists(BILLING_KEYS.walletSnapshot.buildKey(walletId))).toBe(1);
  });

  it('answers not_found for a user without a purchased wallet', async () => {
    const userId = await createUser();
    const result = await readSpendable(deps, { userId, now: NOW });
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('fails closed with a typed unavailable error when Redis is down', async () => {
    const userId = await createUser();
    await seedWallet(userId, 1_000_000_000n);
    const result = await readSpendable({ redis: deadRedis, db, stores }, { userId, now: NOW });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
