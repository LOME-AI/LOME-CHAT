import { and, asc, desc, eq, gt, gte, isNotNull, lt, lte, ne, sql } from 'drizzle-orm';
import {
  allowanceSpending,
  conversationSpending,
  ledgerEntries,
  llmCompletions,
  mediaGenerations,
  memberBudgets,
  payments,
  usageRecords,
  wallets,
} from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type {
  BillingStores,
  LedgerLegInput,
  LlmCompletionInput,
  MediaGenerationInput,
  PaymentChargeIdentifiers,
  PaymentCompletedMatch,
  PaymentInsertInput,
  PaymentRecord,
  PaymentStatus,
  SpendingUpsert,
  UsageDateRangeQuery,
  UsageGranularity,
  UsageRecordInput,
  WalletRecord,
  WalletType,
} from '../ports/index.js';
import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/** One mapper for every read query: infra rejections become `unavailable`. */
function storeFailure(cause: unknown): DomainError {
  return unavailableError('billing store query failed', cause);
}

/** Defect guard: an expected row that is absent aborts the settlement. */
export function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) throw new Error(`billing store: ${message}`);
  return row;
}

/**
 * A `date_trunc` bucket expression, rendered as text for stable grouping. The
 * granularity is a closed `'day' | 'week'` union (Zod-validated at the route),
 * never client-freeform, so interpolating it as raw SQL cannot inject.
 */
function truncatedPeriod(granularity: UsageGranularity, column: PgColumn): SQL<string> {
  return sql<string>`date_trunc('${sql.raw(granularity)}', ${column})::text`;
}

/** `coalesce(sum(col), 0)` as an integer — one 0-defaulted token aggregate. */
function sumInt(column: PgColumn): SQL<number> {
  return sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
}

/** The three token aggregates shared by the token-bearing usage reads. */
function tokenSums(): {
  readonly inputTokens: SQL<number>;
  readonly outputTokens: SQL<number>;
  readonly cachedTokens: SQL<number>;
} {
  return {
    inputTokens: sumInt(llmCompletions.inputTokens),
    outputTokens: sumInt(llmCompletions.outputTokens),
    cachedTokens: sumInt(llmCompletions.cachedInputTokens),
  };
}

/** `sum(cost_nano_usd)` as a bigint — the spend aggregate over usage records. */
function sumCost(): SQL<bigint> {
  return sql<bigint>`sum(${usageRecords.costNanoUsd})`.mapWith(BigInt);
}

/**
 * The caller-scoped usage-record window shared by the analytics aggregations:
 * the caller as PAYER (the sole visibility boundary) AND the inclusive
 * `createdAt` range, optionally narrowed to one model id. Payer-scoped is what
 * makes these figures reconcile with the ledger reads beside them on the same
 * surface — a spend total and its wallet legs must count the same charges.
 */
function usageWindow(range: UsageDateRangeQuery, modelId?: string): SQL | undefined {
  const conditions = [
    eq(usageRecords.payerUserId, range.userId),
    gte(usageRecords.createdAt, range.start),
    lte(usageRecords.createdAt, range.end),
  ];
  if (modelId !== undefined) conditions.push(eq(usageRecords.modelId, modelId));
  return and(...conditions);
}

const PAYMENT_COLUMNS = {
  id: payments.id,
  userId: payments.userId,
  amountNanoUsd: payments.amountNanoUsd,
  status: payments.status,
  idempotencyKey: payments.idempotencyKey,
  helcimTransactionId: payments.helcimTransactionId,
  cardType: payments.cardType,
  cardLastFour: payments.cardLastFour,
  errorCode: payments.errorCode,
  createdAt: payments.createdAt,
} as const;

function toPaymentRecord(row: {
  id: string;
  userId: string | null;
  amountNanoUsd: bigint;
  status: PaymentStatus;
  idempotencyKey: string;
  helcimTransactionId: string | null;
  cardType: string | null;
  cardLastFour: string | null;
  errorCode: string | null;
  createdAt: Date;
}): PaymentRecord {
  return {
    id: row.id,
    userId: row.userId,
    amountNanoUsd: row.amountNanoUsd,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    helcimTransactionId: row.helcimTransactionId,
    cardType: row.cardType,
    cardLastFour: row.cardLastFour,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
  };
}

