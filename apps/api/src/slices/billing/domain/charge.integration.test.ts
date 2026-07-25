import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  allowanceSpending,
  contentItems,
  conversationMembers,
  conversationSpending,
  conversations,
  createDb,
  epochs,
  ledgerEntries,
  llmCompletions,
  mediaGenerations,
  memberBudgets,
  messages,
  sharedLinks,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { createBillingStores } from '../adapters/stores.js';
import { applyMarkup } from '@hushbox/shared';
import { utcDayKey } from './period.js';
import { chargeWithinTx } from './charge.js';
import type { ChargeInput, ChargeResult } from './charge.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for billing charge integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([1, 2, 3]);
const NOW = new Date('2026-07-03T12:00:00Z');
const MODEL_ID = 'charge-test/model';
const PROVIDER_NAME = 'charge-test-provider';
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];
let counter = 0;

async function seedUser(): Promise<string> {
  counter += 1;
  const username = `blchg${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(counter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@billing-charge.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

async function seedWallet(
  userId: string,
  type: 'purchased' | 'free',
  balanceNanoUsd: bigint
): Promise<string> {
  const rows = await db
    .insert(wallets)
    .values({ userId, type, balanceNanoUsd })
    .returning({ id: wallets.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('wallet seed failed');
  return id;
}

async function seedContentItem(userId: string): Promise<{
  contentItemId: string;
  conversationId: string;
  memberId: string;
}> {
  const conversationRows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = conversationRows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(conversationId);
  await db
    .insert(epochs)
    .values({ conversationId, epochNumber: 1, epochPublicKey: BYTES, confirmationHash: BYTES });
  const memberRows = await db
    .insert(conversationMembers)
    .values({ conversationId, userId, visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  const memberId = memberRows[0]?.id;
  if (memberId === undefined) throw new Error('member seed failed');
  const messageRows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: 1,
    })
    .returning({ id: messages.id });
  const messageId = messageRows[0]?.id;
  if (messageId === undefined) throw new Error('message seed failed');
  const contentRows = await db
    .insert(contentItems)
    .values({ messageId, contentType: 'text', encryptedBlob: BYTES })
    .returning({ id: contentItems.id });
  const contentItemId = contentRows[0]?.id;
  if (contentItemId === undefined) throw new Error('content item seed failed');
  return { contentItemId, conversationId, memberId };
}

interface ChargeFixture {
  userId: string;
  walletId: string;
  contentItemId: string;
  conversationId: string;
  memberId: string;
}

async function seedFixture(
  type: 'purchased' | 'free',
  balanceNanoUsd: bigint
): Promise<ChargeFixture> {
  const userId = await seedUser();
  const walletId = await seedWallet(userId, type, balanceNanoUsd);
  const content = await seedContentItem(userId);
  return { userId, walletId, ...content };
}

function chargeInput(fixture: ChargeFixture, overrides?: Partial<ChargeInput>): ChargeInput {
  return {
    walletId: fixture.walletId,
    userId: fixture.userId,
    // Solo turn by default: the payer is also the sender.
    sender: { kind: 'user', userId: fixture.userId },
    runId: crypto.randomUUID(),
    contentItemId: fixture.contentItemId,
    modelId: MODEL_ID,
    providerName: PROVIDER_NAME,
    modality: 'text',
    billableCostNanoUsd: applyMarkup(1_000_000_000n),
    storageFeeNanoUsd: 0n,
    isEstimated: true,
    idempotencyKey: `charge-test:${crypto.randomUUID()}`,
    now: NOW,
    ...overrides,
  };
}

async function deleteLedgerRowsFor(walletIds: string[]): Promise<void> {
  if (walletIds.length === 0) return;
  const legRows = await db
    .select({ transactionId: ledgerEntries.transactionId })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.walletId, walletIds));
  const transactionIds = [...new Set(legRows.map((row) => row.transactionId))];
  if (transactionIds.length > 0) {
    await db.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, transactionIds));
  }
  await db.delete(wallets).where(inArray(wallets.id, walletIds));
}

async function deleteSeededRows(): Promise<void> {
  if (createdUserIds.length === 0) return;
  const walletRows = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(inArray(wallets.userId, createdUserIds));
  await db.delete(usageRecords).where(inArray(usageRecords.userId, createdUserIds));
  await deleteLedgerRowsFor(walletRows.map((row) => row.id));
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  await db.delete(users).where(inArray(users.id, createdUserIds));
}

afterAll(async () => {
  await deleteSeededRows();
  await db.$client.end();
});

describe('chargeWithinTx', () => {
  it('charges the billable amount as given — no further markup — and debits the wallet', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const input = chargeInput(fixture);
    const result = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    expect(result.alreadyCharged).toBe(false);
    expect(result.chargedNanoUsd).toBe(applyMarkup(1_000_000_000n));
    expect(result.balanceAfterNanoUsd).toBe(10_000_000_000n - 1_150_000_000n);
    // The post-commit snapshot write-through needs the wallet's type (only
    // `free` wallets skip the balance check) — carried on the result.
    expect(result.walletType).toBe('purchased');
    const walletRows = await db.select().from(wallets).where(eq(wallets.id, fixture.walletId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(8_850_000_000n);
    expect(walletRows[0]?.ledgerSeq).toBe(1n);
  });

  it('writes a zero-sum charge leg pair referencing the usage record', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const input = chargeInput(fixture);
    const result = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.usageRecordId, result.usageRecordId));
    expect(legs).toHaveLength(2);
    const total = legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n);
    expect(total).toBe(0n);
    const userLeg = legs.find((leg) => leg.walletId !== null);
    const houseLeg = legs.find((leg) => leg.houseAccount !== null);
    expect(userLeg?.kind).toBe('charge');
    expect(userLeg?.amountNanoUsd).toBe(-1_150_000_000n);
    expect(userLeg?.balanceAfterNanoUsd).toBe(8_850_000_000n);
    expect(houseLeg?.houseAccount).toBe('revenue');
    expect(houseLeg?.balanceAfterNanoUsd).toBeNull();
  });

  it('records the usage with the estimate flag', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const input = chargeInput(fixture, { generationId: 'gen-123' });
    const result = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    const rows = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, result.usageRecordId));
    expect(rows[0]?.isEstimated).toBe(true);
    expect(rows[0]?.costNanoUsd).toBe(1_150_000_000n);
    expect(rows[0]?.generationId).toBe('gen-123');
    expect(rows[0]?.contentItemId).toBe(fixture.contentItemId);
  });

  it('records the payer and a member sender independently on the usage record', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const senderUserId = await seedUser();
    const input = chargeInput(fixture, { sender: { kind: 'user', userId: senderUserId } });
    const result = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    const rows = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, result.usageRecordId));
    // Owner-funded shape: the payer column carries the charged wallet's owner,
    // the sender column carries the member who sent the turn — both queryable
    // without a message join.
    expect(rows[0]?.userId).toBe(fixture.userId);
    expect(rows[0]?.senderUserId).toBe(senderUserId);
    expect(rows[0]?.senderLinkId).toBeNull();
  });

  it('records a link-guest sender as the link principal with no sender user', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const linkRows = await db
      .insert(sharedLinks)
      .values({
        conversationId: fixture.conversationId,
        linkPublicKey: crypto.getRandomValues(new Uint8Array(32)),
      })
      .returning({ id: sharedLinks.id });
    const linkId = linkRows[0]?.id;
    if (linkId === undefined) throw new Error('shared link seed failed');
    const input = chargeInput(fixture, { sender: { kind: 'linkGuest', linkId } });
    const result = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    const rows = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, result.usageRecordId));
    expect(rows[0]?.userId).toBe(fixture.userId);
    expect(rows[0]?.senderLinkId).toBe(linkId);
    expect(rows[0]?.senderUserId).toBeNull();
  });

  it('severs the sender on user deletion via SET NULL, keeping the charge row intact', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const senderUserId = await seedUser();
    const input = chargeInput(fixture, { sender: { kind: 'user', userId: senderUserId } });
    const result = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    const before = await db
      .select({ senderUserId: usageRecords.senderUserId })
      .from(usageRecords)
      .where(eq(usageRecords.id, result.usageRecordId));
    expect(before[0]?.senderUserId).toBe(senderUserId);
    await db.delete(users).where(eq(users.id, senderUserId));
    const rows = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, result.usageRecordId));
    // Pseudonymization doctrine: the financial row survives the sender's hard
    // deletion; only the sender reference is scrubbed.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.senderUserId).toBeNull();
    expect(rows[0]?.userId).toBe(fixture.userId);
    expect(rows[0]?.costNanoUsd).toBe(1_150_000_000n);
  });

  it('adds the storage fee on top of the billable cost without marking it up', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    // 10 chars × 300 nano/char = 3000n additive storage.
    const input = chargeInput(fixture, { storageFeeNanoUsd: 3000n });
    const result = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    const billableModelCost = applyMarkup(1_000_000_000n);
    expect(billableModelCost).toBe(1_150_000_000n);
    // The exact split: charged = billable model cost + un-marked-up storage.
    expect(result.chargedNanoUsd).toBe(1_150_000_000n + 3000n);
    expect(result.chargedNanoUsd - billableModelCost).toBe(3000n);
    const usage = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, result.usageRecordId));
    expect(usage[0]?.costNanoUsd).toBe(1_150_003_000n);
    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.usageRecordId, result.usageRecordId));
    expect(legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
    expect(legs.find((leg) => leg.walletId !== null)?.amountNanoUsd).toBe(-1_150_003_000n);
  });

  it('adds media storage at the per-byte rate additively', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    // 100 bytes × 18 nano/byte = 1800n additive storage.
    const input = chargeInput(fixture, { modality: 'image', storageFeeNanoUsd: 1800n });
    const result = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    expect(result.chargedNanoUsd).toBe(1_150_000_000n + 1800n);
  });

  it('charges an image generation exactly its deterministic billable catalog estimate', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    // Image bills the deterministic billable catalog estimate (no inline
    // provider cost by design, isEstimated=true). The charge must be that
    // estimate EXACTLY — any fee application here would double-mark the
    // already-billable catalog rate (the retired interim ~+32% double markup).
    const billableCatalogEstimate = 46_000_000n;
    const input = chargeInput(fixture, {
      modality: 'image',
      billableCostNanoUsd: billableCatalogEstimate,
      isEstimated: true,
      storageFeeNanoUsd: 0n,
    });
    const result = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    expect(result.chargedNanoUsd).toBe(billableCatalogEstimate);
  });

  it('writes the llm_completions token dimension for a language generation', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const input = chargeInput(fixture, {
      modality: 'text',
      tokens: { inputTokens: 10, outputTokens: 20, reasoningTokens: 3, cachedInputTokens: 2 },
    });
    const result = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    const rows = await db
      .select()
      .from(llmCompletions)
      .where(eq(llmCompletions.usageRecordId, result.usageRecordId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputTokens).toBe(10);
    expect(rows[0]?.outputTokens).toBe(20);
    expect(rows[0]?.reasoningTokens).toBe(3);
    expect(rows[0]?.cachedInputTokens).toBe(2);
  });

  it('writes the media_generations dimension for an image generation', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const input = chargeInput(fixture, {
      modality: 'image',
      media: { imageCount: 2, resolution: '1024x1024' },
    });
    const result = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    const rows = await db
      .select()
      .from(mediaGenerations)
      .where(eq(mediaGenerations.usageRecordId, result.usageRecordId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.modality).toBe('image');
    expect(rows[0]?.imageCount).toBe(2);
    expect(rows[0]?.resolution).toBe('1024x1024');
    expect(rows[0]?.durationMs).toBeNull();
  });

  it('writes the media_generations dimension with duration for a video generation', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const input = chargeInput(fixture, {
      modality: 'video',
      media: { durationMs: 8000, resolution: '1080p' },
    });
    const result = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    const rows = await db
      .select()
      .from(mediaGenerations)
      .where(eq(mediaGenerations.usageRecordId, result.usageRecordId));
    expect(rows[0]?.modality).toBe('video');
    expect(rows[0]?.durationMs).toBe(8000);
    expect(rows[0]?.resolution).toBe('1080p');
  });

  it('does not double-write the token dimension on an idempotent replay', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const input = chargeInput(fixture, {
      modality: 'text',
      tokens: { inputTokens: 7, outputTokens: 9, reasoningTokens: 0, cachedInputTokens: 0 },
    });
    const first = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    const replay = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    expect(replay.alreadyCharged).toBe(true);
    expect(replay.usageRecordId).toBe(first.usageRecordId);
    const rows = await db
      .select()
      .from(llmCompletions)
      .where(eq(llmCompletions.usageRecordId, first.usageRecordId));
    expect(rows).toHaveLength(1);
  });

  it('commits a charge that exceeds the balance and goes negative', async () => {
    const fixture = await seedFixture('purchased', 100n);
    const input = chargeInput(fixture);
    const result = await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    expect(result.balanceAfterNanoUsd).toBe(100n - 1_150_000_000n);
    const walletRows = await db.select().from(wallets).where(eq(wallets.id, fixture.walletId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(-1_149_999_900n);
  });

  it('never double-charges under concurrent replays of one idempotency key', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const input = chargeInput(fixture);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => runSettlement(db, (tx) => chargeWithinTx(stores, tx, input)))
    );
    const fresh = results.filter((result) => !result.alreadyCharged);
    expect(fresh).toHaveLength(1);
    const records = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.idempotencyKey, input.idempotencyKey));
    expect(records).toHaveLength(1);
    const walletRows = await db.select().from(wallets).where(eq(wallets.id, fixture.walletId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(8_850_000_000n);
  });

  it('rejects a zero-sum-violating ledger write at commit', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const error: unknown = await db
      .transaction(async (tx) => {
        await tx.insert(ledgerEntries).values({
          transactionId: crypto.randomUUID(),
          kind: 'charge',
          amountNanoUsd: -500n,
          balanceAfterNanoUsd: 10_000_000_000n - 500n,
          walletId: fixture.walletId,
          idempotencyKey: `unbalanced:${crypto.randomUUID()}`,
        });
      })
      .then(
        () => null,
        (error_: unknown) => error_
      );
    expect(error).not.toBeNull();
    // The deferred constraint trigger raises at COMMIT; the driver wraps it,
    // so the trigger's message sits on the cause chain.
    let message = '';
    let current: unknown = error;
    while (typeof current === 'object' && current !== null) {
      if (current instanceof Error) message += current.message;
      current = (current as { cause?: unknown }).cause;
    }
    expect(message).toMatch(/sum to -?500 \(must be 0\)/);
  });

  it('records free-wallet charges against the daily allowance period row', async () => {
    const fixture = await seedFixture('free', 0n);
    const input = chargeInput(fixture, { billableCostNanoUsd: applyMarkup(10_000_000n) });
    await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    const rows = await db
      .select()
      .from(allowanceSpending)
      .where(eq(allowanceSpending.userId, fixture.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.day).toBe(utcDayKey(NOW));
    expect(rows[0]?.spentNanoUsd).toBe(applyMarkup(10_000_000n));
  });

  it('does not touch allowance rows for purchased-wallet charges', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    await runSettlement(db, (tx) => chargeWithinTx(stores, tx, chargeInput(fixture)));
    const rows = await db
      .select()
      .from(allowanceSpending)
      .where(eq(allowanceSpending.userId, fixture.userId));
    expect(rows).toHaveLength(0);
  });

  it('upserts durable member-budget and conversation rows when scoped', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const input = chargeInput(fixture, {
      memberBudget: { memberId: fixture.memberId, budgetNanoUsd: 5_000_000_000n },
      conversationId: fixture.conversationId,
    });
    await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    const memberRows = await db
      .select()
      .from(memberBudgets)
      .where(eq(memberBudgets.memberId, fixture.memberId));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.spentNanoUsd).toBe(1_150_000_000n);
    expect(memberRows[0]?.budgetNanoUsd).toBe(5_000_000_000n);
    const conversationRows = await db
      .select()
      .from(conversationSpending)
      .where(eq(conversationSpending.conversationId, fixture.conversationId));
    expect(conversationRows).toHaveLength(1);
    expect(conversationRows[0]?.spentNanoUsd).toBe(1_150_000_000n);
  });

  it('accumulates member and conversation spend across distinct charges on one row', async () => {
    const fixture = await seedFixture('purchased', 100_000_000_000n);
    // Two distinct charges (different idempotency keys) to the same member and
    // conversation must accrue cumulatively on the single durable row each. The
    // second charge carries a DIFFERENT cap to prove the on-conflict SET omits the
    // cap unconditionally — a spend never overwrites the owner-set cap, even when the
    // incoming value differs from what is stored.
    const caps = { 'accrue-a': 5_000_000_000n, 'accrue-b': 9_000_000_000n };
    for (const [key, budgetNanoUsd] of Object.entries(caps)) {
      const input = chargeInput(fixture, {
        idempotencyKey: `${fixture.userId}:${key}`,
        memberBudget: { memberId: fixture.memberId, budgetNanoUsd },
        conversationId: fixture.conversationId,
      });
      await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    }
    const memberRows = await db
      .select()
      .from(memberBudgets)
      .where(eq(memberBudgets.memberId, fixture.memberId));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.spentNanoUsd).toBe(2_300_000_000n);
    // The cap from the FIRST charge stands — the differing second cap is ignored.
    expect(memberRows[0]?.budgetNanoUsd).toBe(5_000_000_000n);
    const conversationRows = await db
      .select()
      .from(conversationSpending)
      .where(eq(conversationSpending.conversationId, fixture.conversationId));
    expect(conversationRows).toHaveLength(1);
    expect(conversationRows[0]?.spentNanoUsd).toBe(2_300_000_000n);
  });

  it('does not double-count member spend when the same charge replays', async () => {
    const fixture = await seedFixture('purchased', 10_000_000_000n);
    const input = chargeInput(fixture, {
      memberBudget: { memberId: fixture.memberId, budgetNanoUsd: 5_000_000_000n },
    });
    // A re-executed run replays the identical charge (same idempotency key); the
    // usage record is created once, and member spend accrues inside that guard,
    // so the durable row lands the charge exactly once.
    await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    await runSettlement(db, (tx) => chargeWithinTx(stores, tx, input));
    const memberRows = await db
      .select()
      .from(memberBudgets)
      .where(eq(memberBudgets.memberId, fixture.memberId));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.spentNanoUsd).toBe(1_150_000_000n);
  });

  it('never double-counts concurrent upserts on one durable conversation row', async () => {
    const owner = await seedFixture('purchased', 100_000_000_000n);
    const others = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const userId = await seedUser();
        const walletId = await seedWallet(userId, 'purchased', 100_000_000_000n);
        return { userId, walletId };
      })
    );
    const participants = [{ userId: owner.userId, walletId: owner.walletId }, ...others];
    await Promise.all(
      participants.map((participant) =>
        runSettlement(db, (tx) =>
          chargeWithinTx(stores, tx, {
            ...chargeInput(owner),
            walletId: participant.walletId,
            userId: participant.userId,
            idempotencyKey: `race:${crypto.randomUUID()}`,
            conversationId: owner.conversationId,
          })
        )
      )
    );
    const rows = await db
      .select()
      .from(conversationSpending)
      .where(eq(conversationSpending.conversationId, owner.conversationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spentNanoUsd).toBe(1_150_000_000n * BigInt(participants.length));
  });

  it('needs no mutation to observe a fresh period', async () => {
    const fixture = await seedFixture('free', 0n);
    const spent = await stores.readAllowanceSpent(db, fixture.userId, utcDayKey(NOW));
    expect(spent._unsafeUnwrap()).toBe(0n);
    const rows = await db
      .select()
      .from(allowanceSpending)
      .where(eq(allowanceSpending.userId, fixture.userId));
    expect(rows).toHaveLength(0);
  });
});

/** Extracts a Postgres SQLSTATE from anywhere on a thrown error's cause chain. */
function pgCodeOf(reason: unknown): string | undefined {
  let current: unknown = reason;
  while (typeof current === 'object' && current !== null) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Unwraps both settled settlements, failing loudly if either rejected —
 * surfacing the SQLSTATE so a raw 40001 serialization failure (which the pinned
 * READ COMMITTED + FOR UPDATE model must never produce) is named, not swallowed.
 */
function settlementResults(outcomes: PromiseSettledResult<ChargeResult>[]): ChargeResult[] {
  return outcomes.map((outcome) => {
    if (outcome.status === 'rejected') {
      const code = pgCodeOf(outcome.reason);
      throw new Error(
        `settlement rejected under contention (sqlstate ${code ?? 'none'}): ${String(outcome.reason)}`
      );
    }
    return outcome.value;
  });
}

/** Descending bigint comparator (no nested ternary, `toSorted`-friendly). */
function descendingBigint(a: bigint, b: bigint): number {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

/**
 * Polls pg_stat_activity until `pid`'s backend is genuinely parked on a
 * row-lock wait (`wait_event_type = 'Lock'`) — the state a `SELECT … FOR UPDATE`
 * enters when the target row is locked by another open transaction. Observing
 * this proves the contender REACHED its lock and BLOCKED, rather than assuming
 * it from launch ordering. Throws if it never blocks within the budget, so a
 * contender that failed to serialize (e.g. a dropped `FOR UPDATE`) fails the
 * test loudly instead of leaving the outcome assertions vacuous.
 */
async function waitForBackendBlockedOnLock(pid: number): Promise<void> {
  const deadlineMs = Date.now() + 4000;
  for (;;) {
    const result = await db.execute(
      sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`
    );
    const rows = result.rows as { wait_event_type: string | null }[];
    if (rows.some((row) => row.wait_event_type === 'Lock')) return;
    if (Date.now() >= deadlineMs) {
      throw new Error(`backend ${String(pid)} never blocked on a row-lock wait`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The pinned settlement concurrency model (documented in ARCHITECTURE §Money):
 * settlement runs at Postgres-default READ COMMITTED with NO 40001
 * serialization-failure retry. Correctness under contention rests entirely on
 * the `FOR UPDATE` wallet-row lock `chargeWithinTx` takes (`lockWalletWithinTx`)
 * plus the `DEFERRABLE INITIALLY DEFERRED` zero-sum trigger firing at COMMIT.
 * This test pins that model: two concurrent settlements on the SAME wallet must
 * SERIALIZE on the row lock — no lost update — and no raw serialization failure
 * may surface to the caller. B is held open until pg_stat_activity confirms its
 * backend has genuinely parked on the wallet-row lock wait, so dropping the
 * `FOR UPDATE` (B would then never block and would overwrite A's balance) turns
 * this test red. A future change that switches isolation and surfaces a 40001 at
 * a higher isolation level turns it red too.
 */
describe('settlement concurrency model — FOR UPDATE row-lock serialization', () => {
  it('serializes two concurrent same-wallet charges with no lost update and no 40001', async () => {
    const initialBalance = 10_000_000_000n;
    const fixture = await seedFixture('purchased', initialBalance);
    // The default charge input debits the billable model cost (no storage fee).
    const chargedEach = applyMarkup(1_000_000_000n);
    expect(chargedEach).toBe(1_150_000_000n);
    const afterFirst = initialBalance - chargedEach;
    const afterSecond = afterFirst - chargedEach;

    // Two DISTINCT idempotency keys → both are genuinely fresh charges (not an
    // idempotent replay), so a dropped lock would produce a lost update, not a
    // no-op convergence.
    const inputA = chargeInput(fixture, { idempotencyKey: `serialize-a:${crypto.randomUUID()}` });
    const inputB = chargeInput(fixture, { idempotencyKey: `serialize-b:${crypto.randomUUID()}` });

    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let signalAHoldsLock!: () => void;
    const aHoldsLock = new Promise<void>((resolve) => {
      signalAHoldsLock = resolve;
    });

    // B publishes its backend pid on the SAME connection its FOR UPDATE will run
    // on, so the main flow can observe when that backend parks on the row-lock
    // wait.
    let signalBPid!: (pid: number) => void;
    const bBackendPid = new Promise<number>((resolve) => {
      signalBPid = resolve;
    });

    // A and B must run on SEPARATE connections to actually contend: the dev pool
    // is `max: 1`, so a single `db` would queue B behind A at the pool instead of
    // at the wallet row lock (no real contention). Dedicated connections put the
    // contention where it belongs — on Postgres.
    const dbA = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const dbB = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

    // Settlement A charges (taking the wallet FOR UPDATE lock and writing its
    // new balance), then holds its transaction OPEN — the row lock stays held —
    // until released.
    const settleA = runSettlement(dbA, async (tx) => {
      const result = await chargeWithinTx(stores, tx, inputA);
      signalAHoldsLock();
      await aMayCommit;
      return result;
    });

    await aHoldsLock;
    // Settlement B starts while A still holds the lock. B's first statement
    // reports its backend pid; then chargeWithinTx runs and blocks at its own
    // wallet FOR UPDATE on A's held lock.
    const settleB = runSettlement(dbB, async (tx) => {
      const pidResult = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      const pidRow = pidResult.rows[0] as { pid: number } | undefined;
      if (pidRow === undefined) throw new Error('failed to read B backend pid');
      signalBPid(pidRow.pid);
      return chargeWithinTx(stores, tx, inputB);
    });

    try {
      // Only release A once pg_stat_activity confirms B is genuinely BLOCKED on
      // the wallet-row lock — not merely launched. This is what forces the lock
      // to do the serializing; a launch-then-immediately-release race would let
      // A commit before B ever reached its FOR UPDATE. If the lock were dropped,
      // B would never park here and this throws — the test's real teeth.
      await waitForBackendBlockedOnLock(await bBackendPid);
    } finally {
      // Always release A so both transactions unwind and their connections drain,
      // even when the block was never observed.
      releaseA();
    }

    const outcomes = await Promise.allSettled([settleA, settleB]);
    await dbA.$client.end();
    await dbB.$client.end();
    // No raw 40001 serialization failure surfaced to the caller: correctness
    // comes from the row lock (the second txn blocks then reads committed
    // state), never from optimistic-retry at a higher isolation level.
    const [resultA, resultB] = settlementResults(outcomes);
    if (!resultA || !resultB) throw new Error('expected both settlements to fulfil');

    // Both charges landed as fresh debits — neither collapsed into an idempotent
    // no-op.
    expect(resultA.alreadyCharged).toBe(false);
    expect(resultB.alreadyCharged).toBe(false);
    // A committed first (it held the lock); B necessarily observed A's write —
    // the running balances form a consistent chain, proving no lost update.
    expect(resultA.balanceAfterNanoUsd).toBe(afterFirst);
    expect(resultB.balanceAfterNanoUsd).toBe(afterSecond);

    // The durable wallet reflects BOTH debits and both ledger-sequence bumps.
    const walletRows = await db.select().from(wallets).where(eq(wallets.id, fixture.walletId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(afterSecond);
    expect(walletRows[0]?.ledgerSeq).toBe(2n);

    // Two usage records, each with a zero-sum leg pair (the deferred trigger held
    // at each COMMIT).
    const usage = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.userId, fixture.userId));
    expect(usage).toHaveLength(2);
    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(
        inArray(
          ledgerEntries.usageRecordId,
          usage.map((record) => record.id)
        )
      );
    expect(legs).toHaveLength(4);
    for (const record of usage) {
      const recordLegs = legs.filter((leg) => leg.usageRecordId === record.id);
      expect(recordLegs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
    }
    // The two user-wallet legs' running balances are exactly the serialized
    // chain — never two legs both stamped `afterFirst` (the lost-update shape).
    const userLegBalances = legs
      .filter((leg) => leg.walletId !== null)
      .map((leg) => leg.balanceAfterNanoUsd ?? 0n)
      .toSorted(descendingBigint);
    expect(userLegBalances).toEqual([afterFirst, afterSecond]);
  }, 15_000);
});
