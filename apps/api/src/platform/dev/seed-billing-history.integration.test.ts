import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversationSpending,
  conversations,
  createDb,
  ledgerEntries,
  llmCompletions,
  memberBudgets,
  payments,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { generateKeyPair } from '@hushbox/crypto';
import { applyMarkup, usdToNanoUsd } from '../../slices/billing/index.js';
import { createDevConversation } from './factories.js';
import { seedPaymentsHistory, seedUsageHistory } from './seed-billing-history.js';
import type { PaymentSpec, UsageSpec } from './seed-billing-history.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for seed-billing-history integration tests`);
  }
  return value;
}

const db = createDb(requiredEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });

const createdUserIds: string[] = [];
const createdWalletIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  // Ledger legs must go first and as whole transaction groups: the deferred
  // zero-sum trigger re-checks the OLD group on DELETE, so deleting only a
  // wallet leg (leaving its house leg) would abort. Deleting by transactionId
  // removes both legs of each group, which then sums to zero (empty).
  if (createdWalletIds.length > 0) {
    const legRows = await db
      .select({ transactionId: ledgerEntries.transactionId })
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.walletId, createdWalletIds));
    const txnIds = [...new Set(legRows.map((row) => row.transactionId))];
    if (txnIds.length > 0) {
      await db.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, txnIds));
    }
  }
  if (createdUserIds.length > 0) {
    await db.delete(usageRecords).where(inArray(usageRecords.userId, createdUserIds));
    await db.delete(payments).where(inArray(payments.userId, createdUserIds));
    await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
  }
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

interface Fixture {
  readonly userId: string;
  readonly walletId: string;
  readonly conversationId: string;
  readonly ownerMemberId: string;
}

async function setupFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const keys = generateKeyPair();
  const email = `seedbill-${suffix}@seed-dev.test`;
  const userRows = await db
    .insert(users)
    .values({
      email,
      username: `s${suffix}`,
      opaqueRegistration: new Uint8Array([1]),
      publicKey: keys.publicKey,
      passwordWrappedPrivateKey: new Uint8Array([1]),
      recoveryWrappedPrivateKey: new Uint8Array([1]),
    })
    .returning({ id: users.id });
  const userId = userRows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);

  const walletRows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased' })
    .returning({ id: wallets.id });
  const walletId = walletRows[0]?.id;
  if (walletId === undefined) throw new Error('wallet seed failed');
  createdWalletIds.push(walletId);

  const conversation = await createDevConversation(db, {
    ownerEmail: email,
    seedAiModel: 'dev/model',
  });
  createdConversationIds.push(conversation.conversationId);

  const memberRows = await db
    .select({ id: conversationMembers.id })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversation.conversationId),
        eq(conversationMembers.userId, userId)
      )
    );
  const ownerMemberId = memberRows[0]?.id;
  if (ownerMemberId === undefined) throw new Error('owner member row missing');

  return { userId, walletId, conversationId: conversation.conversationId, ownerMemberId };
}

/** A UTC date `n` days before now, for backdating seed specs. */
function daysAgo(n: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - n);
  return date;
}

function paymentSpecs(): PaymentSpec[] {
  return [
    {
      stableKey: 'p1',
      amountNanoUsd: usdToNanoUsd(5),
      cardType: 'Visa',
      cardLastFour: '4000',
      helcimTransactionId: `hlcm-${crypto.randomUUID()}`,
      createdAt: daysAgo(30),
    },
    {
      stableKey: 'p2',
      amountNanoUsd: usdToNanoUsd(9),
      cardType: 'Mastercard',
      cardLastFour: '4001',
      helcimTransactionId: `hlcm-${crypto.randomUUID()}`,
      createdAt: daysAgo(20),
    },
  ];
}

