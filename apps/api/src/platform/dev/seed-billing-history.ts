import { sql } from 'drizzle-orm';
import {
  conversationSpending,
  ledgerEntries,
  llmCompletions,
  memberBudgets,
  payments,
  usageRecords,
} from '@hushbox/db';
import { runSettlement } from '../../lib/idempotency/index.js';
import { createBillingStores } from '../../slices/billing/index.js';
import type { Database } from '@hushbox/db';
import type { Modality } from '@hushbox/shared';
import type { SettlementTx } from '../../lib/idempotency/index.js';

/**
 * Dev/E2E producers that rebuild a persona's RICH billing history — completed
 * card payments and 90-day usage — against the new double-entry schema. The
 * live settlement path stamps `now`, so it cannot mint 90-day-old rows; these
 * producers therefore do timestamp-controlled DIRECT writes, but stay strictly
 * CONFORMANT: every ledger transaction is a signed leg pair summing to zero
 * (the deferred `ledger_entries_zero_sum` trigger rejects anything else), money
 * is nano-USD `bigint` throughout, and the wallet balance / `ledgerSeq` /
 * per-leg `balanceAfterNanoUsd` bookkeeping advances exactly as the real
 * settlement writers do (`creditPaymentWithinTx`, `chargeWithinTx`).
 *
 * The rich volume/model-mix/90-day spread is the caller's: producers faithfully
 * persist whatever specs they are given. Idempotency rides on caller-supplied
 * stable keys — a re-run finds the deterministic idempotency keys already
 * present and is a no-op (the anchor row's `created` flag gates every downstream
 * write, so the wallet balance never double-advances).
 */

/** The convenience float-USD → nano-USD converter (banker's rounding, once). */
export { usdToNanoUsd } from '../../slices/billing/index.js';

export interface SeedBillingDeps {
  readonly db: Database;
}

/** One completed card payment plus its zero-sum deposit, backdated. */
export interface PaymentSpec {
  /** Stable arbitration key: the deposit's idempotency keys derive from it. */
  readonly stableKey: string;
  readonly amountNanoUsd: bigint;
  readonly cardType: string;
  readonly cardLastFour: string;
  readonly helcimTransactionId: string;
  /** Backdated timestamp stamped on the payment row and its ledger legs. */
  readonly createdAt: Date;
}

export interface SeedPaymentsHistoryParams {
  readonly userId: string;
  readonly purchasedWalletId: string;
  readonly payments: readonly PaymentSpec[];
}

export interface SeedPaymentsHistoryResult {
  /** Payments actually inserted (0 on a full idempotent re-run). */
  readonly paymentsCreated: number;
  readonly finalBalanceNanoUsd: bigint;
}

/** The language token dimension written to `llm_completions` for a text charge. */
export interface UsageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
}

/** One settled usage record plus its zero-sum charge, backdated. */
export interface UsageSpec {
  /** Stable arbitration key: the usage/charge idempotency keys derive from it. */
  readonly stableKey: string;
  readonly modelId: string;
  readonly providerName: string;
  readonly modality: Modality;
  /** Already-billable model cost; charged as-is, mirroring `chargeWithinTx`. */
  readonly billableCostNanoUsd: bigint;
  /** Additive storage fee, charged on top and NEVER marked up. Defaults to 0. */
  readonly storageFeeNanoUsd?: bigint;
  readonly isEstimated?: boolean;
  readonly generationId?: string;
  /** The settlement anchor content item; null is legal for seed history. */
  readonly contentItemId?: string | null;
  /** Present for a `text` charge → one `llm_completions` row. */
  readonly tokens?: UsageTokens;
  /** Optional group attribution → durable cumulative `member_budgets` row. */
  readonly memberBudget?: { readonly memberId: string; readonly budgetNanoUsd: bigint };
  /** Backdated timestamp stamped on the usage record and its ledger legs. */
  readonly createdAt: Date;
}

export interface SeedUsageHistoryParams {
  readonly userId: string;
  readonly walletId: string;
  readonly conversationId: string;
  readonly records: readonly UsageSpec[];
}

export interface SeedUsageHistoryResult {
  /** Usage records actually inserted (0 on a full idempotent re-run). */
  readonly usageRecordsCreated: number;
  readonly totalChargedNanoUsd: bigint;
  readonly finalBalanceNanoUsd: bigint;
}

/** The billable model cost plus the additive (never-marked-up) storage fee. */
function chargedAmount(billableCostNanoUsd: bigint, storageFeeNanoUsd: bigint): bigint {
  return billableCostNanoUsd + storageFeeNanoUsd;
}

/**
 * Backdated completed payments, each with a conformant deposit leg pair
 * (user purchased wallet ↔ `payments-in` house account). Mirrors
 * `creditPaymentWithinTx`'s leg structure, adding the explicit backdated
 * `createdAt` the store writers cannot set. Runs in one settlement transaction
 * so the deferred zero-sum trigger validates every group at commit.
 */
