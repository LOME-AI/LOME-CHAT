import { utcDayKey } from './period.js';
import type {
  CompletionTokens,
  MediaGenerationFacts,
  ResolvedReasoningEffort,
} from '@hushbox/shared';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { BillingModality, BillingStores, WalletType } from '../ports/index.js';

/**
 * The turn's SENDER principal, recorded on every billed row beside the payer
 * (a member's userId, or a link guest's linkId — a guest has no users row).
 * Required, never inferred from `userId`: on a link-guest turn `userId` is the
 * OWNER while the guest sent it. On a user turn `userId` is the sending member
 * itself — owner funding moves the charged WALLET to the owner, never the
 * attributed user.
 */
export type ChargeSender =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'linkGuest'; readonly linkId: string };

export interface ChargeInput {
  readonly walletId: string;
  readonly userId: string;
  /** The sender recorded on the usage record, independent of the payer. */
  readonly sender: ChargeSender;
  /** Plain grouping uuid for the run's charges — there is no run table. */
  readonly runId: string;
  /** Saved ⟺ billed: the persisted content this charge is anchored to. */
  readonly contentItemId: string;
  /** The serving model and provider, captured as plain strings (no catalog FK). */
  readonly modelId: string;
  readonly providerName: string;
  readonly modality: BillingModality;
  readonly generationId?: string;
  /**
   * The generation's already-billable model cost: the port-converted inline
   * provider cost, or the billable catalog estimate. Fees were applied at the
   * two seams (catalog ingestion / the ModelProvider port conversion) — this
   * module never applies, removes, or reasons about them.
   */
  readonly billableCostNanoUsd: bigint;
  /**
   * Additive storage fee (nano-USD). Charged on TOP of the billable model
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
  /**
   * The level this generation reasoned at, written to `llm_completions`
   * alongside the reasoning tokens it spent (`docs/BILLING.md` §Reasoning
   * Effort 9). Absent when the call carried no reasoning wire — distinct from
   * `off`, which records that reasoning was deliberately disabled.
   */
  readonly reasoningEffort?: ResolvedReasoningEffort;
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
 * durable cumulative group member/conversation rows. The charge is the
 * already-billable model cost PLUS the additive (never-marked-up) storage fee —
 * no fee math happens here. Idempotent by the
 * unique charge key: a concurrent or replayed identical charge converges on the
 * first execution's row and writes nothing (the dimension write is skipped too).
 */
export async function chargeWithinTx(
  stores: BillingStores,
  tx: SettlementTx,
  input: ChargeInput
): Promise<ChargeResult> {
  const chargedNanoUsd = input.billableCostNanoUsd + input.storageFeeNanoUsd;
  const wallet = await stores.lockWalletWithinTx(tx, input.walletId);
  const usage = await stores.insertUsageRecordIfAbsentWithinTx(tx, {
    userId: input.userId,
    ...(input.sender.kind === 'user'
      ? { senderUserId: input.sender.userId }
      : { senderLinkId: input.sender.linkId }),
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

/**
 * The completion row's token counts. A generation that reported no usage — an
 * interrupted stream — counts zero rather than skipping the row: the row is
 * what the answer's reasoning level is read back from.
 */
function observedTokens(tokens: CompletionTokens | undefined): CompletionTokens {
  return {
    inputTokens: tokens?.inputTokens ?? 0,
    outputTokens: tokens?.outputTokens ?? 0,
    reasoningTokens: tokens?.reasoningTokens ?? 0,
    cachedInputTokens: tokens?.cachedInputTokens ?? 0,
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
 * row is written exactly once alongside its usage record. An embedding
 * generation matches neither modality and writes nothing.
 *
 * Every `text` generation gets its completion row, including a partial that
 * reported no usage (its counts fall to zero): the row is where the answer's
 * reasoning level is read back from, so a text generation without one would
 * persist content the display can never describe.
 */
async function writeGenerationDimension(
  stores: BillingStores,
  tx: SettlementTx,
  input: ChargeInput,
  usageRecordId: string
): Promise<void> {
  if (input.modality === 'text') {
    await stores.insertLlmCompletionWithinTx(tx, {
      usageRecordId,
      ...observedTokens(input.tokens),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
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
