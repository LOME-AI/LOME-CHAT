import { Redis } from '@upstash/redis';
import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  createDb,
  idempotencyKeys,
  ledgerEntries,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory, walletFactory } from '@hushbox/db/factories';
import { eq, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { ADMIN_OP_CONTRACTS, ADMIN_WALLET_ADJUSTMENT_CAP_NANO_USD } from '@hushbox/shared';
import { runSettlement } from '../../../../lib/idempotency/index.js';
import { createBillingStores, runConservationAudit } from '../../../billing/index.js';
import { BILLING_KEYS } from '../../../billing/domain/keys.js';
import { createAdminStores } from '../../adapters/stores.js';
import { createAdminOpEngine } from '../engine.js';
import { createAdminOpRegistry } from '../registry.js';
import { describeAdminOp, seededRng } from '../describe-admin-op.js';
import { adminWalletOperations } from './index.js';
import type { LedgerLegInput } from '../../../billing/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { Variables } from '../../../../lib/context/index.js';
import type { AdminOpEngineHooks } from '../engine.js';
import type {
  AdminOpHarnessInstance,
  AdminOpInterleavingAction,
  AdminOpInterleavingConfig,
  SeededRng,
} from '../describe-admin-op.js';
import type { AdminWalletDeps } from './wallet.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and Redis env are required for admin wallet op tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const billingStores = createBillingStores();
const adminStores = createAdminStores();

const CREDIT_CONTRACT = ADMIN_OP_CONTRACTS['wallet.credit'];
const CLAWBACK_CONTRACT = ADMIN_OP_CONTRACTS['wallet.clawback'];

const snapshotWalletIds: string[] = [];

afterAll(async () => {
  // admin_audit is append-only by trigger — audit rows stay (actor-isolated);
  // the ledger/wallet rows stay too (balanced, uuid-isolated). Only the
  // engine-claim key rows and Redis snapshot keys are removed.
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/wallet.%'));
  for (const walletId of snapshotWalletIds) {
    await redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId));
  }
});

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    emitMetric: noop,
    captureError: noop,
  };
}

interface SnapshotProbeState {
  readonly log: string[];
  armed: boolean;
}

/**
 * The battery's ephemeral seam: a narrow Redis facade that delegates the
 * snapshot CAS script to the real client while recording each landed write
 * and honoring the armed-failure probe. Cast is safe — `writeThroughSnapshot`
 * touches only `createScript(...).exec(...)`.
 */
function probeRedis(state: SnapshotProbeState): Variables['redis'] {
  const facade = {
    createScript: (script: string) => ({
      exec: async (keys: string[], args: string[]): Promise<unknown> => {
        if (state.armed) throw new Error('snapshot probe armed to fail');
        const result = await redis.createScript(script).exec(keys, args);
        state.log.push(keys[0] ?? '');
        return result;
      },
    }),
  };
  return facade as unknown as Variables['redis'];
}

interface WalletHarness extends AdminOpHarnessInstance {
  readonly walletId: string;
  readonly userId: string;
}