export async function seedPaymentsHistory(
  deps: SeedBillingDeps,
  params: SeedPaymentsHistoryParams
): Promise<SeedPaymentsHistoryResult> {
  const stores = createBillingStores();
  return runSettlement(deps.db, async (tx: SettlementTx) => {
    const wallet = await stores.lockWalletWithinTx(tx, params.purchasedWalletId);
    let balance = wallet.balanceNanoUsd;
    let ledgerSeq = wallet.ledgerSeq;
    let created = 0;

    for (const spec of params.payments) {
      const inserted = await tx
        .insert(payments)
        .values({
          userId: params.userId,
          amountNanoUsd: spec.amountNanoUsd,
          status: 'completed',
          idempotencyKey: `seed:pay:${params.userId}:${spec.stableKey}`,
          helcimTransactionId: spec.helcimTransactionId,
          cardType: spec.cardType,
          cardLastFour: spec.cardLastFour,
          createdAt: spec.createdAt,
          updatedAt: spec.createdAt,
          webhookReceivedAt: spec.createdAt,
        })
        .onConflictDoNothing({ target: payments.idempotencyKey })
        .returning({ id: payments.id });
      const paymentRow = inserted[0];
      if (paymentRow === undefined) continue;
      created += 1;

      balance += spec.amountNanoUsd;
      ledgerSeq += 1n;
      const transactionId = crypto.randomUUID();
      await tx.insert(ledgerEntries).values([
        {
          transactionId,
          kind: 'deposit',
          amountNanoUsd: spec.amountNanoUsd,
          balanceAfterNanoUsd: balance,
          walletId: wallet.id,
          paymentId: paymentRow.id,
          idempotencyKey: `seed:deposit:${params.userId}:${spec.stableKey}:user`,
          createdAt: spec.createdAt,
        },
        {
          transactionId,
          kind: 'deposit',
          amountNanoUsd: -spec.amountNanoUsd,
          houseAccount: 'payments-in',
          paymentId: paymentRow.id,
          idempotencyKey: `seed:deposit:${params.userId}:${spec.stableKey}:house`,
          createdAt: spec.createdAt,
        },
      ]);
    }

    if (created > 0) {
      await stores.updateWalletBalanceWithinTx(tx, wallet.id, balance, ledgerSeq);
    }
    return { paymentsCreated: created, finalBalanceNanoUsd: balance };
  });
}

/** Per-member cumulative charge accrual collected while walking the records. */
interface MemberAccrual {
  readonly budgetNanoUsd: bigint;
  spentNanoUsd: bigint;
}

/** Running wallet bookkeeping carried record-to-record through the walk. */
interface ChargeCursor {
  balanceNanoUsd: bigint;
  ledgerSeq: bigint;
}

/**
 * Writes one usage record and, only when it was freshly inserted, its
 * `llm_completions` dimension (text) and the conformant charge leg pair (user
 * wallet debit ↔ `revenue` house credit) — mirroring `chargeWithinTx`. Advances
 * `cursor` in place on a fresh insert and returns the charged amount; returns
 * null on an idempotent replay (the deterministic key already present), leaving
 * the cursor untouched so the wallet balance never double-advances.
 */
async function writeSeedUsageChargeWithinTx(
  tx: SettlementTx,
  params: SeedUsageHistoryParams,
  spec: UsageSpec,
  cursor: ChargeCursor
): Promise<bigint | null> {
  const charged = chargedAmount(spec.billableCostNanoUsd, spec.storageFeeNanoUsd ?? 0n);
  const inserted = await tx
    .insert(usageRecords)
    .values({
      // Seeded history is a solo user's own spend: they are the payer, and the
      // charge legs below debit their wallet.
      payerUserId: params.userId,
      contentItemId: spec.contentItemId ?? null,
      runId: crypto.randomUUID(),
      conversationId: params.conversationId,
      modelId: spec.modelId,
      providerName: spec.providerName,
      modality: spec.modality,
      ...(spec.generationId === undefined ? {} : { generationId: spec.generationId }),
      costNanoUsd: charged,
      isEstimated: spec.isEstimated ?? false,
      idempotencyKey: `seed:usage:${params.userId}:${spec.stableKey}`,
      createdAt: spec.createdAt,
    })
    .onConflictDoNothing({ target: usageRecords.idempotencyKey })
    .returning({ id: usageRecords.id });
  const usageRow = inserted[0];
  if (usageRow === undefined) return null;

  if (spec.modality === 'text' && spec.tokens !== undefined) {
    await tx.insert(llmCompletions).values({
      usageRecordId: usageRow.id,
      inputTokens: spec.tokens.inputTokens,
      outputTokens: spec.tokens.outputTokens,
      reasoningTokens: spec.tokens.reasoningTokens ?? 0,
      cachedInputTokens: spec.tokens.cachedInputTokens ?? 0,
    });
  }

  cursor.balanceNanoUsd -= charged;
  cursor.ledgerSeq += 1n;
  const transactionId = crypto.randomUUID();
  await tx.insert(ledgerEntries).values([
    {
      transactionId,
      kind: 'charge',
      amountNanoUsd: -charged,
      balanceAfterNanoUsd: cursor.balanceNanoUsd,
      walletId: params.walletId,
      usageRecordId: usageRow.id,
      idempotencyKey: `seed:charge:${params.userId}:${spec.stableKey}:user`,
      createdAt: spec.createdAt,
    },
    {
      transactionId,
      kind: 'charge',
      amountNanoUsd: charged,
      houseAccount: 'revenue',
      usageRecordId: usageRow.id,
      idempotencyKey: `seed:charge:${params.userId}:${spec.stableKey}:house`,
      createdAt: spec.createdAt,
    },
  ]);
  return charged;
}

