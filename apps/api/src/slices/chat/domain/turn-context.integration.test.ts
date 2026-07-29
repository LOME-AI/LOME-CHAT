import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  epochs,
  ledgerEntries,
  memberBudgets,
  messages,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { applyMarkup } from '@hushbox/shared';
import { chargeWithinTx, createBillingStores } from '../../billing/index.js';
import { createConversationsStores } from '../../conversations/index.js';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { resolveTurnContext } from './turn-context.js';
import type { TurnContext } from './turn-context.js';

/**
 * The payer the turn freezes is the one the billed row records. This exercises
 * the whole producer→row path against real rows — `resolveTurnContext` picks the
 * wallet, `chargeWithinTx` writes the usage record — because the two halves are
 * only correct together: a payer column that disagrees with the charged wallet's
 * owner cannot be aggregated by anyone.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for chat turn-context integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const billing = createBillingStores();
const BYTES = new Uint8Array([9, 9, 9]);
const NOW = new Date('2026-07-24T12:00:00Z');
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected a ${what} row`);
  return row;
}

async function seedUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values({
      email: `${suffix}@turn-context.test`,
      username: `tc${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = first(rows, 'user').id;
  createdUserIds.push(id);
  return id;
}

async function seedWallets(userId: string, purchasedBalanceNanoUsd: bigint): Promise<string> {
  const rows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased', balanceNanoUsd: purchasedBalanceNanoUsd })
    .returning({ id: wallets.id });
  await db.insert(wallets).values({ userId, type: 'free', balanceNanoUsd: 0n });
  return first(rows, 'wallet').id;
}

interface GroupFixture {
  readonly ownerUserId: string;
  readonly ownerWalletId: string;
  readonly memberUserId: string;
  readonly conversationId: string;
  readonly contentItemId: string;
}

/**
 * An owner-funded group conversation: the owner holds the funds and sets both
 * caps; the member sends and holds funds of their own, so a payer resolved from
 * the sender rather than the wallet stays syntactically valid — only the wrong
 * person.
 */
async function seedOwnerFundedGroup(): Promise<GroupFixture> {
  const ownerUserId = await seedUser();
  const ownerWalletId = await seedWallets(ownerUserId, 10_000_000_000n);
  const memberUserId = await seedUser();
  await seedWallets(memberUserId, 10_000_000_000n);

  const conversationRows = await db
    .insert(conversations)
    .values({ userId: ownerUserId, title: BYTES, conversationBudgetNanoUsd: 5_000_000_000n })
    .returning({ id: conversations.id });
  const conversationId = first(conversationRows, 'conversation').id;
  createdConversationIds.push(conversationId);
  await db
    .insert(epochs)
    .values({ conversationId, epochNumber: 1, epochPublicKey: BYTES, confirmationHash: BYTES });
  const memberRows = await db
    .insert(conversationMembers)
    .values({ conversationId, userId: memberUserId, privilege: 'write', visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  await db.insert(memberBudgets).values({
    memberId: first(memberRows, 'member').id,
    budgetNanoUsd: 5_000_000_000n,
    spentNanoUsd: 0n,
  });

  const messageRows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'assistant',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: 1,
    })
    .returning({ id: messages.id });
  const contentRows = await db
    .insert(contentItems)
    .values({
      messageId: first(messageRows, 'message').id,
      contentType: 'text',
      encryptedBlob: BYTES,
    })
    .returning({ id: contentItems.id });

  return {
    ownerUserId,
    ownerWalletId,
    memberUserId,
    conversationId,
    contentItemId: first(contentRows, 'content item').id,
  };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    const walletRows = await db
      .select({ id: wallets.id })
      .from(wallets)
      .where(inArray(wallets.userId, createdUserIds));
    await db.delete(usageRecords).where(inArray(usageRecords.payerUserId, createdUserIds));
    const walletIds = walletRows.map((row) => row.id);
    if (walletIds.length > 0) {
      // Legs are deleted whole transactions at a time — the zero-sum trigger
      // rejects a delete that leaves one side of a pair behind.
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
  }
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

/** The turn the member sends: resolved through the production seam, not hand-built. */
async function memberTurnContext(fixture: GroupFixture): Promise<TurnContext> {
  const resolved = await resolveTurnContext(
    { conversations: createConversationsStores, billing },
    db,
    {
      conversationId: fixture.conversationId,
      sender: { kind: 'user', userId: fixture.memberUserId },
      now: NOW,
      // The fixture's headroom is sized to cover a real turn, so any minimum
      // this small keeps the owner funding it — the payer this file is about.
      minTurnCost: { kind: 'priced', nanoUsd: 1n },
    }
  );
  return resolved._unsafeUnwrap();
}

describe('an owner-funded member turn', () => {
  it('records the owner as the payer and the member as the sender, each queryable alone', async () => {
    const fixture = await seedOwnerFundedGroup();

    const context = await memberTurnContext(fixture);
    expect(context.walletId).toBe(fixture.ownerWalletId);

    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      chargeWithinTx(billing, tx, {
        walletId: context.walletId,
        payerUserId: context.payerUserId,
        sender: { kind: 'user', userId: fixture.memberUserId },
        runId,
        contentItemId: fixture.contentItemId,
        modelId: 'turn-context-test/model',
        providerName: 'turn-context-test-provider',
        modality: 'text',
        billableCostNanoUsd: applyMarkup(1_000_000n),
        storageFeeNanoUsd: 0n,
        isEstimated: false,
        idempotencyKey: `turn-context-test:${runId}`,
        now: NOW,
      })
    );

    // Both sides of the row, read independently: the money side names the owner
    // whose wallet was debited, the activity side the member who sent.
    const payerRows = await db
      .select({ id: usageRecords.id })
      .from(usageRecords)
      .where(eq(usageRecords.payerUserId, fixture.ownerUserId));
    expect(payerRows).toHaveLength(1);
    const senderRows = await db
      .select({ id: usageRecords.id })
      .from(usageRecords)
      .where(eq(usageRecords.senderUserId, fixture.memberUserId));
    expect(senderRows).toEqual(payerRows);
  });

  it('records a payer that is the charged wallet owner, so the two can never disagree', async () => {
    const fixture = await seedOwnerFundedGroup();

    const context = await memberTurnContext(fixture);

    const walletRows = await db
      .select({ userId: wallets.userId })
      .from(wallets)
      .where(eq(wallets.id, context.walletId));
    expect(context.payerUserId).toBe(first(walletRows, 'wallet').userId);
  });
});
