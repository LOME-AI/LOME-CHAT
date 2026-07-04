import type { Database } from '@hushbox/db';
import type { Modality } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * Single-writer persistence seam for billing's tables (wallets,
 * ledger_entries, usage_records, allowance_spending, member_budgets,
 * conversation_spending). Raw Drizzle mutations live only in the adapter
 * behind this port; domain code holds the money logic and calls through it.
 *
 * Two calling conventions, deliberately split:
 * - `*WithinTx` methods run on the branded `SettlementTx` and THROW on
 *   failure — inside a settlement a throw aborts the whole transaction,
 *   which is exactly the fail-fast the single-settlement rule wants.
 * - Plain reads return `ResultAsync` (the typed error channel at the seam).
 */

export type WalletType = 'purchased' | 'free';

export interface WalletRecord {
  readonly id: string;
  readonly type: WalletType;
  readonly balanceNanoUsd: bigint;
  readonly ledgerSeq: bigint;
}

export type LedgerEntryKind = 'deposit' | 'charge' | 'true_up' | 'clawback' | 'promo' | 'refund';
export type HouseAccount = 'revenue' | 'payments-in' | 'promo';

/**
 * One signed leg. Exactly one of `walletId` / `houseAccount` is set (the DB
 * check enforces it); `balanceAfterNanoUsd` rides only on wallet legs.
 */
export interface LedgerLegInput {
  readonly transactionId: string;
  readonly kind: LedgerEntryKind;
  readonly amountNanoUsd: bigint;
  readonly idempotencyKey: string;
  readonly walletId?: string;
  readonly balanceAfterNanoUsd?: bigint;
  readonly houseAccount?: HouseAccount;
  readonly usageRecordId?: string;
  readonly paymentId?: string;
}

export type BillingModality = Modality;

export interface UsageRecordInput {
  readonly userId: string;
  readonly contentItemId: string;
  readonly runId: string;
  readonly modelCatalogId: string;
  readonly modality: BillingModality;
  readonly generationId?: string;
  readonly costNanoUsd: bigint;
  readonly isEstimated: boolean;
  readonly idempotencyKey: string;
}

export interface UsageRecordRow {
  readonly id: string;
  readonly userId: string | null;
  readonly contentItemId: string | null;
  readonly runId: string;
  readonly modality: BillingModality;
  readonly generationId: string | null;
  readonly costNanoUsd: bigint;
  readonly isEstimated: boolean;
  readonly idempotencyKey: string;
}

/** Mirrors the `payment_status` pgEnum (Pattern-D pre-claim lifecycle). */
export type PaymentStatus = 'pending' | 'awaiting_webhook' | 'completed' | 'failed' | 'expired';

export interface PaymentInsertInput {
  readonly userId: string;
  readonly amountNanoUsd: bigint;
  /** User-scoped unique key (`pay:{userId}:{clientKey}`) — the pre-claim's arbitration. */
  readonly idempotencyKey: string;
}

export interface PaymentRecord {
  readonly id: string;
  readonly userId: string | null;
  readonly amountNanoUsd: bigint;
  readonly status: PaymentStatus;
  readonly idempotencyKey: string;
  readonly helcimTransactionId: string | null;
  readonly cardType: string | null;
  readonly cardLastFour: string | null;
  readonly errorCode: string | null;
  readonly createdAt: Date;
}

export interface PaymentChargeIdentifiers {
  readonly helcimTransactionId: string;
  readonly cardType?: string;
  readonly cardLastFour?: string;
}

/** The completed-claim match: the webhook holds the provider id, the verify job our row id. */
export type PaymentCompletedMatch =
  | { readonly paymentId: string }
  | { readonly helcimTransactionId: string };

/** Period-keyed spending accrual — an atomic upsert, never check-then-act. */
export type SpendingUpsert =
  | { readonly scope: 'allowance'; readonly userId: string; readonly day: string }
  | {
      readonly scope: 'member';
      readonly memberId: string;
      readonly month: string;
      readonly budgetNanoUsd: bigint;
    }
  | { readonly scope: 'conversation'; readonly conversationId: string; readonly month: string };

export interface WalletSnapshotRow {
  readonly balanceNanoUsd: bigint;
  readonly ledgerSeq: bigint;
  readonly type: WalletType;
}

/** One row of the per-model usage aggregation, keyed by the catalog row id. */
export interface UsageBreakdownRow {
  readonly modelCatalogId: string;
  readonly totalNanoUsd: bigint;
  readonly recordCount: number;
  readonly estimatedCount: number;
}

/** Keyset page over the per-model aggregation, scoped to one user. */
export interface UsageBreakdownQuery {
  readonly userId: string;
  readonly limit: number;
  /** Exclusive lower bound on `modelCatalogId` — the previous page's last id. */
  readonly cursor?: string;
}

export interface UnbalancedTransaction {
  readonly transactionId: string;
  readonly totalNanoUsd: bigint;
}

export interface WalletDrift {
  readonly walletId: string;
  readonly balanceNanoUsd: bigint;
  readonly legSumNanoUsd: bigint;
}

/** A pre-claim still `pending` past the reconcile age — a sweep candidate. */
export interface StalePendingPayment {
  readonly id: string;
  readonly userId: string | null;
  readonly amountNanoUsd: bigint;
  readonly createdAt: Date;
}