function usageSpecs(memberId: string): UsageSpec[] {
  return [
    {
      stableKey: 'u1',
      modelId: 'anthropic/claude-opus-4.6',
      providerName: 'anthropic',
      modality: 'text',
      baseCostNanoUsd: usdToNanoUsd(0.01),
      tokens: { inputTokens: 500, outputTokens: 300 },
      createdAt: daysAgo(25),
    },
    {
      stableKey: 'u2',
      modelId: 'openai/gpt-4o',
      providerName: 'openai',
      modality: 'text',
      baseCostNanoUsd: usdToNanoUsd(0.005),
      tokens: { inputTokens: 200, outputTokens: 100, cachedInputTokens: 50 },
      createdAt: daysAgo(10),
      memberBudget: { memberId, budgetNanoUsd: usdToNanoUsd(50) },
    },
  ];
}

describe('seedPaymentsHistory', () => {
  it('writes backdated completed payments as conformant zero-sum deposits', async () => {
    const fixture = await setupFixture();
    const specs = paymentSpecs();

    const result = await seedPaymentsHistory(
      { db },
      {
        userId: fixture.userId,
        purchasedWalletId: fixture.walletId,
        payments: specs,
      }
    );

    expect(result.paymentsCreated).toBe(2);

    const paymentRows = await db
      .select({ id: payments.id, status: payments.status, createdAt: payments.createdAt })
      .from(payments)
      .where(eq(payments.userId, fixture.userId));
    expect(paymentRows).toHaveLength(2);
    expect(paymentRows.every((row) => row.status === 'completed')).toBe(true);
    expect(paymentRows.every((row) => row.createdAt.getTime() < Date.now())).toBe(true);

    const legs = await db
      .select({
        transactionId: ledgerEntries.transactionId,
        amountNanoUsd: ledgerEntries.amountNanoUsd,
        walletId: ledgerEntries.walletId,
      })
      .from(ledgerEntries);

    // Each deposit is two legs (wallet credit + house debit): 2 payments → 4.
    const walletTxnIds = new Set(
      legs.filter((leg) => leg.walletId === fixture.walletId).map((leg) => leg.transactionId)
    );
    const ourLegs = legs.filter((leg) => walletTxnIds.has(leg.transactionId));
    expect(ourLegs).toHaveLength(4);

    // Wallet balance equals the sum of its own legs (conservation).
    const walletLegSum = legs
      .filter((leg) => leg.walletId === fixture.walletId)
      .reduce((sum, leg) => sum + leg.amountNanoUsd, 0n);
    const [wallet] = await db
      .select({ balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.id, fixture.walletId));
    expect(wallet?.balanceNanoUsd).toBe(walletLegSum);
    expect(wallet?.balanceNanoUsd).toBe(usdToNanoUsd(14));
    expect(result.finalBalanceNanoUsd).toBe(usdToNanoUsd(14));

    // Every transaction group for this wallet sums to zero.
    const groups = new Map<string, bigint>();
    for (const leg of ourLegs) {
      groups.set(leg.transactionId, (groups.get(leg.transactionId) ?? 0n) + leg.amountNanoUsd);
    }
    expect(groups.size).toBe(2);
    for (const total of groups.values()) expect(total).toBe(0n);
  });
});

