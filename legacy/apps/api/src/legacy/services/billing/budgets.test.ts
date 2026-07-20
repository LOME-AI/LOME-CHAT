import { describe, it, expect } from 'vitest';
import {
  getConversationBudgets,
  updateMemberBudget,
  updateConversationBudget,
  updateGroupSpending,
  computeGroupRemaining,
} from './budgets.js';

/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */

/**
 * Generic Drizzle query chain factory.
 * Each call to select()/insert()/update() returns a chain where terminal
 * operations (.then or .limit().then) resolve with the next entry from selectResults.
 */
function createQueryChainFactory(
  selectResults: unknown[][],
  indexRef: { value: number }
): () => Record<string, unknown> {
  const createQueryChain = (): Record<string, unknown> => ({
    from: () => createQueryChain(),
    where: () => createQueryChain(),
    leftJoin: () => createQueryChain(),
    orderBy: () => createQueryChain(),
    limit: () => ({
      then: (resolve: (v: unknown[]) => unknown) => {
        const result = selectResults[indexRef.value++] ?? [];
        return Promise.resolve(resolve(result));
      },
    }),
    then: (resolve: (v: unknown[]) => unknown) => {
      const result = selectResults[indexRef.value++] ?? [];
      return Promise.resolve(resolve(result));
    },
  });
  return createQueryChain;
}

/**
 * Creates a mock DB for insert-based flows (updateMemberBudget).
 * Captures values() calls for assertion.
 */
function createInsertMockDb(): {
  db: unknown;
  getValuesArg: () => unknown;
} {
  let capturedValues: unknown = null;

  const db = {
    insert: () => ({
      values: (vals: unknown) => {
        capturedValues = vals;
        return {
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([{ id: 'budget-1' }]),
          }),
        };
      },
    }),
  };

  return { db, getValuesArg: () => capturedValues };
}

