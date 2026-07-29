import type { Database } from '@hushbox/db';
import type { Modality, ResolvedReasoningEffort } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter, SettlementTx } from '../../../lib/idempotency/index.js';
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

export type LedgerEntryKind = 'deposit' | 'charge' | 'clawback' | 'promo' | 'refund';
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
  /** The paying account — the owner of the debited wallet, never the sender. */
  readonly payerUserId: string;
  /** The sender's user id (member turn); mutually exclusive with senderLinkId. */
  readonly senderUserId?: string;
  /** The sender's link id (link-guest turn); mutually exclusive with senderUserId. */
  readonly senderLinkId?: string;
  readonly contentItemId: string;
  readonly runId: string;
  /** The serving model and provider as plain strings — no FK into the catalog. */
  readonly modelId: string;
  readonly providerName: string;
  readonly modality: BillingModality;
  readonly generationId?: string;
  readonly costNanoUsd: bigint;
  readonly isEstimated: boolean;
  readonly idempotencyKey: string;
}

/**
 * The token dimension row written for a language generation, keyed 1:1 to its
 * usage record. Reasoning/cached counts default to 0 upstream.
 */
export interface LlmCompletionInput {
  readonly usageRecordId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  /**
   * The level this generation reasoned at, recorded beside the tokens it spent
   * there. Absent when the call carried no reasoning wire at all — which is a
   * different fact from `off`, the level a user who chose Min runs at.
   */
  readonly reasoningEffort?: ResolvedReasoningEffort;
}

/**
 * The dimensional row written for an image/video generation, keyed 1:1 to its
 * usage record. `modality` is always present; the rest are the dimensions the
 * call declared.
 */
export interface MediaGenerationInput {
  readonly usageRecordId: string;
  readonly modality: BillingModality;
  readonly imageCount?: number;
  readonly durationMs?: number;
  readonly resolution?: string;
}

export interface UsageRecordRow {
  readonly id: string;
  /** Null once the payer has been hard-deleted (pseudonymized, never dropped). */
  readonly payerUserId: string | null;
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

/**
 * Spending accrual — an atomic upsert, never check-then-act. The free-tier
 * `allowance` scope is period-keyed (`day`); the group `member`/`conversation`
 * scopes are durable, cumulative-forever rows (one per member / per conversation,
 * no period). A `member` upsert carries the owner-set cap for the insert path only —
 * a spend must never clobber an existing cap.
 */
export type SpendingUpsert =
  | { readonly scope: 'allowance'; readonly userId: string; readonly day: string }
  | {
      readonly scope: 'member';
      readonly memberId: string;
      readonly budgetNanoUsd: bigint;
    }
  | { readonly scope: 'conversation'; readonly conversationId: string };

export interface WalletSnapshotRow {
  readonly balanceNanoUsd: bigint;
  readonly ledgerSeq: bigint;
  readonly type: WalletType;
}

/** One row of the per-model usage aggregation, keyed by the model id string. */
export interface UsageBreakdownRow {
  readonly modelId: string;
  readonly totalNanoUsd: bigint;
  readonly recordCount: number;
  readonly estimatedCount: number;
}

/** Keyset page over the per-model aggregation, scoped to one user. */
export interface UsageBreakdownQuery {
  readonly userId: string;
  readonly limit: number;
  /** Exclusive lower bound on `modelId` — the previous page's last model id. */
  readonly cursor?: string;
}

/** Time-bucket granularity for the usage time-series aggregations. */
export type UsageGranularity = 'day' | 'week';

/**
 * A caller-scoped, inclusive `createdAt` window — the sole visibility boundary
 * (`userId`) plus the analytics date range. `start`/`end` are pre-resolved to
 * UTC day bounds by the domain layer.
 */
export interface UsageDateRangeQuery {
  readonly userId: string;
  readonly start: Date;
  readonly end: Date;
}

/** KPI totals over a caller's language generations in a date range. */
export interface UsageSummaryRow {
  readonly totalNanoUsd: bigint;
  readonly messageCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
}

/** One (period, model) spend bucket for the spending-over-time series. */
export interface UsageSpendingBucket {
  readonly period: string;
  readonly modelId: string;
  readonly totalNanoUsd: bigint;
  readonly count: number;
}

/** One per-(model, provider) spend + token row for the cost-by-model breakdown. */
export interface UsageCostByModelRow {
  readonly modelId: string;
  readonly providerName: string;
  readonly totalNanoUsd: bigint;
  readonly messageCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One period bucket of token counts for the token-usage-over-time series. */
export interface UsageTokenBucket {
  readonly period: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
}

/** One per-conversation spend row for the spending-by-conversation breakdown. */
export interface UsageConversationSpendRow {
  readonly conversationId: string;
  readonly totalNanoUsd: bigint;
}

/** One user-wallet ledger leg for the balance-history series. */
export interface LedgerHistoryRow {
  readonly createdAt: Date;
  readonly balanceAfterNanoUsd: bigint;
  readonly kind: LedgerEntryKind;
  readonly amountNanoUsd: bigint;
}

/** One user-wallet ledger leg for the paginated transaction history. */
export interface LedgerTransactionRow {
  readonly id: string;
  readonly amountNanoUsd: bigint;
  readonly balanceAfterNanoUsd: bigint;
  readonly kind: LedgerEntryKind;
  readonly paymentId: string | null;
  readonly createdAt: Date;
}

/** A newest-first, offset/cursor page over a caller's user-wallet ledger legs. */
export interface LedgerTransactionQuery {
  readonly userId: string;
  readonly limit: number;
  readonly cursor?: Date;
  readonly offset?: number;
  readonly kind?: LedgerEntryKind;
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
  /**
   * The language token-dimension write, composed right after a freshly-created
   * usage record (skipped on idempotent replay). One row per usage record.
   */
  insertLlmCompletionWithinTx(tx: SettlementTx, input: LlmCompletionInput): Promise<void>;
  /**
   * The media dimension write, composed right after a freshly-created usage
   * record (skipped on idempotent replay). One row per usage record.
   */
  insertMediaGenerationWithinTx(tx: SettlementTx, input: MediaGenerationInput): Promise<void>;
  addSpendingWithinTx(
    tx: SettlementTx,
    upsert: SpendingUpsert,
    amountNanoUsd: bigint
  ): Promise<void>;

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
  /** The single durable per-member row (cap + cumulative spend), or null when unconfigured. */
  readMemberBudget(
    db: Database,
    memberId: string
  ): ResultAsync<
    { readonly budgetNanoUsd: bigint; readonly spentNanoUsd: bigint } | null,
    DomainError
  >;
  /** The single durable per-conversation cumulative spend (0 when no row exists). */
  readConversationSpent(db: Database, conversationId: string): ResultAsync<bigint, DomainError>;
  /**
   * Owner-facing per-member cap write: upsert the durable member-budget row's
   * `budgetNanoUsd`, PRESERVING the cumulative `spentNanoUsd` (never resets
   * spend). A cap below the accrued spend is refused ATOMICALLY — the
   * conflict-path update carries a `spent <= cap` WHERE guard, so there is no
   * check-then-act window against a concurrent settlement accrual —
   * answering `'below-spent'` with the stored row untouched. A config write,
   * not settlement — it runs on the caller's request transaction (`DbWriter`,
   * not `SettlementTx`) and returns the typed error channel so it composes
   * inside a `byKey` mutation. Single-writer of `member_budgets`: the
   * conversations budget-management route composes this helper rather than
   * reaching billing's table.
   */
  setMemberBudgetCapWithinTx(
    tx: DbWriter,
    memberId: string,
    capNanoUsd: bigint
  ): ResultAsync<'applied' | 'below-spent', DomainError>;
  /**
   * Membership-lifecycle budget-row removal (BILLING §Group Funding 4):
   * deletes the member's durable budget row inside the caller's departure
   * transaction. Absent row is the idempotent no-op. Single-writer of
   * `member_budgets`: the conversations removal/leave paths compose this
   * helper rather than reaching billing's table.
   */
  deleteMemberBudgetWithinTx(tx: DbWriter, memberId: string): ResultAsync<void, DomainError>;
  /**
   * The conversation's accrued spend, read UNDER A ROW LOCK (`FOR UPDATE`,
   * materializing a zero row first when none exists) so a cap-vs-spend
   * validation in the caller's transaction cannot race a concurrent
   * settlement accrual — the settlement's spending upsert blocks until the
   * caller commits. Lock order matches settlement (spending row before the
   * conversations row), so the two never deadlock.
   */
  lockConversationSpentWithinTx(
    tx: DbWriter,
    conversationId: string
  ): ResultAsync<bigint, DomainError>;
  readUsageRecord(db: Database, id: string): ResultAsync<UsageRecordRow | null, DomainError>;
  /**
   * Per-model spend aggregation for one user (`SUM(cost)` + counts grouped by
   * `modelId`), ordered by model id for keyset pagination. Session-scoped —
   * the caller filter is the sole visibility boundary, and it matches the
   * PAYER: this is what the caller spent, not what they sent.
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
   * Stamps the run's conversation onto every usage record grouped by `runId`,
   * inside the settlement transaction (idempotent: a replayed settlement rewrites
   * the same value). A run belongs to exactly one conversation, so keying by
   * `runId` covers all of the run's charges — solo and group alike.
   */
  stampRunConversationWithinTx(
    tx: SettlementTx,
    runId: string,
    conversationId: string
  ): Promise<void>;

