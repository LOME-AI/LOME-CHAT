import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  allowanceSpending,
  conversationMembers,
  conversationSpending,
  conversations,
  createDb,
  epochs,
  memberBudgets,
  users,
} from '@hushbox/db';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { createBillingStores } from '../adapters/stores.js';
import { DAILY_ALLOWANCE_NANO_USD } from './constants.js';
import { utcDayKey } from './period.js';
import { resolveBudgetScopes } from './budget-resolution.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for billing budget-resolution integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([1, 2, 3]);
const NOW = new Date('2026-07-04T12:00:00Z');
const DAY = utcDayKey(NOW);
const MEMBER_BUDGET = 10_000_000_000n;
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];
let counter = 0;

async function seedUser(): Promise<string> {
  counter += 1;
  const username = `blbud${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(counter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@billing-budget.test`,
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

async function seedMember(userId: string): Promise<{ conversationId: string; memberId: string }> {
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
  return { conversationId, memberId };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(allowanceSpending).where(inArray(allowanceSpending.userId, createdUserIds));
  }
  if (createdConversationIds.length > 0) {
    await db
      .delete(conversationSpending)
      .where(inArray(conversationSpending.conversationId, createdConversationIds));
    const memberRows = await db
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .where(inArray(conversationMembers.conversationId, createdConversationIds));
    const memberIds = memberRows.map((row) => row.id);
    if (memberIds.length > 0) {
      await db.delete(memberBudgets).where(inArray(memberBudgets.memberId, memberIds));
      await db.delete(conversationMembers).where(inArray(conversationMembers.id, memberIds));
    }
    await db.delete(epochs).where(inArray(epochs.conversationId, createdConversationIds));
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('resolveBudgetScopes (integration)', () => {
  it('reads remaining allowance from the accrued daily row', async () => {
    const userId = await seedUser();
    await runSettlement(db, (tx) =>
      stores.addSpendingWithinTx(tx, { scope: 'allowance', userId, day: DAY }, 20_000_000n)
    );
    const result = await resolveBudgetScopes(stores, db, { now: NOW, allowance: { userId } });
    expect(result._unsafeUnwrap()[0]?.remainingNanoUsd).toBe(
      DAILY_ALLOWANCE_NANO_USD - 20_000_000n
    );
  });

  it('reads remaining member budget from the durable per-member row', async () => {
    const userId = await seedUser();
    const { memberId } = await seedMember(userId);
    await runSettlement(db, (tx) =>
      stores.addSpendingWithinTx(
        tx,
        { scope: 'member', memberId, budgetNanoUsd: MEMBER_BUDGET },
        4_000_000_000n
      )
    );
    const result = await resolveBudgetScopes(stores, db, {
      now: NOW,
      memberBudget: { memberId },
    });
    const scopes = result._unsafeUnwrap();
    expect(scopes[0]?.scopeId).toBe(`member:${memberId}`);
    expect(scopes[0]?.remainingNanoUsd).toBe(MEMBER_BUDGET - 4_000_000_000n);
  });

  it('denies (remaining 0) a member with no durable budget row', async () => {
    const userId = await seedUser();
    const { memberId } = await seedMember(userId);
    const result = await resolveBudgetScopes(stores, db, {
      now: NOW,
      memberBudget: { memberId },
    });
    expect(result._unsafeUnwrap()[0]?.remainingNanoUsd).toBe(0n);
  });

  it('accumulates member spend across sequential charges on one durable row', async () => {
    const userId = await seedUser();
    const { memberId } = await seedMember(userId);
    for (const amount of [3_000_000_000n, 2_000_000_000n]) {
      await runSettlement(db, (tx) =>
        stores.addSpendingWithinTx(
          tx,
          { scope: 'member', memberId, budgetNanoUsd: MEMBER_BUDGET },
          amount
        )
      );
    }
    const rows = await db.select().from(memberBudgets).where(eq(memberBudgets.memberId, memberId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spentNanoUsd).toBe(5_000_000_000n);
    // The owner-set cap survives the spend upserts unchanged.
    expect(rows[0]?.budgetNanoUsd).toBe(MEMBER_BUDGET);
  });

  it('a member spend upsert never clobbers the owner-set cap', async () => {
    const userId = await seedUser();
    const { memberId } = await seedMember(userId);
    // First spend establishes the row with the owner-set cap.
    await runSettlement(db, (tx) =>
      stores.addSpendingWithinTx(
        tx,
        { scope: 'member', memberId, budgetNanoUsd: MEMBER_BUDGET },
        1_000_000_000n
      )
    );
    // A later spend carrying a DIFFERENT cap value must not overwrite the stored cap.
    await runSettlement(db, (tx) =>
      stores.addSpendingWithinTx(
        tx,
        { scope: 'member', memberId, budgetNanoUsd: 1n },
        1_000_000_000n
      )
    );
    const rows = await db.select().from(memberBudgets).where(eq(memberBudgets.memberId, memberId));
    expect(rows[0]?.budgetNanoUsd).toBe(MEMBER_BUDGET);
    expect(rows[0]?.spentNanoUsd).toBe(2_000_000_000n);
  });

  it('resolves the per-conversation scope from the caller cap minus durable spend', async () => {
    const userId = await seedUser();
    const { conversationId } = await seedMember(userId);
    await runSettlement(db, (tx) =>
      stores.addSpendingWithinTx(tx, { scope: 'conversation', conversationId }, 1_500_000_000n)
    );
    const result = await resolveBudgetScopes(stores, db, {
      now: NOW,
      conversationBudget: { conversationId, capNanoUsd: MEMBER_BUDGET },
    });
    const scopes = result._unsafeUnwrap();
    expect(scopes[0]?.scopeId).toBe(`conversation:${conversationId}`);
    expect(scopes[0]?.remainingNanoUsd).toBe(MEMBER_BUDGET - 1_500_000_000n);
  });
});

describe('addSpendingWithinTx consumption race', () => {
  const RUNS = 8;
  const AMOUNT = 1_000_000n;

  it('never double-counts concurrent member-budget upserts on one durable row', async () => {
    const userId = await seedUser();
    const { memberId } = await seedMember(userId);
    await Promise.all(
      Array.from({ length: RUNS }, () =>
        runSettlement(db, (tx) =>
          stores.addSpendingWithinTx(
            tx,
            { scope: 'member', memberId, budgetNanoUsd: MEMBER_BUDGET },
            AMOUNT
          )
        )
      )
    );
    const rows = await db.select().from(memberBudgets).where(eq(memberBudgets.memberId, memberId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spentNanoUsd).toBe(AMOUNT * BigInt(RUNS));
  });

  it('never double-counts concurrent conversation upserts on one durable row', async () => {
    const userId = await seedUser();
    const { conversationId } = await seedMember(userId);
    await Promise.all(
      Array.from({ length: RUNS }, () =>
        runSettlement(db, (tx) =>
          stores.addSpendingWithinTx(tx, { scope: 'conversation', conversationId }, AMOUNT)
        )
      )
    );
    const rows = await db
      .select()
      .from(conversationSpending)
      .where(eq(conversationSpending.conversationId, conversationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spentNanoUsd).toBe(AMOUNT * BigInt(RUNS));
  });

  it('never double-counts concurrent allowance upserts on one period row', async () => {
    const userId = await seedUser();
    await Promise.all(
      Array.from({ length: RUNS }, () =>
        runSettlement(db, (tx) =>
          stores.addSpendingWithinTx(tx, { scope: 'allowance', userId, day: DAY }, AMOUNT)
        )
      )
    );
    const rows = await db
      .select()
      .from(allowanceSpending)
      .where(and(eq(allowanceSpending.userId, userId), eq(allowanceSpending.day, DAY)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spentNanoUsd).toBe(AMOUNT * BigInt(RUNS));
  });
});