describe('getConversationBudgets', () => {
  it('returns member budgets as raw dollar strings', async () => {
    const indexRef = { value: 0 };
    const selectResults: unknown[][] = [
      // Query 0: active members LEFT JOIN memberBudgets
      [
        {
          memberId: 'member-1',
          userId: 'user-1',
          linkId: null,
          privilege: 'owner',
          budget: '10.00',
          spent: '2.50000000',
        },
        {
          memberId: 'member-2',
          userId: 'user-2',
          linkId: null,
          privilege: 'write',
          budget: '5.00',
          spent: '1.00000000',
        },
      ],
      // Query 1: conversationSpending
      [{ totalSpent: '3.50000000' }],
      // Query 2: conversation budget (default)
      [{ conversationBudget: '0.00' }],
    ];
    const createQueryChain = createQueryChainFactory(selectResults, indexRef);
    const db = { select: () => createQueryChain() };

    const result = await getConversationBudgets(db as never, 'conv-1');

    expect(result.conversationBudget).toBe('0.00');
    expect(result.totalSpent).toBe('3.50000000');
    expect(result.memberBudgets).toHaveLength(2);
    expect(result.memberBudgets[0]).toEqual({
      memberId: 'member-1',
      userId: 'user-1',
      linkId: null,
      privilege: 'owner',
      budget: '10.00',
      spent: '2.50000000',
    });
    expect(result.memberBudgets[1]).toEqual({
      memberId: 'member-2',
      userId: 'user-2',
      linkId: null,
      privilege: 'write',
      budget: '5.00',
      spent: '1.00000000',
    });
  });

  it('returns default budget when member has no budget row (LEFT JOIN miss)', async () => {
    const indexRef = { value: 0 };
    const selectResults: unknown[][] = [
      // Query 0: member with null budget (LEFT JOIN, no budget row)
      [
        {
          memberId: 'member-1',
          userId: 'user-1',
          linkId: null,
          privilege: 'owner',
          budget: null,
          spent: null,
        },
      ],
      // Query 1: no spending record
      [],
      // Query 2: conversation budget (default)
      [{ conversationBudget: '0.00' }],
    ];
    const createQueryChain = createQueryChainFactory(selectResults, indexRef);
    const db = { select: () => createQueryChain() };

    const result = await getConversationBudgets(db as never, 'conv-1');

    expect(result.totalSpent).toBe('0');
    expect(result.memberBudgets).toHaveLength(1);
    expect(result.memberBudgets[0]).toEqual({
      memberId: 'member-1',
      userId: 'user-1',
      linkId: null,
      privilege: 'owner',
      budget: '0.00',
      spent: '0',
    });
  });

  it('returns zero budget string when member budget is explicitly $0.00', async () => {
    const indexRef = { value: 0 };
    const selectResults: unknown[][] = [
      // Query 0: member with explicit $0 budget
      [
        {
          memberId: 'member-1',
          userId: 'user-1',
          linkId: null,
          privilege: 'write',
          budget: '0.00',
          spent: '0.00000000',
        },
      ],
      // Query 1: no spending record
      [],
      // Query 2: conversation budget (default)
      [{ conversationBudget: '0.00' }],
    ];
    const createQueryChain = createQueryChainFactory(selectResults, indexRef);
    const db = { select: () => createQueryChain() };

    const result = await getConversationBudgets(db as never, 'conv-1');

    expect(result.memberBudgets[0]).toEqual({
      memberId: 'member-1',
      userId: 'user-1',
      linkId: null,
      privilege: 'write',
      budget: '0.00',
      spent: '0.00000000',
    });
  });

  it('returns empty memberBudgets when no active members', async () => {
    const indexRef = { value: 0 };
    const selectResults: unknown[][] = [
      // Query 0: no members
      [],
      // Query 1: no spending record
      [],
      // Query 2: conversation budget (default)
      [{ conversationBudget: '0.00' }],
    ];
    const createQueryChain = createQueryChainFactory(selectResults, indexRef);
    const db = { select: () => createQueryChain() };

    const result = await getConversationBudgets(db as never, 'conv-1');

    expect(result.totalSpent).toBe('0');
    expect(result.memberBudgets).toHaveLength(0);
  });

  it('handles link-based member (userId null, linkId present)', async () => {
    const indexRef = { value: 0 };
    const selectResults: unknown[][] = [
      // Query 0: link-based member
      [
        {
          memberId: 'member-1',
          userId: null,
          linkId: 'link-abc',
          privilege: 'read',
          budget: null,
          spent: null,
        },
      ],
      // Query 1: spending record
      [{ totalSpent: '0.00000000' }],
      // Query 2: conversation budget (default)
      [{ conversationBudget: '0.00' }],
    ];
    const createQueryChain = createQueryChainFactory(selectResults, indexRef);
    const db = { select: () => createQueryChain() };

    const result = await getConversationBudgets(db as never, 'conv-1');

    expect(result.memberBudgets[0]).toEqual({
      memberId: 'member-1',
      userId: null,
      linkId: 'link-abc',
      privilege: 'read',
      budget: '0.00',
      spent: '0',
    });
  });

  it('returns conversation budget from conversations table when set', async () => {
    const indexRef = { value: 0 };
    const selectResults: unknown[][] = [
      // Query 0: active members LEFT JOIN memberBudgets
      [
        {
          memberId: 'member-1',
          userId: 'user-1',
          linkId: null,
          privilege: 'owner',
          budget: null,
          spent: null,
        },
      ],
      // Query 1: conversationSpending
      [{ totalSpent: '1.00000000' }],
      // Query 2: conversation budget lookup
      [{ conversationBudget: '25.00' }],
    ];
    const createQueryChain = createQueryChainFactory(selectResults, indexRef);
    const db = { select: () => createQueryChain() };

    const result = await getConversationBudgets(db as never, 'conv-1');

    expect(result.conversationBudget).toBe('25.00');
    expect(result.totalSpent).toBe('1.00000000');
  });

  it('returns zero conversation budget when default value in DB', async () => {
    const indexRef = { value: 0 };
    const selectResults: unknown[][] = [
      // Query 0: active members LEFT JOIN memberBudgets
      [],
      // Query 1: conversationSpending
      [],
      // Query 2: conversation budget lookup (default 0)
      [{ conversationBudget: '0.00' }],
    ];
    const createQueryChain = createQueryChainFactory(selectResults, indexRef);
    const db = { select: () => createQueryChain() };

    const result = await getConversationBudgets(db as never, 'conv-1');

    expect(result.conversationBudget).toBe('0.00');
  });

  it('returns zero conversation budget when conversation row is missing', async () => {
    const indexRef = { value: 0 };
    const selectResults: unknown[][] = [
      // Query 0: active members LEFT JOIN memberBudgets
      [],
      // Query 1: conversationSpending
      [],
      // Query 2: conversation budget lookup (no row — edge case)
      [],
    ];
    const createQueryChain = createQueryChainFactory(selectResults, indexRef);
    const db = { select: () => createQueryChain() };

    const result = await getConversationBudgets(db as never, 'conv-1');

    expect(result.conversationBudget).toBe('0.00');
  });

  it('preserves sub-cent spending precision', async () => {
    const indexRef = { value: 0 };
    const selectResults: unknown[][] = [
      // Query 0: member with sub-cent spending
      [
        {
          memberId: 'member-1',
          userId: 'user-1',
          linkId: null,
          privilege: 'write',
          budget: '5.00',
          spent: '0.00037360',
        },
      ],
      // Query 1: conversationSpending with sub-cent value
      [{ totalSpent: '0.00037360' }],
      // Query 2: conversation budget
      [{ conversationBudget: '10.00' }],
    ];
    const createQueryChain = createQueryChainFactory(selectResults, indexRef);
    const db = { select: () => createQueryChain() };

    const result = await getConversationBudgets(db as never, 'conv-1');

    // Sub-cent values preserved as exact dollar strings
    expect(result.totalSpent).toBe('0.00037360');
    expect(result.memberBudgets[0]!.spent).toBe('0.00037360');
  });
});

