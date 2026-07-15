import { ADMIN_OP_CONTRACTS, serializeNanoUSD } from '@hushbox/shared';
import { conflictError, notFoundError } from '../../../../lib/errors/index.js';
import { hashCanonicalJson, uuidFromHex } from '../../../../lib/idempotency/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { writeThroughSnapshot } from '../../../billing/index.js';
import { defineAdminOp } from '../registry.js';
import type { z } from 'zod';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result } from '../../../../lib/result/index.js';
import type { BillingStores, WalletRecord } from '../../../billing/index.js';
import type { AdminOpContext, AdminOpOutcome } from '../registry.js';

/**
 * The money inverse pair — `wallet.credit` ↔ `wallet.clawback` — composed
 * entirely from billing's published surface on the engine-owned
 * `SettlementTx`. Both directions post a zero-sum leg pair against the
 * `promo` house account (a credit is admin goodwill, its clawback the exact
 * reversal), so a credit + clawback pair nets the house account — and the
 * wallet — to zero: the Iron Law's testable invariant.
 */

const creditContract = ADMIN_OP_CONTRACTS['wallet.credit'];
const clawbackContract = ADMIN_OP_CONTRACTS['wallet.clawback'];

type WalletAdjustmentInput = z.output<(typeof creditContract)['input']>;

/** The Redis handle `writeThroughSnapshot` accepts (billing does not barrel-export its `RedisClient` alias). */
export type WalletSnapshotRedis = Parameters<typeof writeThroughSnapshot>[0];

export interface AdminWalletDeps {
  readonly billingStores: BillingStores;
  readonly redis: WalletSnapshotRedis;
}

interface WalletAdjustmentSpec {
  readonly opName: (typeof creditContract)['name'];
  readonly ledgerKind: 'promo' | 'clawback';
  /** +1n credits the wallet; -1n debits it (the house counter-leg mirrors). */
  readonly walletSign: 1n | -1n;
}

/** The billing adapter reports a missing lock target by this exact message. */
const WALLET_NOT_FOUND_MESSAGE = 'wallet to lock does not exist';

async function lockWallet(
  ctx: AdminOpContext<AdminWalletDeps>,
  walletId: string
): Promise<Result<WalletRecord, DomainError>> {
  try {
    return ok(await ctx.deps.billingStores.lockWalletWithinTx(ctx.tx, walletId));
  } catch (error) {
    // An admin-supplied wallet id is user input, so a missing row is a typed
    // refusal, not a defect; anything else (infra failure) stays a defect and
    // rethrows into the engine's 500 path.
    if (error instanceof Error && error.message.includes(WALLET_NOT_FOUND_MESSAGE)) {
      return err(notFoundError('wallet does not exist'));
    }
    throw error;
  }
}

async function adjustWallet(
  ctx: AdminOpContext<AdminWalletDeps>,
  input: WalletAdjustmentInput,
  spec: WalletAdjustmentSpec
): Promise<Result<AdminOpOutcome, DomainError>> {
  const locked = await lockWallet(ctx, input.walletId);
  if (locked.isErr()) return err(locked.error);
  const wallet = locked.value;

  const amountWire = serializeNanoUSD(input.amountNanoUsd);
  // The adjustment's logical identity: op + wallet + amount + reason. No
  // randomness (preview and execute must derive identical identities from
  // the same pre-state), and the derived leg-unique keys are the money-DB
  // backstop: re-posting the same logical adjustment — whatever path it
  // arrives by — hits ON CONFLICT DO NOTHING and refuses instead of
  // double-applying. A deliberate second identical adjustment needs a
  // distinct reason, which admin ops require anyway.
  const identity = await hashCanonicalJson({
    op: spec.opName,
    walletId: wallet.id,
    amountNanoUsd: amountWire,
    reason: input.reason,
  });
  const transactionId = uuidFromHex(identity);
  const legKeyBase = `admin:${spec.opName}:${identity}`;

  const delta = spec.walletSign * input.amountNanoUsd;
  const balanceAfter = wallet.balanceNanoUsd + delta;
  const ledgerSeq = wallet.ledgerSeq + 1n;
  const posted = await ctx.deps.billingStores.insertLedgerLegsIfAbsentWithinTx(ctx.tx, [
    {
      transactionId,
      kind: spec.ledgerKind,
      amountNanoUsd: delta,
      balanceAfterNanoUsd: balanceAfter,
      walletId: wallet.id,
      idempotencyKey: `${legKeyBase}:wallet`,
    },
    {
      transactionId,
      kind: spec.ledgerKind,
      amountNanoUsd: -delta,
      houseAccount: 'promo',
      idempotencyKey: `${legKeyBase}:house`,
    },
  ]);
  if (!posted) {
    return err(conflictError('this wallet adjustment already posted to the ledger'));
  }
  // Unguarded by design: a negative balance is a legal state (settlement is
  // never balance-guarded — billing doctrine).
  await ctx.deps.billingStores.updateWalletBalanceWithinTx(
    ctx.tx,
    wallet.id,
    balanceAfter,
    ledgerSeq
  );

  const { redis } = ctx.deps;
  ctx.registerEphemeral({
    name: `${spec.opName}.snapshot`,
    run: async (): Promise<void> => {
      // Post-commit best-effort: money commits in Postgres first; the CAS
      // write-through keeps the next admission from gating on a stale
      // balance. A lost CAS (newer snapshot) is ordinary; a Redis failure
      // throws so the engine's telemetry sees it — never failing the op.
      const written = await writeThroughSnapshot(redis, {
        walletId: wallet.id,
        balanceNanoUsd: balanceAfter,
        ledgerSeq,
        walletType: wallet.type,
      });
      if (written.isErr()) {
        throw new Error(`wallet snapshot write-through failed: ${written.error.code}`);
      }
    },
  });

  return ok({
    effects: [
      {
        label: 'wallet.balanceNanoUsd',
        before: wallet.balanceNanoUsd.toString(10),
        after: balanceAfter.toString(10),
      },
    ],
    target: { type: 'wallet', id: wallet.id },
    // Inverse snapshot semantics: the undo reverses exactly this amount. The
    // identity prefix keeps two same-amount undos of distinct adjustments
    // from colliding on the inverse's own leg keys.
    inverseInput: {
      walletId: wallet.id,
      amountNanoUsd: amountWire,
      reason: `undo of ${spec.opName} ${identity.slice(0, 16)} on wallet ${wallet.id}`,
    },
  });
}

export const walletCredit = defineAdminOp<AdminWalletDeps, (typeof creditContract)['input']>(
  creditContract,
  {
    execute: (ctx, input) =>
      adjustWallet(ctx, input, {
        opName: creditContract.name,
        ledgerKind: 'promo',
        walletSign: 1n,
      }),
  }
);

export const walletClawback = defineAdminOp<AdminWalletDeps, (typeof clawbackContract)['input']>(
  clawbackContract,
  {
    execute: (ctx, input) =>
      adjustWallet(ctx, input, {
        opName: clawbackContract.name,
        ledgerKind: 'clawback',
        walletSign: -1n,
      }),
  }
);
