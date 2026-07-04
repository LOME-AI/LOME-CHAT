import { describe, expect, it, vi } from 'vitest';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { DAILY_ALLOWANCE_NANO_USD } from './constants.js';
import { resolveBudgetScopes } from './budget-resolution.js';
import type { Database } from '@hushbox/db';
import type { BillingStores } from '../ports/index.js';

const DB = {} as Database;
const NOW = new Date('2026-07-04T12:00:00Z');

function fakeStores(overrides: Partial<BillingStores>): BillingStores {
  return { ...overrides } as unknown as BillingStores;
}

describe('resolveBudgetScopes', () => {
  it('returns no scopes when neither budget is requested', async () => {
    const result = await resolveBudgetScopes(fakeStores({}), DB, { now: NOW });
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('resolves the allowance scope from the daily spend row', async () => {
    const stores = fakeStores({ readAllowanceSpent: () => okAsync(20_000_000n) });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      allowance: { userId: 'user-1' },
    });
    const scopes = result._unsafeUnwrap();
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.remainingNanoUsd).toBe(DAILY_ALLOWANCE_NANO_USD - 20_000_000n);
  });

  it('carries the UTC day period in the allowance scopeId', async () => {
    const stores = fakeStores({ readAllowanceSpent: () => okAsync(0n) });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      allowance: { userId: 'user-1' },
    });
    expect(result._unsafeUnwrap()[0]?.scopeId).toBe('allowance:user-1:2026-07-04');
  });

  it('reads the allowance spend row for the current UTC day', async () => {
    const spy = vi.fn(() => okAsync(0n));
    const stores = fakeStores({ readAllowanceSpent: spy });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      allowance: { userId: 'user-1' },
    });
    expect(result.isOk()).toBe(true);
    expect(spy).toHaveBeenCalledWith(DB, 'user-1', '2026-07-04');
  });

  it('resolves the member scope from the snapshotted period budget row', async () => {
    const stores = fakeStores({
      readMemberBudget: () =>
        okAsync({ budgetNanoUsd: 5_000_000_000n, spentNanoUsd: 1_000_000_000n }),
    });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      memberBudget: { memberId: 'm-1', capNanoUsd: 9999n },
    });
    const scopes = result._unsafeUnwrap();
    expect(scopes).toHaveLength(1);
    // The row's snapshotted cap wins over the request cap.
    expect(scopes[0]?.remainingNanoUsd).toBe(4_000_000_000n);
    expect(scopes[0]?.scopeId).toBe('member:m-1:2026-07');
  });

  it('falls back to the request cap when no member period row exists yet', async () => {
    const stores = fakeStores({ readMemberBudget: () => okAsync(null) });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      memberBudget: { memberId: 'm-1', capNanoUsd: 3_000_000_000n },
    });
    expect(result._unsafeUnwrap()[0]?.remainingNanoUsd).toBe(3_000_000_000n);
  });

  it('clamps a member scope to zero when spend exceeds the cap', async () => {
    const stores = fakeStores({
      readMemberBudget: () => okAsync({ budgetNanoUsd: 1000n, spentNanoUsd: 5000n }),
    });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      memberBudget: { memberId: 'm-1', capNanoUsd: 1000n },
    });
    expect(result._unsafeUnwrap()[0]?.remainingNanoUsd).toBe(0n);
  });

  it('resolves both scopes, allowance before member', async () => {
    const stores = fakeStores({
      readAllowanceSpent: () => okAsync(0n),
      readMemberBudget: () => okAsync({ budgetNanoUsd: 2000n, spentNanoUsd: 0n }),
    });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      allowance: { userId: 'user-1' },
      memberBudget: { memberId: 'm-1', capNanoUsd: 2000n },
    });
    const scopes = result._unsafeUnwrap();
    expect(scopes.map((s) => s.scopeId)).toEqual([
      'allowance:user-1:2026-07-04',
      'member:m-1:2026-07',
    ]);
  });

  it('propagates a store read failure as the domain error', async () => {
    const stores = fakeStores({ readAllowanceSpent: () => errAsync(unavailableError('down')) });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      allowance: { userId: 'user-1' },
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
