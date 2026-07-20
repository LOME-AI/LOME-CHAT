import { eq, sql, and, inArray } from 'drizzle-orm';
import {
  wallets,
  ledgerEntries,
  payments,
  usageRecords,
  llmCompletions,
  mediaGenerations,
  type Database,
  type DatabaseClient,
} from '@hushbox/db';

export interface CreditBalanceParams {
  userId: string;
  amount: string;
  paymentId: string;
  transactionDetails?: {
    helcimTransactionId?: string;
    cardType?: string;
    cardLastFour?: string;
  };
  webhookReceivedAt?: Date;
}

export interface CreditBalanceResult {
  newBalance: string;
  ledgerEntryId: string;
}

export interface WebhookCreditParams {
  helcimTransactionId: string;
}

export interface WebhookCreditResult {
  newBalance: string;
  ledgerEntryId: string;
  paymentId: string;
}

export interface ChargeForUsageParams {
  userId: string;
  cost: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number | undefined;
  sourceType: string;
  sourceId: string;
  /**
   * True when `cost` was produced by the gateway-lookup → estimate fallback
   * (`getGenerationStats` exhausted retries). Persisted to
   * `usage_records.is_estimated` so dashboards and CI guardrails can flag
   * silent billing drift. Defaults to false for all other callers.
   */
  isEstimated?: boolean;
}

export interface ChargeResult {
  usageRecordId: string;
  walletId: string;
  walletType: string;
  newBalance: string;
}

interface CreditWalletResult {
  updatedWallet: { id: string; balance: string };
  ledgerEntry: { id: string };
}

/**
 * Credit a user's purchased wallet and create a deposit ledger entry.
 * Used by both processWebhookCredit and creditUserBalance to avoid duplication.
 */
async function creditWalletAndCreateLedger(
  tx: DatabaseClient,
  userId: string,
  amount: string,
  paymentId: string
): Promise<CreditWalletResult> {
  const [updatedWallet] = await tx
    .update(wallets)
    .set({
      balance: sql`${wallets.balance} + ${amount}::numeric`,
    })
    .where(and(eq(wallets.userId, userId), eq(wallets.type, 'purchased')))
    .returning({ id: wallets.id, balance: wallets.balance });

  if (!updatedWallet) {
    throw new Error('Failed to update wallet balance');
  }

  const [ledgerEntry] = await tx
    .insert(ledgerEntries)
    .values({
      walletId: updatedWallet.id,
      amount,
      balanceAfter: updatedWallet.balance,
      entryType: 'deposit',
      paymentId,
    })
    .returning({ id: ledgerEntries.id });

  if (!ledgerEntry) {
    throw new Error('Failed to create ledger entry');
  }

  return { updatedWallet, ledgerEntry };
}

/**
 * Process webhook credit by Helcim transaction ID.
 * Only claims payments in 'awaiting_webhook' status.
 * Credits the user's purchased wallet and creates a ledger entry.
 * Returns null if payment already processed or not found.
 */
export async function processWebhookCredit(
  db: Database,
  params: WebhookCreditParams
): Promise<WebhookCreditResult | null> {
  return await db.transaction(async (tx) => {
    // Atomic idempotency: only claim payment if status is awaiting_webhook
    const [payment] = await tx
      .update(payments)
      .set({
        status: 'completed',
        webhookReceivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(payments.helcimTransactionId, params.helcimTransactionId),
          eq(payments.status, 'awaiting_webhook')
        )
      )
      .returning();

    if (!payment) {
      return null;
    }

    if (!payment.userId) {
      throw new Error('Payment has no associated user');
    }

    const { updatedWallet, ledgerEntry } = await creditWalletAndCreateLedger(
      tx,
      payment.userId,
      payment.amount,
      payment.id
    );

    return {
      newBalance: updatedWallet.balance,
      ledgerEntryId: ledgerEntry.id,
      paymentId: payment.id,
    };
  });
}

