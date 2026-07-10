import { applyMarkup } from './money.js';
import { utcDayKey } from './period.js';
import type { CompletionTokens, MediaGenerationFacts } from '@hushbox/shared';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { BillingModality, BillingStores, WalletType } from '../ports/index.js';

export interface ChargeInput {
  readonly walletId: string;
  readonly userId: string;
  /** Plain grouping uuid for the run's charges — there is no run table. */
  readonly runId: string;
  /** Saved ⟺ billed: the persisted content this charge is anchored to. */
  readonly contentItemId: string;
  /** The serving model and provider, captured as plain strings (no catalog FK). */
  readonly modelId: string;
  readonly providerName: string;
  readonly modality: BillingModality;
  readonly generationId?: string;
  /** Provider base cost; the 15% markup lands here, exactly once. */
  readonly baseCostNanoUsd: bigint;
  /**
   * Additive storage fee (nano-USD). Charged on TOP of the marked-up model
   * cost and NEVER marked up itself — storage is a pass-through cost. 0n when
   * this generation stores nothing.
   */
  readonly storageFeeNanoUsd: bigint;
  readonly isEstimated: boolean;
  /**
   * The language token dimension, written to `llm_completions` for a `text`
   * generation. Absent for media/embedding generations.
   */
  readonly tokens?: CompletionTokens;
  /**
   * The media dimension, written to `media_generations` for an image/video
   * generation. Absent for language generations.
   */
  readonly media?: MediaGenerationFacts;
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
  /** The wallet's type, cached in the snapshot (only `free` skips the balance check). */
  readonly walletType: WalletType;
}

/**
 * Billing's published transactional write: the charge composed inside the
 * caller's settlement transaction (chat's `saveChatTurn`), entered only with
 * the branded `SettlementTx` handle. UNGUARDED — there is no balance check
 * here and a negative balance is a legal state; admission is the only gate.
 * Writes, in lock order (wallet → spending rows): the usage record, the
 * per-generation dimension row (`llm_completions`/`media_generations`), the
 * zero-sum charge leg pair (user wallet ↔ revenue), the wallet balance +
 * sequence, and the spending rows — the period-keyed free-tier allowance and the
 * durable cumulative group member/conversation rows. The charge is the marked-up
 * model cost PLUS the additive (never-marked-up) storage fee. Idempotent by the
 * unique charge key: a concurrent or replayed identical charge converges on the
 * first execution's row and writes nothing (the dimension write is skipped too).
 */
export async function chargeWithinTx(
  stores: BillingStores,
  tx: SettlementTx,
  input: ChargeInput
): Promise<ChargeResult> {
  const chargedNanoUsd = applyMarkup(input.baseCostNanoUsd) + input.storageFeeNanoUsd;
  const wallet = await stores.lockWalletWithinTx(tx, input.walletId);
  const usage = await stores.insertUsageRecordIfAbsentWithinTx(tx, {
    userId: input.userId,
    contentItemId: input.contentItemId,
    runId: input.runId,
    modelId: input.modelId,
    providerName: input.providerName,
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
      walletType: wallet.type,
    };
  }
  await writeGenerationDimension(stores, tx, input, usage.id);
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
    walletType: wallet.type,
  };
}

/** Media modalities whose generations record a `media_generations` dimension row. */
const MEDIA_MODALITIES: ReadonlySet<BillingModality> = new Set<BillingModality>([
  'image',
  'video',
  'audio',
]);

/**
 * Writes the per-generation dimension row keyed 1:1 to a freshly-created usage
 * record — `llm_completions` for a language (`text`) generation carrying token
 * counts, `media_generations` for an image/video/audio generation. Only ever
 * reached on a fresh usage insert (never on idempotent replay), so the dimension
 * row is written exactly once alongside its usage record. A generation with no
 * matching dimension facts writes nothing (embeddings, or a language partial
 * with no observed usage).
 */
async function writeGenerationDimension(
  stores: BillingStores,
  tx: SettlementTx,
  input: ChargeInput,
  usageRecordId: string
): Promise<void> {
  if (input.modality === 'text') {
    if (input.tokens === undefined) return;
    await stores.insertLlmCompletionWithinTx(tx, {
      usageRecordId,
      inputTokens: input.tokens.inputTokens,
      outputTokens: input.tokens.outputTokens,
      reasoningTokens: input.tokens.reasoningTokens,
      cachedInputTokens: input.tokens.cachedInputTokens,
    });
    return;
  }
  if (MEDIA_MODALITIES.has(input.modality)) {
    await stores.insertMediaGenerationWithinTx(tx, {
      usageRecordId,
      modality: input.modality,
      ...(input.media?.imageCount === undefined ? {} : { imageCount: input.media.imageCount }),
      ...(input.media?.durationMs === undefined ? {} : { durationMs: input.media.durationMs }),
      ...(input.media?.resolution === undefined ? {} : { resolution: input.media.resolution }),
    });
  }
}
