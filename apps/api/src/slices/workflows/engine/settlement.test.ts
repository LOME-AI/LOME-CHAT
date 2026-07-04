import { describe, expect, it } from 'vitest';
import { applyMarkup } from '../../billing/index.js';
import { runSettlement } from '../../../lib/idempotency/index.js';
import {
  SettlementCompletionError,
  SettlementFenceLost,
  createChargingCommit,
  createFencedSettlementHook,
  keyRowCompletion,
} from './settlement.js';
import type { SettlementHook, SettlementRequest } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { KeyRowFence, SettlementTx } from '../../../lib/idempotency/index.js';
import type { BillingStores, ChargeInput } from '../../billing/index.js';
import type { KeyRowCompletion, SettlementCommit } from './settlement.js';

/**
 * In-memory settlement world modeling the transactional invariants the real
 * Postgres enforces: `db.transaction` snapshots and commits-or-discards
 * atomically; the usage records enforce the unique charge key; the key-row
 * fence lives in the same world so its flip commits with the charges.
 */
interface Leg {
  readonly transactionId: string;
  readonly amountNanoUsd: bigint;
}

interface World {
  wallet: { id: string; type: 'purchased'; balanceNanoUsd: bigint; ledgerSeq: bigint };
  usage: Map<string, string>;
  legs: Leg[];
  keyRow: { status: 'claimed' | 'succeeded'; claimedBy: string; claims: number };
}

function makeWorld(): World {
  return {
    wallet: { id: 'w1', type: 'purchased', balanceNanoUsd: 1000n, ledgerSeq: 0n },
    usage: new Map(),
    legs: [],
    keyRow: { status: 'claimed', claimedBy: 'exec-A', claims: 1 },
  };
}

function cloneWorld(world: World): World {
  return {
    wallet: { ...world.wallet },
    usage: new Map(world.usage),
    legs: [...world.legs],
    keyRow: { ...world.keyRow },
  };
}

function worldOf(tx: SettlementTx): World {
  return (tx as unknown as { __world: World }).__world;
}

function makeDb(world: World): Database {
  return {
    transaction: async (body: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const staged = cloneWorld(world);
      const result = await body({ __world: staged });
      Object.assign(world, staged);
      return result;
    },
  } as unknown as Database;
}

function makeStores(): BillingStores {
  return {
    lockWalletWithinTx: (tx: SettlementTx) => Promise.resolve(worldOf(tx).wallet),
    insertUsageRecordIfAbsentWithinTx: (tx: SettlementTx, input: ChargeInput) => {
      const usage = worldOf(tx).usage;
      const existing = usage.get(input.idempotencyKey);
      if (existing !== undefined) return Promise.resolve({ id: existing, created: false });
      const id = `usage-${String(usage.size)}`;
      usage.set(input.idempotencyKey, id);
      return Promise.resolve({ id, created: true });
    },
    insertLedgerLegsWithinTx: (tx: SettlementTx, legs: readonly Leg[]) => {
      worldOf(tx).legs.push(
        ...legs.map((leg) => ({
          transactionId: leg.transactionId,
          amountNanoUsd: leg.amountNanoUsd,
        }))
      );
      return Promise.resolve();
    },
    updateWalletBalanceWithinTx: (
      tx: SettlementTx,
      _walletId: string,
      balanceNanoUsd: bigint,
      ledgerSeq: bigint
    ) => {
      const wallet = worldOf(tx).wallet;
      wallet.balanceNanoUsd = balanceNanoUsd;
      wallet.ledgerSeq = ledgerSeq;
      return Promise.resolve();
    },
    addSpendingWithinTx: () => Promise.resolve(),
  } as unknown as BillingStores;
}

function makeComplete(): KeyRowCompletion {
  return (tx, fence) => {
    const row = worldOf(tx).keyRow;
    if (
      row.status === 'claimed' &&
      row.claimedBy === fence.executorId &&
      row.claims === fence.claims
    ) {
      row.status = 'succeeded';
      return Promise.resolve('flipped');
    }
    return Promise.resolve('lost');
  };
}

function chargeInput(key: string): ChargeInput {
  return {
    walletId: 'w1',
    userId: 'u1',
    runId: 'run-1',
    contentItemId: 'c1',
    modelCatalogId: 'm1',
    modality: 'text',
    baseCostNanoUsd: 100n,
    isEstimated: true,
    idempotencyKey: key,
    now: new Date(0),
  };
}

const FENCE_A: KeyRowFence = { id: 'key-1', executorId: 'exec-A', claims: 1 };
const REQUEST: SettlementRequest = { runKey: 'key-1', outputs: {} };

function hookFor(
  world: World,
  fence: KeyRowFence,
  charges: readonly ChargeInput[],
  commitOverride?: SettlementCommit
): SettlementHook {
  return createFencedSettlementHook({
    db: makeDb(world),
    fence,
    complete: makeComplete(),
    commit:
      commitOverride ?? createChargingCommit({ stores: makeStores(), chargesFor: () => charges }),
  });
}

function txnSums(legs: readonly Leg[]): bigint[] {
  const totals = new Map<string, bigint>();
  for (const leg of legs) {
    totals.set(leg.transactionId, (totals.get(leg.transactionId) ?? 0n) + leg.amountNanoUsd);
  }
  return [...totals.values()];
}