/** Accumulates a fresh charge into its member's cap-preserving accrual. */
function accrueMemberSpend(
  accruals: Map<string, MemberAccrual>,
  memberBudget: NonNullable<UsageSpec['memberBudget']>,
  charged: bigint
): void {
  const accrual = accruals.get(memberBudget.memberId) ?? {
    budgetNanoUsd: memberBudget.budgetNanoUsd,
    spentNanoUsd: 0n,
  };
  accrual.spentNanoUsd += charged;
  accruals.set(memberBudget.memberId, accrual);
}

/**
 * Upserts the durable cumulative spending rows (per conversation, per member),
 * adding this batch's freshly-charged deltas. The owner-set member cap rides
 * only the insert path; a re-run adds 0 and never clobbers an existing cap.
 */
async function applyCumulativeSpendingWithinTx(
  tx: SettlementTx,
  conversationId: string,
  conversationDelta: bigint,
  memberAccruals: ReadonlyMap<string, MemberAccrual>
): Promise<void> {
  await tx
    .insert(conversationSpending)
    .values({ conversationId, spentNanoUsd: conversationDelta })
    .onConflictDoUpdate({
      target: conversationSpending.conversationId,
      set: {
        spentNanoUsd: sql`${conversationSpending.spentNanoUsd} + ${conversationDelta}`,
        updatedAt: sql`now()`,
      },
    });
  for (const [memberId, accrual] of memberAccruals) {
    await tx
      .insert(memberBudgets)
      .values({
        memberId,
        budgetNanoUsd: accrual.budgetNanoUsd,
        spentNanoUsd: accrual.spentNanoUsd,
      })
      .onConflictDoUpdate({
        target: memberBudgets.memberId,
        set: {
          spentNanoUsd: sql`${memberBudgets.spentNanoUsd} + ${accrual.spentNanoUsd}`,
          updatedAt: sql`now()`,
        },
      });
  }
}

/**
 * Backdated usage history: one `usage_records` row (plus its `llm_completions`
 * dimension for text) and a conformant charge leg pair per record, mirroring
 * `chargeWithinTx`, then the durable cumulative `conversation_spending` and
 * `member_budgets` rows exactly as settlement accrues them. Each record's charge
 * is the marked-up base cost plus the additive storage fee; the wallet balance
 * and `ledgerSeq` advance per record (negative balances are legal). Runs in one
 * settlement transaction so the deferred zero-sum trigger validates every group
 * at commit.
 */
export async function seedUsageHistory(
  deps: SeedBillingDeps,
  params: SeedUsageHistoryParams
): Promise<SeedUsageHistoryResult> {
  const stores = createBillingStores();
  return runSettlement(deps.db, async (tx: SettlementTx) => {
    const wallet = await stores.lockWalletWithinTx(tx, params.walletId);
    const cursor: ChargeCursor = {
      balanceNanoUsd: wallet.balanceNanoUsd,
      ledgerSeq: wallet.ledgerSeq,
    };
    let created = 0;
    let totalCharged = 0n;
    let conversationDelta = 0n;
    const memberAccruals = new Map<string, MemberAccrual>();

    for (const spec of params.records) {
      const charged = await writeSeedUsageChargeWithinTx(tx, params, spec, cursor);
      if (charged === null) continue;
      created += 1;
      totalCharged += charged;
      conversationDelta += charged;
      if (spec.memberBudget !== undefined) {
        accrueMemberSpend(memberAccruals, spec.memberBudget, charged);
      }
    }

    if (created > 0) {
      await stores.updateWalletBalanceWithinTx(
        tx,
        wallet.id,
        cursor.balanceNanoUsd,
        cursor.ledgerSeq
      );
      await applyCumulativeSpendingWithinTx(
        tx,
        params.conversationId,
        conversationDelta,
        memberAccruals
      );
    }

    return {
      usageRecordsCreated: created,
      totalChargedNanoUsd: totalCharged,
      finalBalanceNanoUsd: cursor.balanceNanoUsd,
    };
  });
}
