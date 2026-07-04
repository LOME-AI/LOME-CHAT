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
import { utcDayKey, utcMonthKey } from './period.js';
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
const MONTH = utcMonthKey(NOW);
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

  it('reads remaining member budget from the accrued period row', async () => {
    const userId = await seedUser();
    const { memberId } = await seedMember(userId);
    await runSettlement(db, (tx) =>
      stores.addSpendingWithinTx(
        tx,
        { scope: 'member', memberId, month: MONTH, budgetNanoUsd: MEMBER_BUDGET },
        4_000_000_000n
      )
    );
    const result = await resolveBudgetScopes(stores, db, {
      now: NOW,
      memberBudget: { memberId, capNanoUsd: MEMBER_BUDGET },
    });
    expect(result._unsafeUnwrap()[0]?.remainingNanoUsd).toBe(MEMBER_BUDGET - 4_000_000_000n);
  });

  it('returns the full request cap for a member with no accrued period row', async () => {
    const userId = await seedUser();
    const { memberId } = await seedMember(userId);
    const result = await resolveBudgetScopes(stores, db, {
      now: NOW,
      memberBudget: { memberId, capNanoUsd: MEMBER_BUDGET },
    });
    expect(result._unsafeUnwrap()[0]?.remainingNanoUsd).toBe(MEMBER_BUDGET);
  });
});

describe('addSpendingWithinTx consumption race', () => {
  const RUNS = 8;
  const AMOUNT = 1_000_000n;

  it('never double-counts concurrent member-budget upserts on one period row', async () => {
    const userId = await seedUser();
    const { memberId } = await seedMember(userId);
    await Promise.all(
      Array.from({ length: RUNS }, () =>
        runSettlement(db, (tx) =>
          stores.addSpendingWithinTx(
            tx,
            { scope: 'member', memberId, month: MONTH, budgetNanoUsd: MEMBER_BUDGET },
            AMOUNT
          )
        )
      )
    );
    const rows = await db
      .select()
      .from(memberBudgets)
      .where(and(eq(memberBudgets.memberId, memberId), eq(memberBudgets.month, MONTH)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spentNanoUsd).toBe(AMOUNT * BigInt(RUNS));
  });

  it('never double-counts concurrent conversation upserts on one period row', async () => {
    const userId = await seedUser();
    const { conversationId } = await seedMember(userId);
    await Promise.all(
      Array.from({ length: RUNS }, () =>
        runSettlement(db, (tx) =>
          stores.addSpendingWithinTx(
            tx,
            { scope: 'conversation', conversationId, month: MONTH },
            AMOUNT
          )
        )
      )
    );
    const rows = await db
      .select()
      .from(conversationSpending)
      .where(
        and(
          eq(conversationSpending.conversationId, conversationId),
          eq(conversationSpending.month, MONTH)
        )
      );
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