export interface BillingStores {
  insertWalletIfAbsentWithinTx(
    tx: SettlementTx,
    userId: string,
    type: WalletType
  ): Promise<{ readonly id: string; readonly created: boolean }>;
  /** `SELECT … FOR UPDATE`; throws when the wallet does not exist (defect). */
  lockWalletWithinTx(tx: SettlementTx, walletId: string): Promise<WalletRecord>;
  /** Asserts exactly one row updated; throws otherwise. */
  updateWalletBalanceWithinTx(
    tx: SettlementTx,
    walletId: string,
    balanceNanoUsd: bigint,
    ledgerSeq: bigint
  ): Promise<void>;
  insertLedgerLegsWithinTx(tx: SettlementTx, legs: readonly LedgerLegInput[]): Promise<void>;
  insertUsageRecordIfAbsentWithinTx(
    tx: SettlementTx,
    input: UsageRecordInput
  ): Promise<{ readonly id: string; readonly created: boolean }>;
  addSpendingWithinTx(
    tx: SettlementTx,
    upsert: SpendingUpsert,
    amountNanoUsd: bigint
  ): Promise<void>;
  /** `UPDATE … WHERE is_estimated` — true when this call finalized the row. */
  finalizeUsageRecordCostWithinTx(
    tx: SettlementTx,
    usageRecordId: string,
    costNanoUsd: bigint
  ): Promise<boolean>;

  /** The Pattern-D pre-claim: unique insert on the scoped key, existing row on conflict. */
  insertPaymentIfAbsentWithinTx(
    tx: SettlementTx,
    input: PaymentInsertInput
  ): Promise<{ readonly payment: PaymentRecord; readonly created: boolean }>;
  /** `pending → awaiting_webhook` with the provider identifiers; false on 0 rows. */
  markPaymentChargedWithinTx(
    tx: SettlementTx,
    paymentId: string,
    charge: PaymentChargeIdentifiers
  ): Promise<boolean>;
  /** `<from> → failed` with an error code (never freeform content); false on 0 rows. */
  markPaymentFailedWithinTx(
    tx: SettlementTx,
    paymentId: string,
    errorCode: string,
    from: PaymentStatus
  ): Promise<boolean>;
  /** `pending → expired` (the verify job's terminal handling); false on 0 rows. */
  markPaymentExpiredWithinTx(tx: SettlementTx, paymentId: string): Promise<boolean>;
  /**
   * The webhook/verify first-delivery claim: `awaiting_webhook → completed`
   * (+`webhookReceivedAt`), returning the claimed row or null when another
   * delivery won or nothing matches. The wallet credit composes in the same
   * settlement transaction as this claim — that atomicity is the exactly-once.
   */
  claimPaymentCompletedWithinTx(
    tx: SettlementTx,
    match: PaymentCompletedMatch
  ): Promise<PaymentRecord | null>;
  /**
   * Guarded zero-sum insert for event-keyed legs (clawbacks): `ON CONFLICT DO
   * NOTHING` on the unique leg keys; false = the event already posted. A
   * partial hit (some legs present, some not) is a defect and throws.
   */
  insertLedgerLegsIfAbsentWithinTx(
    tx: SettlementTx,
    legs: readonly LedgerLegInput[]
  ): Promise<boolean>;

  readPayment(db: Database, paymentId: string): ResultAsync<PaymentRecord | null, DomainError>;
  readPaymentByTransactionId(
    db: Database,
    helcimTransactionId: string
  ): ResultAsync<PaymentRecord | null, DomainError>;

  readWallets(db: Database, userId: string): ResultAsync<readonly WalletRecord[], DomainError>;
  readWalletSnapshot(
    db: Database,
    walletId: string
  ): ResultAsync<WalletSnapshotRow | null, DomainError>;
  readAllowanceSpent(db: Database, userId: string, day: string): ResultAsync<bigint, DomainError>;
  readMemberBudget(
    db: Database,
    memberId: string,
    month: string
  ): ResultAsync<
    { readonly budgetNanoUsd: bigint; readonly spentNanoUsd: bigint } | null,
    DomainError
  >;
  readConversationSpent(
    db: Database,
    conversationId: string,
    month: string
  ): ResultAsync<bigint, DomainError>;
  readUsageRecord(db: Database, id: string): ResultAsync<UsageRecordRow | null, DomainError>;
  /**
   * Per-model spend aggregation for one user (`SUM(cost)` + counts grouped by
   * `modelCatalogId`), ordered by id for keyset pagination. Session-scoped —
   * the userId filter is the sole visibility boundary.
   */
  aggregateUsageByModel(
    db: Database,
    query: UsageBreakdownQuery
  ): ResultAsync<readonly UsageBreakdownRow[], DomainError>;
  /** The wallet the original charge leg debited (null only for corrupt data). */
  readUsageChargeWallet(
    db: Database,
    usageRecordId: string
  ): ResultAsync<string | null, DomainError>;

  /**
   * Reconciliation-sweep probe: `pending` pre-claims created before `olderThan`
   * (a captured-but-unrecorded charge would strand a row here). Read-only.
   */
  findStalePendingPayments(
    db: Database,
    olderThan: Date,
    limit: number
  ): ResultAsync<readonly StalePendingPayment[], DomainError>;

  /** Conservation auditor probe: transaction groups whose legs do not sum to zero. */
  findUnbalancedTransactions(
    db: Database,
    limit: number
  ): ResultAsync<readonly UnbalancedTransaction[], DomainError>;
  /** Conservation auditor probe: wallets whose balance drifted from Σ legs. */
  findWalletDrift(db: Database, limit: number): ResultAsync<readonly WalletDrift[], DomainError>;
}