describe('createFencedSettlementHook — the settlement plumbing', () => {
  it('settles once via chargeWithinTx: zero-sum ledger, wallet debited, key flipped', async () => {
    const world = makeWorld();
    await hookFor(world, FENCE_A, [chargeInput('run-1:answer')])(REQUEST);
    expect(world.usage.size).toBe(1);
    expect(world.legs).toHaveLength(2);
    expect(txnSums(world.legs)).toEqual([0n]);
    expect(world.wallet.balanceNanoUsd).toBe(1000n - applyMarkup(100n));
    expect(world.keyRow.status).toBe('succeeded');
  });

  it('posts every charge input through chargeWithinTx, each zero-sum', async () => {
    const world = makeWorld();
    await hookFor(world, FENCE_A, [chargeInput('run-1:a'), chargeInput('run-1:b')])(REQUEST);
    expect(world.usage.size).toBe(2);
    expect(world.legs).toHaveLength(4);
    expect(txnSums(world.legs)).toEqual([0n, 0n]);
  });

  it('charges exactly once when the same settlement replays', async () => {
    const world = makeWorld();
    const stores = makeStores();
    const commit = createChargingCommit({
      stores,
      chargesFor: () => [chargeInput('run-1:answer')],
    });
    const settle = (): Promise<void> =>
      createFencedSettlementHook({
        db: makeDb(world),
        fence: FENCE_A,
        complete: makeComplete(),
        commit,
      })(REQUEST);
    await settle();
    await expect(settle()).rejects.toBeInstanceOf(SettlementFenceLost);
    expect(world.usage.size).toBe(1);
    expect(world.legs).toHaveLength(2);
    expect(world.wallet.balanceNanoUsd).toBe(1000n - applyMarkup(100n));
  });

  it('settles once under a superseding lease-expired retry; the stale claimant loses the fence', async () => {
    const world = makeWorld();
    world.keyRow = { status: 'claimed', claimedBy: 'exec-B', claims: 2 };
    const stale = hookFor(world, FENCE_A, [chargeInput('run-1:answer')]);
    await expect(stale(REQUEST)).rejects.toBeInstanceOf(SettlementFenceLost);
    expect(world.legs).toHaveLength(0);
    const fresh = hookFor(world, { id: 'key-1', executorId: 'exec-B', claims: 2 }, [
      chargeInput('run-1:answer'),
    ]);
    await fresh(REQUEST);
    expect(world.usage.size).toBe(1);
    expect(world.legs).toHaveLength(2);
    expect(txnSums(world.legs)).toEqual([0n]);
  });

  it('rolls back a crash between charging and the fence flip; a clean retry charges once', async () => {
    const world = makeWorld();
    const crashing: SettlementCommit = async (tx, request) => {
      await createChargingCommit({
        stores: makeStores(),
        chargesFor: () => [chargeInput('run-1:answer')],
      })(tx, request);
      throw new Error('deploy killed the run');
    };
    const crashHook = hookFor(world, FENCE_A, [], crashing);
    await expect(crashHook(REQUEST)).rejects.toThrow('deploy killed the run');
    expect(world.legs).toHaveLength(0);
    expect(world.keyRow.status).toBe('claimed');
    await hookFor(world, FENCE_A, [chargeInput('run-1:answer')])(REQUEST);
    expect(world.usage.size).toBe(1);
    expect(world.legs).toHaveLength(2);
  });

  it('commits nothing when the run was cancelled out from under the settlement', async () => {
    const world = makeWorld();
    world.keyRow = { status: 'claimed', claimedBy: 'cancelled-elsewhere', claims: 1 };
    await expect(
      hookFor(world, FENCE_A, [chargeInput('run-1:answer')])(REQUEST)
    ).rejects.toBeInstanceOf(SettlementFenceLost);
    expect(world.legs).toHaveLength(0);
    expect(world.usage.size).toBe(0);
  });
});

/**
 * Runs keyRowCompletion against a fake writer chain — succeedKeyRow only
 * touches update→set→where→returning. The SettlementTx handle is minted by
 * the real `runSettlement` (never cast), so the fence writes on a genuinely
 * branded transaction.
 */
function completeVia(returning: () => Promise<unknown>): Promise<'flipped' | 'lost'> {
  const db = {
    transaction: (body: (tx: unknown) => Promise<'flipped' | 'lost'>) =>
      body({ update: () => ({ set: () => ({ where: () => ({ returning }) }) }) }),
  } as unknown as Database;
  return runSettlement(db, (tx) => keyRowCompletion('response')(tx, FENCE_A));
}

describe('keyRowCompletion — the production fence over succeedKeyRow', () => {
  it('flips when the fenced update matches its row', async () => {
    await expect(completeVia(() => Promise.resolve([{ id: 'key-1' }]))).resolves.toBe('flipped');
  });

  it('reports lost when the fence matches no row (a zombie claimant)', async () => {
    await expect(completeVia(() => Promise.resolve([]))).resolves.toBe('lost');
  });

  it('throws a SettlementCompletionError when the key-row store is unavailable', async () => {
    await expect(
      completeVia(() => Promise.reject(new Error('db unavailable')))
    ).rejects.toBeInstanceOf(SettlementCompletionError);
  });
});