describe('updateMemberBudget', () => {
  it('calls insert with upsert pattern', async () => {
    const { db } = createInsertMockDb();

    await expect(updateMemberBudget(db as never, 'member-1', 500)).resolves.toBeUndefined();
  });

  it('converts cents to dollars (2 decimal places) for DB storage', async () => {
    const { db, getValuesArg } = createInsertMockDb();

    await updateMemberBudget(db as never, 'member-1', 1050);

    const values = getValuesArg() as { memberId: string; budget: string };
    expect(values.memberId).toBe('member-1');
    expect(values.budget).toBe('10.50');
  });

  it('stores zero budget correctly', async () => {
    const { db, getValuesArg } = createInsertMockDb();

    await updateMemberBudget(db as never, 'member-1', 0);

    const values = getValuesArg() as { memberId: string; budget: string };
    expect(values.budget).toBe('0.00');
  });

  it('handles large cent values', async () => {
    const { db, getValuesArg } = createInsertMockDb();

    await updateMemberBudget(db as never, 'member-1', 999_999);

    const values = getValuesArg() as { memberId: string; budget: string };
    expect(values.budget).toBe('9999.99');
  });
});

describe('updateConversationBudget', () => {
  function createUpdateMockDb(): {
    db: unknown;
    getSetArg: () => unknown;
  } {
    let capturedSet: unknown = null;

    const db = {
      update: () => ({
        set: (vals: unknown) => {
          capturedSet = vals;
          return {
            where: () => Promise.resolve(),
          };
        },
      }),
    };

    return { db, getSetArg: () => capturedSet };
  }

  it('converts cents to dollars for DB storage', async () => {
    const { db, getSetArg } = createUpdateMockDb();

    await updateConversationBudget(db as never, 'conv-1', 2500);

    const setArgument = getSetArg() as { conversationBudget: string | null };
    expect(setArgument.conversationBudget).toBe('25.00');
  });

  it('stores zero budget correctly', async () => {
    const { db, getSetArg } = createUpdateMockDb();

    await updateConversationBudget(db as never, 'conv-1', 0);

    const setArgument = getSetArg() as { conversationBudget: string };
    expect(setArgument.conversationBudget).toBe('0.00');
  });

  it('handles large cent values', async () => {
    const { db, getSetArg } = createUpdateMockDb();

    await updateConversationBudget(db as never, 'conv-1', 999_999);

    const setArgument = getSetArg() as { conversationBudget: string };
    expect(setArgument.conversationBudget).toBe('9999.99');
  });
});