function buildPaymentUpdate(
  transactionDetails?: CreditBalanceParams['transactionDetails'],
  webhookReceivedAt?: Date
): Record<string, unknown> {
  return {
    status: 'completed' as const,
    ...(transactionDetails?.helcimTransactionId && {
      helcimTransactionId: transactionDetails.helcimTransactionId,
    }),
    ...(transactionDetails?.cardType && { cardType: transactionDetails.cardType }),
    ...(transactionDetails?.cardLastFour && { cardLastFour: transactionDetails.cardLastFour }),
    ...(webhookReceivedAt && { webhookReceivedAt }),
    updatedAt: new Date(),
  };
}

/**
 * Credit user's purchased wallet balance from a payment deposit.
 * Idempotent: only claims payments in 'pending' or 'awaiting_webhook' status.
 * Failed/refunded payments cannot be re-claimed. Returns null if already completed.
 */
export async function creditUserBalance(
  db: Database,
  params: CreditBalanceParams
): Promise<CreditBalanceResult | null> {
  const { userId, amount, paymentId, transactionDetails, webhookReceivedAt } = params;

  return await db.transaction(async (tx) => {
    // Atomic idempotency: only claim payments in claimable states.
    // Failed/refunded payments must NOT be re-claimable as completed.
    const [claimedPayment] = await tx
      .update(payments)
      .set(buildPaymentUpdate(transactionDetails, webhookReceivedAt))
      .where(
        and(eq(payments.id, paymentId), inArray(payments.status, ['pending', 'awaiting_webhook']))
      )
      .returning({ id: payments.id });

    if (!claimedPayment) {
      return null;
    }

    const { updatedWallet, ledgerEntry } = await creditWalletAndCreateLedger(
      tx,
      userId,
      amount,
      paymentId
    );

    return {
      newBalance: updatedWallet.balance,
      ledgerEntryId: ledgerEntry.id,
    };
  });
}

interface ChargeWalletParams {
  tx: DatabaseClient;
  usageRecordId: string;
  userId: string;
  cost: string;
  numericCost: number;
}

/**
 * Shared wallet-charging logic used by both chargeForUsage and chargeForMediaGeneration.
 * Walks wallets in priority order and debits the first with sufficient balance.
 * If no wallet has sufficient balance: marks usage_record as 'failed', throws error.
 */
async function chargeWalletForUsageRecord(
  params: ChargeWalletParams
): Promise<{ walletId: string; walletType: string; newBalance: string }> {
  const { tx, usageRecordId, userId, cost, numericCost } = params;
  const walletRows = await tx
    .select({
      id: wallets.id,
      type: wallets.type,
      balance: wallets.balance,
      priority: wallets.priority,
    })
    .from(wallets)
    .where(eq(wallets.userId, userId))
    .orderBy(wallets.priority);

  let chargedWallet: { id: string; type: string; balance: string } | null = null;

  for (const wallet of walletRows) {
    const [updated] = await tx
      .update(wallets)
      .set({
        balance: sql`${wallets.balance} - ${cost}::numeric`,
      })
      .where(and(eq(wallets.id, wallet.id), sql`${wallets.balance} >= ${cost}::numeric`))
      .returning({ id: wallets.id, balance: wallets.balance });

    if (updated) {
      chargedWallet = { id: updated.id, type: wallet.type, balance: updated.balance };
      break;
    }
  }

  if (!chargedWallet) {
    await tx
      .update(usageRecords)
      .set({ status: 'failed' })
      .where(eq(usageRecords.id, usageRecordId))
      .returning({ id: usageRecords.id });

    throw new Error('Insufficient balance');
  }

  await tx
    .insert(ledgerEntries)
    .values({
      walletId: chargedWallet.id,
      amount: (-numericCost).toFixed(8),
      balanceAfter: chargedWallet.balance,
      entryType: 'usage_charge',
      usageRecordId,
    })
    .returning({ id: ledgerEntries.id });

  await tx
    .update(usageRecords)
    .set({ status: 'completed', completedAt: new Date() })
    .where(eq(usageRecords.id, usageRecordId))
    .returning({ id: usageRecords.id });

  return {
    walletId: chargedWallet.id,
    walletType: chargedWallet.type,
    newBalance: chargedWallet.balance,
  };
}