describe('seedUsageHistory', () => {
  it('writes backdated usage as conformant charges and cumulative spending', async () => {
    const fixture = await setupFixture();
    await seedPaymentsHistory(
      { db },
      {
        userId: fixture.userId,
        purchasedWalletId: fixture.walletId,
        payments: paymentSpecs(),
      }
    );

    const specs = usageSpecs(fixture.ownerMemberId);
    const chargedU1 = applyMarkup(specs[0]!.baseCostNanoUsd);
    const chargedU2 = applyMarkup(specs[1]!.baseCostNanoUsd);
    const totalCharged = chargedU1 + chargedU2;

    const result = await seedUsageHistory(
      { db },
      {
        userId: fixture.userId,
        walletId: fixture.walletId,
        conversationId: fixture.conversationId,
        records: specs,
      }
    );

    expect(result.usageRecordsCreated).toBe(2);
    expect(result.totalChargedNanoUsd).toBe(totalCharged);

    const usageRows = await db
      .select({ costNanoUsd: usageRecords.costNanoUsd, createdAt: usageRecords.createdAt })
      .from(usageRecords)
      .where(eq(usageRecords.userId, fixture.userId));
    expect(usageRows).toHaveLength(2);
    expect(usageRows.every((row) => row.createdAt.getTime() < Date.now())).toBe(true);
    expect(usageRows.reduce((sum, row) => sum + row.costNanoUsd, 0n)).toBe(totalCharged);

    const completionRows = await db
      .select({ usageRecordId: llmCompletions.usageRecordId })
      .from(llmCompletions)
      .innerJoin(usageRecords, eq(usageRecords.id, llmCompletions.usageRecordId))
      .where(eq(usageRecords.userId, fixture.userId));
    expect(completionRows).toHaveLength(2);

    // Conservation: wallet balance == Σ its legs; and 14 deposited − charged.
    const legs = await db
      .select({
        transactionId: ledgerEntries.transactionId,
        amountNanoUsd: ledgerEntries.amountNanoUsd,
        walletId: ledgerEntries.walletId,
      })
      .from(ledgerEntries);
    const walletLegSum = legs
      .filter((leg) => leg.walletId === fixture.walletId)
      .reduce((sum, leg) => sum + leg.amountNanoUsd, 0n);
    const [wallet] = await db
      .select({ balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.id, fixture.walletId));
    expect(wallet?.balanceNanoUsd).toBe(walletLegSum);
    expect(wallet?.balanceNanoUsd).toBe(usdToNanoUsd(14) - totalCharged);

    // Every transaction group for this wallet sums to zero.
    const walletTxnIds = new Set(
      legs.filter((leg) => leg.walletId === fixture.walletId).map((leg) => leg.transactionId)
    );
    const groups = new Map<string, bigint>();
    for (const leg of legs) {
      if (!walletTxnIds.has(leg.transactionId)) continue;
      groups.set(leg.transactionId, (groups.get(leg.transactionId) ?? 0n) + leg.amountNanoUsd);
    }
    for (const total of groups.values()) expect(total).toBe(0n);

    const [convSpend] = await db
      .select({ spentNanoUsd: conversationSpending.spentNanoUsd })
      .from(conversationSpending)
      .where(eq(conversationSpending.conversationId, fixture.conversationId));
    expect(convSpend?.spentNanoUsd).toBe(totalCharged);

    const [budget] = await db
      .select({
        budgetNanoUsd: memberBudgets.budgetNanoUsd,
        spentNanoUsd: memberBudgets.spentNanoUsd,
      })
      .from(memberBudgets)
      .where(eq(memberBudgets.memberId, fixture.ownerMemberId));
    expect(budget?.budgetNanoUsd).toBe(usdToNanoUsd(50));
    expect(budget?.spentNanoUsd).toBe(chargedU2);
  });
});

describe('seed producers are idempotent', () => {
  it('re-running the same specs creates nothing and leaves the balance unchanged', async () => {
    const fixture = await setupFixture();
    const specs = paymentSpecs();
    await seedPaymentsHistory(
      { db },
      {
        userId: fixture.userId,
        purchasedWalletId: fixture.walletId,
        payments: specs,
      }
    );

    const rerun = await seedPaymentsHistory(
      { db },
      {
        userId: fixture.userId,
        purchasedWalletId: fixture.walletId,
        payments: specs,
      }
    );
    expect(rerun.paymentsCreated).toBe(0);

    const paymentRows = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.userId, fixture.userId));
    expect(paymentRows).toHaveLength(2);

    const [wallet] = await db
      .select({ balanceNanoUsd: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.id, fixture.walletId));
    expect(wallet?.balanceNanoUsd).toBe(usdToNanoUsd(14));
  });
});