describe('updateGroupSpending', () => {
  /**
   * Creates a mock DB that supports two sequential insert().values().onConflictDoUpdate() chains.
   * Captures the values() args for both calls.
   */
  function createDoubleInsertMockDb(): {
    db: unknown;
    getCapturedValues: () => unknown[];
  } {
    const capturedValues: unknown[] = [];

    const db = {
      insert: () => ({
        values: (vals: unknown) => {
          capturedValues.push(vals);
          return {
            onConflictDoUpdate: () => Promise.resolve(),
          };
        },
      }),
    };

    return { db, getCapturedValues: () => capturedValues };
  }

  it('upserts conversation_spending with cost amount', async () => {
    const { db, getCapturedValues } = createDoubleInsertMockDb();

    await updateGroupSpending(db as never, {
      conversationId: 'conv-1',
      memberId: 'member-1',
      costDollars: '0.05000000',
    });

    const values = getCapturedValues();
    expect(values).toHaveLength(2);

    // First insert: conversation_spending
    const convSpending = values[0] as { conversationId: string; totalSpent: string };
    expect(convSpending.conversationId).toBe('conv-1');
    expect(convSpending.totalSpent).toBe('0.05000000');
  });

  it('upserts member_budgets with cost amount as spent', async () => {
    const { db, getCapturedValues } = createDoubleInsertMockDb();

    await updateGroupSpending(db as never, {
      conversationId: 'conv-1',
      memberId: 'member-1',
      costDollars: '0.05000000',
    });

    const values = getCapturedValues();

    // Second insert: member_budgets
    const memberBudget = values[1] as { memberId: string; budget: string; spent: string };
    expect(memberBudget.memberId).toBe('member-1');
    expect(memberBudget.budget).toBe('0.00');
    expect(memberBudget.spent).toBe('0.05000000');
  });

  it('handles zero cost', async () => {
    const { db, getCapturedValues } = createDoubleInsertMockDb();

    await updateGroupSpending(db as never, {
      conversationId: 'conv-1',
      memberId: 'member-1',
      costDollars: '0.00000000',
    });

    const values = getCapturedValues();
    const convSpending = values[0] as { totalSpent: string };
    const memberBudget = values[1] as { spent: string };
    expect(convSpending.totalSpent).toBe('0.00000000');
    expect(memberBudget.spent).toBe('0.00000000');
  });

  it('passes correct member and conversation IDs', async () => {
    const { db, getCapturedValues } = createDoubleInsertMockDb();

    await updateGroupSpending(db as never, {
      conversationId: 'conv-abc',
      memberId: 'member-xyz',
      costDollars: '1.23456789',
    });

    const values = getCapturedValues();
    const convSpending = values[0] as { conversationId: string };
    const memberBudget = values[1] as { memberId: string };
    expect(convSpending.conversationId).toBe('conv-abc');
    expect(memberBudget.memberId).toBe('member-xyz');
  });
});

/* eslint-enable unicorn/no-thenable */