  /**
   * The usage-analytics read surface — every method is caller-scoped by `userId`
   * (the sole visibility boundary) and returns money as nano-USD `bigint`; the
   * route serializes it as a `NanoUSD` string at the JSON boundary. The token
   * dimension joins `llm_completions` (language generations only).
   */
  summarizeUsage(
    db: Database,
    range: UsageDateRangeQuery
  ): ResultAsync<UsageSummaryRow, DomainError>;
  usageSpendingOverTime(
    db: Database,
    args: UsageDateRangeQuery & {
      readonly granularity: UsageGranularity;
      readonly modelId?: string;
    }
  ): ResultAsync<readonly UsageSpendingBucket[], DomainError>;
  usageCostByModel(
    db: Database,
    range: UsageDateRangeQuery
  ): ResultAsync<readonly UsageCostByModelRow[], DomainError>;
  usageTokensOverTime(
    db: Database,
    args: UsageDateRangeQuery & {
      readonly granularity: UsageGranularity;
      readonly modelId?: string;
    }
  ): ResultAsync<readonly UsageTokenBucket[], DomainError>;
  usageSpendingByConversation(
    db: Database,
    args: UsageDateRangeQuery & { readonly limit: number }
  ): ResultAsync<readonly UsageConversationSpendRow[], DomainError>;
  readLedgerHistory(
    db: Database,
    args: UsageDateRangeQuery & { readonly limit: number }
  ): ResultAsync<readonly LedgerHistoryRow[], DomainError>;
  /**
   * Distinct model ids the caller has any usage under, model-id ascending.
   * Payer-scoped like every other analytics read: it populates the model filter
   * for those charts, so a different scope would offer options that select
   * nothing.
   */
  distinctUsageModels(db: Database, userId: string): ResultAsync<readonly string[], DomainError>;
  listLedgerTransactions(
    db: Database,
    query: LedgerTransactionQuery
  ): ResultAsync<readonly LedgerTransactionRow[], DomainError>;

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