function toWalletRecord(row: {
  id: string;
  type: WalletType;
  balanceNanoUsd: bigint;
  ledgerSeq: bigint;
}): WalletRecord {
  return {
    id: row.id,
    type: row.type,
    balanceNanoUsd: row.balanceNanoUsd,
    ledgerSeq: row.ledgerSeq,
  };
}

/**
 * The row shape shared by both ledger writers (plain insert and guarded
 * insert-if-absent): optional leg fields spread in only when present. The two
 * writers must post identical leg shapes, so the mapping lives in one place.
 */
function toLedgerLegRow(leg: LedgerLegInput): typeof ledgerEntries.$inferInsert {
  return {
    transactionId: leg.transactionId,
    kind: leg.kind,
    amountNanoUsd: leg.amountNanoUsd,
    idempotencyKey: leg.idempotencyKey,
    ...(leg.walletId === undefined ? {} : { walletId: leg.walletId }),
    ...(leg.balanceAfterNanoUsd === undefined
      ? {}
      : { balanceAfterNanoUsd: leg.balanceAfterNanoUsd }),
    ...(leg.houseAccount === undefined ? {} : { houseAccount: leg.houseAccount }),
    ...(leg.usageRecordId === undefined ? {} : { usageRecordId: leg.usageRecordId }),
    ...(leg.paymentId === undefined ? {} : { paymentId: leg.paymentId }),
  };
}

/**
 * The billing slice's single-writer repository: every raw Drizzle mutation on
 * billing's tables lives here, behind the `BillingStores` port. Within-tx
 * methods throw on violated expectations — inside `runSettlement` a throw
 * aborts the whole transaction, which is the fail-fast the single-settlement
 * rule requires.
 */