async function createWalletHarness(
  options: { hooks?: AdminOpEngineHooks } = {}
): Promise<WalletHarness> {
  const [user] = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  if (user === undefined) throw new Error('wallet harness: user insert returned no row');
  const [wallet] = await db
    .insert(wallets)
    .values(walletFactory.build({ userId: user.id }))
    .returning({ id: wallets.id });
  if (wallet === undefined) throw new Error('wallet harness: wallet insert returned no row');
  snapshotWalletIds.push(wallet.id);
  const actor = `admin-wallet-test-${crypto.randomUUID()}@hushbox.ai`;
  const probe: SnapshotProbeState = { log: [], armed: false };
  const deps: AdminWalletDeps = { billingStores, redis: probeRedis(probe) };
  const engine = createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<AdminWalletDeps>([...adminWalletOperations]),
    stores: adminStores,
    telemetry: noopTelemetry(),
    opDeps: deps,
    executorId: `admin-wallet-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    engine,
    actor,
    walletId: wallet.id,
    userId: user.id,
    projection: async (): Promise<{ balanceNanoUsd: string }> => {
      const rows = await db
        .select({ balanceNanoUsd: wallets.balanceNanoUsd })
        .from(wallets)
        .where(eq(wallets.id, wallet.id));
      const balance = rows[0]?.balanceNanoUsd;
      if (balance === undefined) throw new Error('wallet harness: projection wallet is gone');
      return { balanceNanoUsd: balance.toString(10) };
    },
    auditCount: async (): Promise<number> => {
      const rows = await db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actor, actor));
      return rows.length;
    },
    ephemeral: {
      log: () => probe.log,
      armFailure: () => {
        probe.armed = true;
      },
    },
  };
}

function walletOf(harness: AdminOpHarnessInstance): string {
  return (harness as WalletHarness).walletId;
}

/** A seeded, always-feasible user money movement (settlement is unguarded —
 * negative balances are legal, so control and op runs never diverge on
 * feasibility). */
async function postUserAdjustment(
  walletId: string,
  signedAmountNanoUsd: bigint,
  kind: LedgerLegInput['kind'],
  houseAccount: NonNullable<LedgerLegInput['houseAccount']>
): Promise<void> {
  await runSettlement(db, async (tx) => {
    const wallet = await billingStores.lockWalletWithinTx(tx, walletId);
    const balanceAfter = wallet.balanceNanoUsd + signedAmountNanoUsd;
    const transactionId = crypto.randomUUID();
    await billingStores.insertLedgerLegsWithinTx(tx, [
      {
        transactionId,
        kind,
        amountNanoUsd: signedAmountNanoUsd,
        balanceAfterNanoUsd: balanceAfter,
        walletId,
        idempotencyKey: `admin-wallet-test:${transactionId}:user`,
      },
      {
        transactionId,
        kind,
        amountNanoUsd: -signedAmountNanoUsd,
        houseAccount,
        idempotencyKey: `admin-wallet-test:${transactionId}:house`,
      },
    ]);
    await billingStores.updateWalletBalanceWithinTx(
      tx,
      walletId,
      balanceAfter,
      wallet.ledgerSeq + 1n
    );
  });
}

function seededAmountNanoUsd(rng: SeededRng): bigint {
  return (BigInt(Math.floor(rng() * 1_000_000)) + 1n) * 1000n;
}

const interleavingActions: readonly AdminOpInterleavingAction[] = [
  {
    name: 'user-spend',
    run: (harness, rng) =>
      postUserAdjustment(walletOf(harness), -seededAmountNanoUsd(rng), 'charge', 'revenue'),
  },
  {
    name: 'user-top-up',
    run: (harness, rng) =>
      postUserAdjustment(walletOf(harness), seededAmountNanoUsd(rng), 'deposit', 'payments-in'),
  },
];

/** Conservation post-condition, scoped to the harness wallet so unrelated
 * suite residue can never fail (or mask) this assertion. */
async function assertConservationCleanFor(walletId: string): Promise<void> {
  const audit = await runConservationAudit(billingStores, db);
  const findings = audit._unsafeUnwrap();
  expect(findings.walletDrift.filter((entry) => entry.walletId === walletId)).toEqual([]);
  const legs = await db
    .select({ transactionId: ledgerEntries.transactionId })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.walletId, walletId));
  const mine = new Set(legs.map((leg) => leg.transactionId));
  expect(findings.unbalancedTransactions.filter((entry) => mine.has(entry.transactionId))).toEqual(
    []
  );
}

function interleavingConfig(): AdminOpInterleavingConfig {
  return {
    seeds: [11, 29, 47],
    stepsPerSeed: 6,
    opInput: (harness) => ({
      walletId: walletOf(harness),
      amountNanoUsd: '7000000000',
      reason: `interleaving adjustment ${crypto.randomUUID()}`,
    }),
    actions: interleavingActions,
    afterRun: (harness) => assertConservationCleanFor(walletOf(harness)),
  };
}

const creditTarget = { walletId: '' };
describeAdminOp({
  contract: CREDIT_CONTRACT,
  createHarness: async (options) => {
    const harness = await createWalletHarness(options);
    creditTarget.walletId = harness.walletId;
    return harness;
  },
  validInput: () => ({
    walletId: creditTarget.walletId,
    amountNanoUsd: '5000000000',
    reason: `goodwill credit ${crypto.randomUUID()}`,
  }),
  invalidInput: { walletId: 'not-a-uuid', amountNanoUsd: '5000000000', reason: 'x' },
  overGuardrailInput: () => ({
    walletId: creditTarget.walletId,
    amountNanoUsd: (ADMIN_WALLET_ADJUSTMENT_CAP_NANO_USD + 1n).toString(10),
    reason: 'over the cap',
  }),
  hasEphemeralEffects: true,
  interleaving: interleavingConfig(),
});

const clawbackTarget = { walletId: '' };
describeAdminOp({
  contract: CLAWBACK_CONTRACT,
  createHarness: async (options) => {
    const harness = await createWalletHarness(options);
    clawbackTarget.walletId = harness.walletId;
    return harness;
  },
  validInput: () => ({
    walletId: clawbackTarget.walletId,
    amountNanoUsd: '3000000000',
    reason: `erroneous grant reversal ${crypto.randomUUID()}`,
  }),
  invalidInput: { walletId: 'not-a-uuid', amountNanoUsd: '3000000000', reason: 'x' },
  overGuardrailInput: () => ({
    walletId: clawbackTarget.walletId,
    amountNanoUsd: (ADMIN_WALLET_ADJUSTMENT_CAP_NANO_USD + 1n).toString(10),
    reason: 'over the cap',
  }),
  hasEphemeralEffects: true,
  interleaving: interleavingConfig(),
});

async function executeOk(
  harness: WalletHarness,
  name: string,
  input: Record<string, unknown>,
  undoes?: string
): Promise<{ auditId: string; inverseInput: Record<string, unknown> | null }> {
  const result = await harness.engine.run({
    name,
    input,
    actor: harness.actor,
    mode: 'execute',
    idempotencyKey: crypto.randomUUID(),
    ...(undoes === undefined ? {} : { undoes }),
  });
  return result._unsafeUnwrap();
}

describe('wallet.credit / wallet.clawback money semantics', () => {
  it('registers as an inverse pair — the Iron Law gate accepts the pair, rejects a lone credit', () => {
    const registry = createAdminOpRegistry<AdminWalletDeps>([...adminWalletOperations]);

    expect(registry.list().map((contract) => contract.name)).toEqual([
      'wallet.clawback',
      'wallet.credit',
    ]);
    expect(registry.get('wallet.credit')?.contract.inverse).toBe('wallet.clawback');
    expect(registry.get('wallet.clawback')?.contract.inverse).toBe('wallet.credit');

    const loneCredit = adminWalletOperations.filter(
      (operation) => operation.contract.name === 'wallet.credit'
    );
    expect(() => createAdminOpRegistry<AdminWalletDeps>(loneCredit)).toThrow(
      /Reversibility Iron Law/
    );
  });

  it('never double-posts a re-executed transaction (leg-unique false-return path)', async () => {
    const harness = await createWalletHarness();
    const input = {
      walletId: harness.walletId,
      amountNanoUsd: '5000000000',
      reason: 'exactly-once probe',
    };

    await executeOk(harness, 'wallet.credit', input);
    // Same logical transaction, fresh engine idempotency key: the op body's
    // deterministic leg keys hit ON CONFLICT DO NOTHING (false return) and
    // the op refuses instead of posting a second pair.
    const second = await harness.engine.run({
      name: 'wallet.credit',
      input,
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(second.isErr() && second.error.code).toBe('conflict');
    expect(await harness.projection()).toEqual({ balanceNanoUsd: '5000000000' });
    const legs = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, harness.walletId));
    expect(legs).toHaveLength(1);
    await assertConservationCleanFor(harness.walletId);
  });

  it('clawback commits a negative balance — settlement is never balance-guarded', async () => {
    const harness = await createWalletHarness();

    const result = await executeOk(harness, 'wallet.clawback', {
      walletId: harness.walletId,
      amountNanoUsd: '4000000000',
      reason: 'clawback below zero',
    });

    expect(result.auditId).toBeTruthy();
    expect(await harness.projection()).toEqual({ balanceNanoUsd: '-4000000000' });
    await assertConservationCleanFor(harness.walletId);
  });

  it('refuses an unknown wallet with a typed not-found and commits nothing', async () => {
    const harness = await createWalletHarness();

    const result = await harness.engine.run({
      name: 'wallet.credit',
      input: {
        walletId: crypto.randomUUID(),
        amountNanoUsd: '5000000000',
        reason: 'missing wallet',
      },
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('not_found');
    expect(await harness.auditCount()).toBe(0);
  });

  it('rethrows an infra lock failure as a defect, never a typed refusal', async () => {
    const harness = await createWalletHarness();
    // Fault injection at the op's dependency seam (the engine-hook pattern,
    // not a slice mock): only the missing-row message maps to not_found.
    const failingStores = {
      ...billingStores,
      lockWalletWithinTx: (): Promise<never> =>
        Promise.reject(new Error('billing store: connection reset')),
    };
    const engine = createAdminOpEngine({
      db,
      registry: createAdminOpRegistry<AdminWalletDeps>([...adminWalletOperations]),
      stores: adminStores,
      telemetry: noopTelemetry(),
      opDeps: { billingStores: failingStores, redis: probeRedis({ log: [], armed: false }) },
      executorId: `admin-wallet-test-${crypto.randomUUID()}`,
    });

    await expect(
      engine.run({
        name: 'wallet.credit',
        input: { walletId: harness.walletId, amountNanoUsd: '1000', reason: 'defect probe' },
        actor: harness.actor,
        mode: 'execute',
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow('connection reset');
    expect(await harness.auditCount()).toBe(0);
  });

  it('writes the post-commit snapshot through with the settled balance and sequence', async () => {
    const harness = await createWalletHarness();

    await executeOk(harness, 'wallet.credit', {
      walletId: harness.walletId,
      amountNanoUsd: '6000000000',
      reason: `snapshot probe ${crypto.randomUUID()}`,
    });

    const raw = await redis.get(BILLING_KEYS.walletSnapshot.buildKey(harness.walletId));
    const snapshot = BILLING_KEYS.walletSnapshot.schema.parse(raw);
    expect(snapshot).toMatchObject({
      balanceNanoUsd: '6000000000',
      ledgerSeq: 1,
      type: 'purchased',
    });
  });

  it('keeps conservation clean after execute + undo', async () => {
    const harness = await createWalletHarness();

    const executed = await executeOk(harness, 'wallet.credit', {
      walletId: harness.walletId,
      amountNanoUsd: '9000000000',
      reason: `conservation probe ${crypto.randomUUID()}`,
    });
    if (executed.inverseInput === null) throw new Error('expected inverseInput');
    await executeOk(harness, 'wallet.clawback', executed.inverseInput, executed.auditId);

    expect(await harness.projection()).toEqual({ balanceNanoUsd: '0' });
    await assertConservationCleanFor(harness.walletId);
    const legs = await db
      .select({ transactionId: ledgerEntries.transactionId })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, harness.walletId));
    expect(legs).toHaveLength(2);
  });

  it('supports an undo → redo chain without leg-key collisions', async () => {
    const harness = await createWalletHarness();

    const credited = await executeOk(harness, 'wallet.credit', {
      walletId: harness.walletId,
      amountNanoUsd: '2000000000',
      reason: 'chain probe',
    });
    if (credited.inverseInput === null) throw new Error('expected inverseInput');
    const undone = await executeOk(
      harness,
      'wallet.clawback',
      credited.inverseInput,
      credited.auditId
    );
    if (undone.inverseInput === null) throw new Error('expected inverseInput');
    const redone = await executeOk(harness, 'wallet.credit', undone.inverseInput, undone.auditId);

    expect(redone.auditId).toBeTruthy();
    expect(await harness.projection()).toEqual({ balanceNanoUsd: '2000000000' });
    expect(await harness.auditCount()).toBe(3);
    await assertConservationCleanFor(harness.walletId);
  });

  it('records the balance transition in the effects diff as wire strings', async () => {
    const harness = await createWalletHarness();
    await postUserAdjustment(harness.walletId, 1_000_000_000n, 'deposit', 'payments-in');

    const result = await harness.engine.run({
      name: 'wallet.credit',
      input: {
        walletId: harness.walletId,
        amountNanoUsd: '5000000000',
        reason: 'effects probe',
      },
      actor: harness.actor,
      mode: 'preview',
    });

    const effects = result._unsafeUnwrap().effects;
    expect(effects).toContainEqual({
      label: 'wallet.balanceNanoUsd',
      before: '1000000000',
      after: '6000000000',
    });
  });
});

describe('seededRng', () => {
  it('yields an identical stream for the same seed and a different one otherwise', () => {
    const first = seededRng(42);
    const second = seededRng(42);
    const other = seededRng(43);
    const a = [first(), first(), first()];
    const b = [second(), second(), second()];
    const c = [other(), other(), other()];
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const value of a) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
