import { ResultAsync } from '../../../lib/result/index.js';
import { DAILY_ALLOWANCE_NANO_USD } from './constants.js';
import { utcDayKey, utcMonthKey } from './period.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { BillingStores } from '../ports/index.js';
import type { BudgetScope } from './admission.js';

/**
 * The billing-side budget-resolution reader: it turns the period-keyed
 * spending rows into the `BudgetScope[]` admission consumes. It is read-only —
 * it computes a run's remaining headroom per scope from the rows written at
 * settlement (no resets, rollover is a fresh period key). The engine's
 * admission hook (Wave 2c) calls this to build `AdmissionRequest.budgets`.
 *
 * Two ceilings actually gate a run: the free-tier daily allowance (cap is the
 * `DAILY_ALLOWANCE_NANO_USD` constant) and a group member's per-period budget
 * (cap snapshotted on the period row). Conversation spending is tracked for
 * accounting, not capped, so it produces no scope.
 */

export interface MemberBudgetScopeRequest {
  readonly memberId: string;
  /**
   * The configured cap, used only as the fresh-period fallback: once a period
   * row exists its snapshotted `budgetNanoUsd` is the cap in effect.
   */
  readonly capNanoUsd: bigint;
}

export interface BudgetResolutionRequest {
  readonly now: Date;
  /** Present for free-wallet runs — the daily allowance ceiling applies. */
  readonly allowance?: { readonly userId: string };
  /** Present for group-member runs — the per-period member budget applies. */
  readonly memberBudget?: MemberBudgetScopeRequest;
}

/** Remaining headroom is never negative — an overspent period reads as zero. */
function clampNonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

export function resolveBudgetScopes(
  stores: BillingStores,
  db: Database,
  request: BudgetResolutionRequest
): ResultAsync<readonly BudgetScope[], DomainError> {
  const scopes: ResultAsync<BudgetScope, DomainError>[] = [];

  if (request.allowance !== undefined) {
    const { userId } = request.allowance;
    const day = utcDayKey(request.now);
    scopes.push(
      stores.readAllowanceSpent(db, userId, day).map((spent) => ({
        scopeId: `allowance:${userId}:${day}`,
        remainingNanoUsd: clampNonNegative(DAILY_ALLOWANCE_NANO_USD - spent),
      }))
    );
  }

  if (request.memberBudget !== undefined) {
    const { memberId, capNanoUsd } = request.memberBudget;
    const month = utcMonthKey(request.now);
    scopes.push(
      stores.readMemberBudget(db, memberId, month).map((row) => {
        const cap = row?.budgetNanoUsd ?? capNanoUsd;
        const spent = row?.spentNanoUsd ?? 0n;
        return {
          scopeId: `member:${memberId}:${month}`,
          remainingNanoUsd: clampNonNegative(cap - spent),
        };
      })
    );
  }

  return ResultAsync.combine(scopes);
}