describe('computeGroupRemaining', () => {
  it('subtracts reserved totals from raw budget values', () => {
    const result = computeGroupRemaining({
      conversationBudget: '10.00',
      conversationSpent: '2.00',
      memberBudget: '5.00',
      memberSpent: '1.00',
      ownerBalanceCents: 5000,
      reserved: { conversationTotal: 50, memberTotal: 25, payerTotal: 300 },
    });

    expect(result).toEqual({
      conversationRemainingCents: 750, // 10*100 - 2*100 - 50
      memberRemainingCents: 375, // 5*100 - 1*100 - 25
      ownerRemainingCents: 4700, // 5000 - 300
    });
  });

  it('computes conversationRemainingCents from default zero budget', () => {
    const result = computeGroupRemaining({
      conversationBudget: '0.00',
      conversationSpent: '2.00',
      memberBudget: '5.00',
      memberSpent: '1.00',
      ownerBalanceCents: 5000,
      reserved: { conversationTotal: 50, memberTotal: 25, payerTotal: 300 },
    });

    expect(result.conversationRemainingCents).toBe(-250); // 0 - 200 - 50
    expect(result.memberRemainingCents).toBe(375);
    expect(result.ownerRemainingCents).toBe(4700);
  });

  it('returns zero memberRemainingCents when memberBudget is zero (no budget row)', () => {
    const result = computeGroupRemaining({
      conversationBudget: '10.00',
      conversationSpent: '0',
      memberBudget: '0.00',
      memberSpent: '0',
      ownerBalanceCents: 5000,
      reserved: { conversationTotal: 0, memberTotal: 0, payerTotal: 0 },
    });

    expect(result.memberRemainingCents).toBe(0);
  });

  it('returns zero memberRemainingCents when memberBudget is zero (explicit $0 cap)', () => {
    const result = computeGroupRemaining({
      conversationBudget: '10.00',
      conversationSpent: '0',
      memberBudget: '0.00',
      memberSpent: '0',
      ownerBalanceCents: 5000,
      reserved: { conversationTotal: 0, memberTotal: 0, payerTotal: 0 },
    });

    expect(result.memberRemainingCents).toBe(0);
  });

  it('handles zero reserved totals', () => {
    const result = computeGroupRemaining({
      conversationBudget: '10.00',
      conversationSpent: '5.00',
      memberBudget: '3.00',
      memberSpent: '1.00',
      ownerBalanceCents: 2000,
      reserved: { conversationTotal: 0, memberTotal: 0, payerTotal: 0 },
    });

    expect(result).toEqual({
      conversationRemainingCents: 500, // 1000 - 500
      memberRemainingCents: 200, // 300 - 100
      ownerRemainingCents: 2000, // 2000 - 0
    });
  });

  it('can produce negative remaining values when overspent', () => {
    const result = computeGroupRemaining({
      conversationBudget: '1.00',
      conversationSpent: '0.80',
      memberBudget: '1.00',
      memberSpent: '0.50',
      ownerBalanceCents: 10,
      reserved: { conversationTotal: 50, memberTotal: 60, payerTotal: 20 },
    });

    expect(result.conversationRemainingCents).toBe(-30); // 100 - 80 - 50
    expect(result.memberRemainingCents).toBe(-10); // 100 - 50 - 60
    expect(result.ownerRemainingCents).toBe(-10); // 10 - 20
  });

  it('preserves sub-cent precision in spending', () => {
    const result = computeGroupRemaining({
      conversationBudget: '10.00',
      conversationSpent: '0.00037360',
      memberBudget: '5.00',
      memberSpent: '0.00037360',
      ownerBalanceCents: 10_000,
      reserved: { conversationTotal: 0, memberTotal: 0, payerTotal: 0 },
    });

    // 10*100 - 0.00037360*100 = 1000 - 0.03736 = 999.96264
    expect(result.conversationRemainingCents).toBeCloseTo(999.962_64, 4);
    // 5*100 - 0.00037360*100 = 500 - 0.03736 = 499.96264
    expect(result.memberRemainingCents).toBeCloseTo(499.962_64, 4);
    expect(result.ownerRemainingCents).toBe(10_000);
  });
});