export function createBillingStores(): BillingStores {
  return {
    async insertWalletIfAbsentWithinTx(tx: SettlementTx, userId: string, type: WalletType) {
      const inserted = await tx
        .insert(wallets)
        .values({ userId, type })
        .onConflictDoNothing({ target: [wallets.userId, wallets.type] })
        .returning({ id: wallets.id });
      const created = inserted[0];
      if (created !== undefined) return { id: created.id, created: true };
      const existing = await tx
        .select({ id: wallets.id })
        .from(wallets)
        .where(and(eq(wallets.userId, userId), eq(wallets.type, type)));
      return {
        id: requireRow(existing[0], 'wallet insert conflicted but no row exists').id,
        created: false,
      };
    },

    async lockWalletWithinTx(tx: SettlementTx, walletId: string) {
      const rows = await tx
        .select({
          id: wallets.id,
          type: wallets.type,
          balanceNanoUsd: wallets.balanceNanoUsd,
          ledgerSeq: wallets.ledgerSeq,
        })
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .for('update');
      return toWalletRecord(requireRow(rows[0], 'wallet to lock does not exist'));
    },

    async updateWalletBalanceWithinTx(
      tx: SettlementTx,
      walletId: string,
      balanceNanoUsd: bigint,
      ledgerSeq: bigint
    ) {
      const updated = await tx
        .update(wallets)
        .set({ balanceNanoUsd, ledgerSeq })
        .where(eq(wallets.id, walletId))
        .returning({ id: wallets.id });
      requireRow(updated[0], 'wallet balance update affected no row');
    },

    async insertLedgerLegsWithinTx(tx, legs) {
      if (legs.length === 0) {
        throw new Error('billing store: a ledger write needs at least one leg');
      }
      await tx.insert(ledgerEntries).values(legs.map((leg) => toLedgerLegRow(leg)));
    },

    async insertUsageRecordIfAbsentWithinTx(tx: SettlementTx, input: UsageRecordInput) {
      const inserted = await tx
        .insert(usageRecords)
        .values({
          payerUserId: input.payerUserId,
          ...(input.senderUserId === undefined ? {} : { senderUserId: input.senderUserId }),
          ...(input.senderLinkId === undefined ? {} : { senderLinkId: input.senderLinkId }),
          contentItemId: input.contentItemId,
          runId: input.runId,
          modelId: input.modelId,
          providerName: input.providerName,
          modality: input.modality,
          ...(input.generationId === undefined ? {} : { generationId: input.generationId }),
          costNanoUsd: input.costNanoUsd,
          isEstimated: input.isEstimated,
          idempotencyKey: input.idempotencyKey,
        })
        .onConflictDoNothing({ target: usageRecords.idempotencyKey })
        .returning({ id: usageRecords.id });
      const created = inserted[0];
      if (created !== undefined) return { id: created.id, created: true };
      const existing = await tx
        .select({ id: usageRecords.id })
        .from(usageRecords)
        .where(eq(usageRecords.idempotencyKey, input.idempotencyKey));
      return {
        id: requireRow(existing[0], 'usage record insert conflicted but no row exists').id,
        created: false,
      };
    },

    async insertLlmCompletionWithinTx(tx: SettlementTx, input: LlmCompletionInput) {
      await tx.insert(llmCompletions).values({
        usageRecordId: input.usageRecordId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        reasoningTokens: input.reasoningTokens,
        cachedInputTokens: input.cachedInputTokens,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      });
    },

    async insertMediaGenerationWithinTx(tx: SettlementTx, input: MediaGenerationInput) {
      await tx.insert(mediaGenerations).values({
        usageRecordId: input.usageRecordId,
        modality: input.modality,
        ...(input.imageCount === undefined ? {} : { imageCount: input.imageCount }),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
      });
    },

    async addSpendingWithinTx(tx: SettlementTx, upsert: SpendingUpsert, amountNanoUsd: bigint) {
      if (upsert.scope === 'allowance') {
        await tx
          .insert(allowanceSpending)
          .values({ userId: upsert.userId, day: upsert.day, spentNanoUsd: amountNanoUsd })
          .onConflictDoUpdate({
            target: [allowanceSpending.userId, allowanceSpending.day],
            set: {
              spentNanoUsd: sql`${allowanceSpending.spentNanoUsd} + ${amountNanoUsd}`,
              updatedAt: sql`now()`,
            },
          });
        return;
      }
      if (upsert.scope === 'member') {
        // The durable owner-set cap is written only on the insert path; a spend
        // upsert accrues spent and must NOT clobber an existing cap.
        await tx
          .insert(memberBudgets)
          .values({
            memberId: upsert.memberId,
            budgetNanoUsd: upsert.budgetNanoUsd,
            spentNanoUsd: amountNanoUsd,
          })
          .onConflictDoUpdate({
            target: [memberBudgets.memberId],
            set: {
              spentNanoUsd: sql`${memberBudgets.spentNanoUsd} + ${amountNanoUsd}`,
              updatedAt: sql`now()`,
            },
          });
        return;
      }
      await tx
        .insert(conversationSpending)
        .values({
          conversationId: upsert.conversationId,
          spentNanoUsd: amountNanoUsd,
        })
        .onConflictDoUpdate({
          target: [conversationSpending.conversationId],
          set: {
            spentNanoUsd: sql`${conversationSpending.spentNanoUsd} + ${amountNanoUsd}`,
            updatedAt: sql`now()`,
          },
        });
    },

    async insertPaymentIfAbsentWithinTx(tx: SettlementTx, input: PaymentInsertInput) {
      const inserted = await tx
        .insert(payments)
        .values({
          userId: input.userId,
          amountNanoUsd: input.amountNanoUsd,
          idempotencyKey: input.idempotencyKey,
        })
        .onConflictDoNothing({ target: payments.idempotencyKey })
        .returning(PAYMENT_COLUMNS);
      const created = inserted[0];
      if (created !== undefined) return { payment: toPaymentRecord(created), created: true };
      const existing = await tx
        .select(PAYMENT_COLUMNS)
        .from(payments)
        .where(eq(payments.idempotencyKey, input.idempotencyKey));
      return {
        payment: toPaymentRecord(
          requireRow(existing[0], 'payment insert conflicted but no row exists')
        ),
        created: false,
      };
    },

    async markPaymentChargedWithinTx(
      tx: SettlementTx,
      paymentId: string,
      charge: PaymentChargeIdentifiers
    ) {
      const updated = await tx
        .update(payments)
        .set({
          status: 'awaiting_webhook',
          helcimTransactionId: charge.helcimTransactionId,
          ...(charge.cardType === undefined ? {} : { cardType: charge.cardType }),
          ...(charge.cardLastFour === undefined ? {} : { cardLastFour: charge.cardLastFour }),
          updatedAt: sql`now()`,
        })
        .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')))
        .returning({ id: payments.id });
      return updated.length === 1;
    },

    async markPaymentFailedWithinTx(
      tx: SettlementTx,
      paymentId: string,
      errorCode: string,
      from: PaymentStatus
    ) {
      const updated = await tx
        .update(payments)
        .set({ status: 'failed', errorCode, updatedAt: sql`now()` })
        .where(and(eq(payments.id, paymentId), eq(payments.status, from)))
        .returning({ id: payments.id });
      return updated.length === 1;
    },

    async markPaymentExpiredWithinTx(tx: SettlementTx, paymentId: string) {
      const updated = await tx
        .update(payments)
        .set({ status: 'expired', updatedAt: sql`now()` })
        .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')))
        .returning({ id: payments.id });
      return updated.length === 1;
    },

    async claimPaymentCompletedWithinTx(tx: SettlementTx, match: PaymentCompletedMatch) {
      const matcher =
        'paymentId' in match
          ? eq(payments.id, match.paymentId)
          : eq(payments.helcimTransactionId, match.helcimTransactionId);
      const claimed = await tx
        .update(payments)
        .set({ status: 'completed', webhookReceivedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(matcher, eq(payments.status, 'awaiting_webhook')))
        .returning(PAYMENT_COLUMNS);
      const row = claimed[0];
      return row === undefined ? null : toPaymentRecord(row);
    },

    async insertLedgerLegsIfAbsentWithinTx(tx, legs) {
      if (legs.length === 0) {
        throw new Error('billing store: a ledger write needs at least one leg');
      }
      const inserted = await tx
        .insert(ledgerEntries)
        .values(legs.map((leg) => toLedgerLegRow(leg)))
        .onConflictDoNothing({ target: ledgerEntries.idempotencyKey })
        .returning({ id: ledgerEntries.id });
      if (inserted.length === legs.length) return true;
      if (inserted.length === 0) return false;
      // Both keys derive from one event, so a partial hit means corrupt data.
      throw new Error('billing store: guarded ledger insert landed partially');
    },

    readPayment(db: Database, paymentId: string) {
      return fromPromise(
        db.select(PAYMENT_COLUMNS).from(payments).where(eq(payments.id, paymentId)),
        storeFailure
      ).map((rows) => (rows[0] === undefined ? null : toPaymentRecord(rows[0])));
    },

    readPaymentByTransactionId(db: Database, helcimTransactionId: string) {
      return fromPromise(
        db
          .select(PAYMENT_COLUMNS)
          .from(payments)
          .where(eq(payments.helcimTransactionId, helcimTransactionId)),
        storeFailure
      ).map((rows) => (rows[0] === undefined ? null : toPaymentRecord(rows[0])));
    },

    findStalePendingPayments(db: Database, olderThan: Date, limit: number) {
      return fromPromise(
        db
          .select({
            id: payments.id,
            userId: payments.userId,
            amountNanoUsd: payments.amountNanoUsd,
            createdAt: payments.createdAt,
          })
          .from(payments)
          .where(and(eq(payments.status, 'pending'), lt(payments.createdAt, olderThan)))
          .orderBy(payments.createdAt)
          .limit(limit),
        storeFailure
      );
    },

    readWallets(db: Database, userId: string) {
      return fromPromise(
        db
          .select({
            id: wallets.id,
            type: wallets.type,
            balanceNanoUsd: wallets.balanceNanoUsd,
            ledgerSeq: wallets.ledgerSeq,
          })
          .from(wallets)
          .where(eq(wallets.userId, userId)),
        storeFailure
      ).map((rows) => rows.map((row) => toWalletRecord(row)));
    },

    readWalletSnapshot(db: Database, walletId: string) {
      return fromPromise(
        db
          .select({
            balanceNanoUsd: wallets.balanceNanoUsd,
            ledgerSeq: wallets.ledgerSeq,
            type: wallets.type,
          })
          .from(wallets)
          .where(eq(wallets.id, walletId)),
        storeFailure
      ).map((rows) => rows[0] ?? null);
    },

    readAllowanceSpent(db: Database, userId: string, day: string) {
      return fromPromise(
        db
          .select({ spentNanoUsd: allowanceSpending.spentNanoUsd })
          .from(allowanceSpending)
          .where(and(eq(allowanceSpending.userId, userId), eq(allowanceSpending.day, day))),
        storeFailure
      ).map((rows) => rows[0]?.spentNanoUsd ?? 0n);
    },

    readMemberBudget(db: Database, memberId: string) {
      return fromPromise(
        db
          .select({
            budgetNanoUsd: memberBudgets.budgetNanoUsd,
            spentNanoUsd: memberBudgets.spentNanoUsd,
          })
          .from(memberBudgets)
          .where(eq(memberBudgets.memberId, memberId)),
        storeFailure
      ).map((rows) => rows[0] ?? null);
    },

    readConversationSpent(db: Database, conversationId: string) {
      return fromPromise(
        db
          .select({ spentNanoUsd: conversationSpending.spentNanoUsd })
          .from(conversationSpending)
          .where(eq(conversationSpending.conversationId, conversationId)),
        storeFailure
      ).map((rows) => rows[0]?.spentNanoUsd ?? 0n);
    },

    setMemberBudgetCapWithinTx(tx, memberId, capNanoUsd) {
      // Upsert the owner-set cap only; spentNanoUsd defaults to 0 on the insert
      // path and is untouched on conflict, so a cap change never clobbers the
      // cumulative spend the settlement writer accrues. The conflict path is
      // WHERE-guarded (`spent <= new cap`) and the statement RETURNs the row it
      // wrote: zero rows back means the guard refused — a cap below the
      // accrued spend — with the stored row untouched. Atomic by construction:
      // the guard and the write are one statement, never check-then-act.
      return fromPromise(
        tx
          .insert(memberBudgets)
          .values({ memberId, budgetNanoUsd: capNanoUsd })
          .onConflictDoUpdate({
            target: [memberBudgets.memberId],
            set: { budgetNanoUsd: capNanoUsd, updatedAt: sql`now()` },
            setWhere: sql`${memberBudgets.spentNanoUsd} <= ${capNanoUsd}`,
          })
          .returning({ memberId: memberBudgets.memberId }),
        storeFailure
      ).map((rows): 'applied' | 'below-spent' => (rows.length > 0 ? 'applied' : 'below-spent'));
    },

    deleteMemberBudgetWithinTx(tx, memberId) {
      // Absent row = already done (the idempotent no-op) — no rows-affected
      // assertion, matching at-least-once retry semantics.
      return fromPromise(
        tx.delete(memberBudgets).where(eq(memberBudgets.memberId, memberId)),
        storeFailure
      ).map((): void => undefined);
    },

    lockConversationSpentWithinTx(tx, conversationId) {
      // Materialize a zero-spend row when none exists (row absence already
      // means "spent 0" to every reader), then read it FOR UPDATE so the
      // caller's cap-vs-spend validation holds the same lock a concurrent
      // settlement's spending upsert needs — serializing the two. Lock order
      // (spending row, then the conversations row the caller updates) matches
      // settlement's, so no deadlock is possible.
      return fromPromise(
        tx
          .insert(conversationSpending)
          .values({ conversationId, spentNanoUsd: 0n })
          .onConflictDoNothing({ target: [conversationSpending.conversationId] }),
        storeFailure
      )
        .andThen(() =>
          fromPromise(
            tx
              .select({ spentNanoUsd: conversationSpending.spentNanoUsd })
              .from(conversationSpending)
              .where(eq(conversationSpending.conversationId, conversationId))
              .for('update'),
            storeFailure
          )
        )
        .map((rows) => rows[0]?.spentNanoUsd ?? 0n);
    },

    readUsageRecord(db: Database, id: string) {
      return fromPromise(
        db
          .select({
            id: usageRecords.id,
            payerUserId: usageRecords.payerUserId,
            contentItemId: usageRecords.contentItemId,
            runId: usageRecords.runId,
            modality: usageRecords.modality,
            generationId: usageRecords.generationId,
            costNanoUsd: usageRecords.costNanoUsd,
            isEstimated: usageRecords.isEstimated,
            idempotencyKey: usageRecords.idempotencyKey,
          })
          .from(usageRecords)
          .where(eq(usageRecords.id, id)),
        storeFailure
      ).map((rows) => rows[0] ?? null);
    },

    aggregateUsageByModel(db: Database, query) {
      // userId stays a permanent conjunct — the sole visibility boundary — so
      // the cursor can never widen the scope across users.
      const conditions = [eq(usageRecords.payerUserId, query.userId)];
      if (query.cursor !== undefined) {
        conditions.push(gt(usageRecords.modelId, query.cursor));
      }
      return fromPromise(
        db
          .select({
            modelId: usageRecords.modelId,
            // Money stays bigint — never Number()-coerced.
            totalNanoUsd: sql<bigint>`sum(${usageRecords.costNanoUsd})`.mapWith(BigInt),
            recordCount: sql<number>`count(*)`.mapWith(Number),
            estimatedCount:
              sql<number>`count(*) filter (where ${usageRecords.isEstimated})`.mapWith(Number),
          })
          .from(usageRecords)
          .where(and(...conditions))
          .groupBy(usageRecords.modelId)
          .orderBy(usageRecords.modelId)
          .limit(query.limit),
        storeFailure
      );
    },

    readUsageChargeWallet(db: Database, usageRecordId: string) {
      return fromPromise(
        db
          .select({ walletId: ledgerEntries.walletId })
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.usageRecordId, usageRecordId),
              eq(ledgerEntries.kind, 'charge'),
              isNotNull(ledgerEntries.walletId)
            )
          ),
        storeFailure
      ).map((rows) => rows[0]?.walletId ?? null);
    },

    async stampRunConversationWithinTx(tx, runId, conversationId) {
      await tx.update(usageRecords).set({ conversationId }).where(eq(usageRecords.runId, runId));
    },

    summarizeUsage(db, range) {
      // INNER JOIN llm_completions restricts the KPI totals to language
      // generations (the only rows with a token dimension) — matching the
      // legacy summary, whose messageCount is the completion-row count.
      return fromPromise(
        db
          .select({
            totalNanoUsd: sql<bigint>`coalesce(sum(${usageRecords.costNanoUsd}), 0)`.mapWith(
              BigInt
            ),
            messageCount: sql<number>`count(*)`.mapWith(Number),
            ...tokenSums(),
          })
          .from(usageRecords)
          .innerJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
          .where(usageWindow(range)),
        storeFailure
      ).map(
        (rows) =>
          rows[0] ?? {
            totalNanoUsd: 0n,
            messageCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
          }
      );
    },

    usageSpendingOverTime(db, args) {
      const period = truncatedPeriod(args.granularity, usageRecords.createdAt);
      return fromPromise(
        db
          .select({
            period,
            modelId: usageRecords.modelId,
            totalNanoUsd: sumCost(),
            count: sql<number>`count(*)`.mapWith(Number),
          })
          .from(usageRecords)
          .innerJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
          .where(usageWindow(args, args.modelId))
          .groupBy(period, usageRecords.modelId)
          .orderBy(asc(period)),
        storeFailure
      );
    },

    usageCostByModel(db, range) {
      return fromPromise(
        db
          .select({
            modelId: usageRecords.modelId,
            providerName: usageRecords.providerName,
            totalNanoUsd: sumCost(),
            messageCount: sql<number>`count(*)`.mapWith(Number),
            inputTokens: sumInt(llmCompletions.inputTokens),
            outputTokens: sumInt(llmCompletions.outputTokens),
          })
          .from(usageRecords)
          .innerJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
          .where(usageWindow(range))
          .groupBy(usageRecords.modelId, usageRecords.providerName)
          .orderBy(desc(sql`sum(${usageRecords.costNanoUsd})`)),
        storeFailure
      );
    },

    usageTokensOverTime(db, args) {
      const period = truncatedPeriod(args.granularity, usageRecords.createdAt);
      return fromPromise(
        db
          .select({
            period,
            ...tokenSums(),
          })
          .from(usageRecords)
          .innerJoin(llmCompletions, eq(llmCompletions.usageRecordId, usageRecords.id))
          .where(usageWindow(args, args.modelId))
          .groupBy(period)
          .orderBy(asc(period)),
        storeFailure
      );
    },

    usageSpendingByConversation(db, args) {
      return fromPromise(
        db
          .select({
            conversationId: sql<string>`${usageRecords.conversationId}`,
            totalNanoUsd: sumCost(),
          })
          .from(usageRecords)
          .where(and(usageWindow(args), isNotNull(usageRecords.conversationId)))
          .groupBy(usageRecords.conversationId)
          .orderBy(desc(sql`sum(${usageRecords.costNanoUsd})`))
          .limit(args.limit),
        storeFailure
      );
    },

    readLedgerHistory(db, args) {
      return fromPromise(
        db
          .select({
            createdAt: ledgerEntries.createdAt,
            balanceAfterNanoUsd: sql<bigint>`${ledgerEntries.balanceAfterNanoUsd}`.mapWith(BigInt),
            kind: ledgerEntries.kind,
            amountNanoUsd: ledgerEntries.amountNanoUsd,
          })
          .from(ledgerEntries)
          .innerJoin(wallets, eq(ledgerEntries.walletId, wallets.id))
          .where(
            and(
              eq(wallets.userId, args.userId),
              gte(ledgerEntries.createdAt, args.start),
              lte(ledgerEntries.createdAt, args.end)
            )
          )
          .orderBy(asc(ledgerEntries.createdAt))
          .limit(args.limit),
        storeFailure
      );
    },

    distinctUsageModels(db, userId) {
      return fromPromise(
        db
          .selectDistinct({ modelId: usageRecords.modelId })
          .from(usageRecords)
          .where(eq(usageRecords.payerUserId, userId))
          .orderBy(asc(usageRecords.modelId)),
        storeFailure
      ).map((rows) => rows.map((row) => row.modelId));
    },

    listLedgerTransactions(db, query) {
      // User-wallet legs only (the join restricts to them); newest-first, one
      // extra row to probe a next page.
      const conditions = [eq(wallets.userId, query.userId)];
      if (query.kind !== undefined) conditions.push(eq(ledgerEntries.kind, query.kind));
      if (query.cursor !== undefined) conditions.push(lt(ledgerEntries.createdAt, query.cursor));
      const base = db
        .select({
          id: ledgerEntries.id,
          amountNanoUsd: ledgerEntries.amountNanoUsd,
          balanceAfterNanoUsd: sql<bigint>`${ledgerEntries.balanceAfterNanoUsd}`.mapWith(BigInt),
          kind: ledgerEntries.kind,
          paymentId: ledgerEntries.paymentId,
          createdAt: ledgerEntries.createdAt,
        })
        .from(ledgerEntries)
        .innerJoin(wallets, eq(ledgerEntries.walletId, wallets.id))
        .where(and(...conditions))
        .orderBy(desc(ledgerEntries.createdAt))
        .limit(query.limit);
      return fromPromise(
        query.offset === undefined ? base : base.offset(query.offset),
        storeFailure
      );
    },

    findUnbalancedTransactions(db: Database, limit: number) {
      return fromPromise(
        db
          .select({
            transactionId: ledgerEntries.transactionId,
            totalNanoUsd: sql<bigint>`sum(${ledgerEntries.amountNanoUsd})`.mapWith(BigInt),
          })
          .from(ledgerEntries)
          .groupBy(ledgerEntries.transactionId)
          .having(sql`sum(${ledgerEntries.amountNanoUsd}) <> 0`)
          // The LIMIT caps the paged sample, so without a total order which
          // violations surface is arbitrary and irreproducible across cron
          // runs; newest-first keeps the sample deterministic and puts the
          // most recently introduced break at the top.
          .orderBy(sql`max(${ledgerEntries.createdAt}) desc`)
          .limit(limit),
        storeFailure
      );
    },

    findWalletDrift(db: Database, limit: number) {
      return fromPromise(
        db
          .select({
            walletId: wallets.id,
            balanceNanoUsd: wallets.balanceNanoUsd,
            legSumNanoUsd: sql<bigint>`coalesce(sum(${ledgerEntries.amountNanoUsd}), 0)`.mapWith(
              BigInt
            ),
          })
          .from(wallets)
          .leftJoin(
            ledgerEntries,
            and(eq(ledgerEntries.walletId, wallets.id), isNotNull(ledgerEntries.walletId))
          )
          .groupBy(wallets.id)
          .having(ne(wallets.balanceNanoUsd, sql`coalesce(sum(${ledgerEntries.amountNanoUsd}), 0)`))
          // Deterministic, newest-first over the uuidv7 PK (time-ordered): the
          // LIMIT caps the paged sample, so without an order which drifting
          // wallets surface is arbitrary and irreproducible across cron runs.
          .orderBy(desc(wallets.id))
          .limit(limit),
        storeFailure
      );
    },
  };
}