function validateCost(cost: string): number {
  const numericCost = Number(cost);
  if (Number.isNaN(numericCost) || numericCost < 0) {
    throw new Error(`Invalid cost: "${cost}" — must be a non-negative numeric string`);
  }
  return numericCost;
}

/**
 * Charge a user for LLM usage. Walks wallets in priority order
 * and debits the first with sufficient balance.
 *
 * Atomic transaction:
 * 1. INSERT usage_records (pending)
 * 2. INSERT llm_completions
 * 3-6. Shared wallet charging via chargeWalletForUsageRecord
 *
 * If no wallet has sufficient balance: marks usage_record as 'failed', throws error.
 */
export async function chargeForUsage(
  db: DatabaseClient,
  params: ChargeForUsageParams
): Promise<ChargeResult> {
  const {
    userId,
    cost,
    model,
    provider,
    inputTokens,
    outputTokens,
    cachedTokens = 0,
    sourceType,
    sourceId,
    isEstimated = false,
  } = params;

  const numericCost = validateCost(cost);

  return await db.transaction(async (tx) => {
    const [usageRecord] = await tx
      .insert(usageRecords)
      .values({
        userId,
        type: 'llm_completion',
        status: 'pending',
        cost,
        isEstimated,
        sourceType,
        sourceId,
      })
      .returning({ id: usageRecords.id });

    if (!usageRecord) {
      throw new Error('Failed to create usage record');
    }

    await tx
      .insert(llmCompletions)
      .values({
        usageRecordId: usageRecord.id,
        model,
        provider,
        inputTokens,
        outputTokens,
        cachedTokens,
      })
      .returning({ id: llmCompletions.id });

    const walletResult = await chargeWalletForUsageRecord({
      tx,
      usageRecordId: usageRecord.id,
      userId,
      cost,
      numericCost,
    });

    return { usageRecordId: usageRecord.id, ...walletResult };
  });
}

export interface ChargeForMediaGenerationParams {
  userId: string;
  cost: string;
  model: string;
  provider: string;
  mediaType: 'image' | 'video' | 'audio';
  imageCount?: number | undefined;
  durationMs?: number | undefined;
  resolution?: string | undefined;
  sourceType: string;
  sourceId: string;
}

/**
 * Charge a user for media generation usage. Same atomic wallet-walking
 * pattern as chargeForUsage but inserts media_generations detail row.
 */
export async function chargeForMediaGeneration(
  db: DatabaseClient,
  params: ChargeForMediaGenerationParams
): Promise<ChargeResult> {
  const {
    userId,
    cost,
    model,
    provider,
    mediaType,
    imageCount,
    durationMs,
    resolution,
    sourceType,
    sourceId,
  } = params;

  const numericCost = validateCost(cost);

  return await db.transaction(async (tx) => {
    const [usageRecord] = await tx
      .insert(usageRecords)
      .values({
        userId,
        type: 'media_generation',
        status: 'pending',
        cost,
        sourceType,
        sourceId,
      })
      .returning({ id: usageRecords.id });

    if (!usageRecord) {
      throw new Error('Failed to create usage record');
    }

    await tx
      .insert(mediaGenerations)
      .values({
        usageRecordId: usageRecord.id,
        model,
        provider,
        mediaType,
        ...(imageCount !== undefined && { imageCount }),
        ...(durationMs !== undefined && { durationMs }),
        ...(resolution !== undefined && { resolution }),
      })
      .returning({ id: mediaGenerations.id });

    const walletResult = await chargeWalletForUsageRecord({
      tx,
      usageRecordId: usageRecord.id,
      userId,
      cost,
      numericCost,
    });

    return { usageRecordId: usageRecord.id, ...walletResult };
  });
}
