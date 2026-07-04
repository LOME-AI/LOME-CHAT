import { applyMarkup } from './money.js';
import { utcDayKey, utcMonthKey } from './period.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { BillingModality, BillingStores } from '../ports/index.js';

export interface ChargeInput {
  readonly walletId: string;
  readonly userId: string;
  /** Plain grouping uuid for the run's charges — there is no run table. */
  readonly runId: string;
  /** Saved ⟺ billed: the persisted content this charge is anchored to. */
  readonly contentItemId: string;
  readonly modelCatalogId: string;
  readonly modality: BillingModality;
  readonly generationId?: string;
  /** Provider base cost; the 15% markup lands here, exactly once. */
  readonly baseCostNanoUsd: bigint;
  readonly isEstimated: boolean;
  /** DB-backed charge idempotency: unique on usage_records and ledger legs. */
  readonly idempotencyKey: string;
  readonly now: Date;
  readonly memberBudget?: { readonly memberId: string; readonly budgetNanoUsd: bigint };
  readonly conversationId?: string;
}

export interface ChargeResult {
  readonly usageRecordId: string;
  readonly chargedNanoUsd: bigint;
  readonly alreadyCharged: boolean;
  readonly walletId: string;
  readonly balanceAfterNanoUsd: bigint;
  /** For the post-commit Redis snapshot write-through (CAS on this). */
  readonly ledgerSeq: bigint;
}

/**
 * Billing's published transactional write: the charge composed inside the
 * caller's settlement transaction (chat's `saveChatTurn`), entered only with
 * the branded `SettlementTx` handle. UNGUARDED — there is no balance check
 * here and a negative balance is a legal state; admission is the only gate.
 * Writes, in lock order (wallet → period rows): the usage record, the
 * zero-sum charge leg pair (user wallet ↔ revenue), the wallet balance +
 * sequence, and the period-keyed spending rows. Idempotent by the unique
 * charge key: a concurrent or replayed identical charge converges on the
 * first execution's row and writes nothing.
 */
export async function chargeWithinTx(
  stores: BillingStores,
  tx: SettlementTx,
  input: ChargeInput
): Promise<ChargeResult> {
  const chargedNanoUsd = applyMarkup(input.baseCostNanoUsd);
  const wallet = await stores.lockWalletWithinTx(tx, input.walletId);
  const usage = await stores.insertUsageRecordIfAbsentWithinTx(tx, {
    userId: input.userId,
    contentItemId: input.contentItemId,
    runId: input.runId,
    modelCatalogId: input.modelCatalogId,
    modality: input.modality,
    ...(input.generationId === undefined ? {} : { generationId: input.generationId }),
    costNanoUsd: chargedNanoUsd,
    isEstimated: input.isEstimated,
    idempotencyKey: input.idempotencyKey,
  });
  if (!usage.created) {
    return {
      usageRecordId: usage.id,
      chargedNanoUsd,
      alreadyCharged: true,
      walletId: wallet.id,
      balanceAfterNanoUsd: wallet.balanceNanoUsd,
      ledgerSeq: wallet.ledgerSeq,
    };
  }
  const balanceAfterNanoUsd = wallet.balanceNanoUsd - chargedNanoUsd;
  const ledgerSeq = wallet.ledgerSeq + 1n;
  const transactionId = crypto.randomUUID();
  await stores.insertLedgerLegsWithinTx(tx, [
    {
      transactionId,
      kind: 'charge',
      amountNanoUsd: -chargedNanoUsd,
      balanceAfterNanoUsd,
      walletId: wallet.id,
      usageRecordId: usage.id,
      idempotencyKey: `${input.idempotencyKey}:user`,
    },
    {
      transactionId,
      kind: 'charge',
      amountNanoUsd: chargedNanoUsd,
      houseAccount: 'revenue',
      usageRecordId: usage.id,
      idempotencyKey: `${input.idempotencyKey}:house`,
    },
  ]);
  await stores.updateWalletBalanceWithinTx(tx, wallet.id, balanceAfterNanoUsd, ledgerSeq);
  if (wallet.type === 'free') {
    await stores.addSpendingWithinTx(
      tx,
      { scope: 'allowance', userId: input.userId, day: utcDayKey(input.now) },
      chargedNanoUsd
    );
  }
  if (input.memberBudget !== undefined) {
    await stores.addSpendingWithinTx(
      tx,
      {
        scope: 'member',
        memberId: input.memberBudget.memberId,
        month: utcMonthKey(input.now),
        budgetNanoUsd: input.memberBudget.budgetNanoUsd,
      },
      chargedNanoUsd
    );
  }
  if (input.conversationId !== undefined) {
    await stores.addSpendingWithinTx(
      tx,
      {
        scope: 'conversation',
        conversationId: input.conversationId,
        month: utcMonthKey(input.now),
      },
      chargedNanoUsd
    );
  }
  return {
    usageRecordId: usage.id,
    chargedNanoUsd,
    alreadyCharged: false,
    walletId: wallet.id,
    balanceAfterNanoUsd,
    ledgerSeq,
  };
}
