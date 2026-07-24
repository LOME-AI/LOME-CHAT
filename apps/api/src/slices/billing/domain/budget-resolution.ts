import { ResultAsync } from '../../../lib/result/index.js';
import { DAILY_ALLOWANCE_NANO_USD } from './constants.js';
import { utcDayKey } from './period.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { BillingStores } from '../ports/index.js';
import type { BudgetScope } from './admission.js';

/**
 * The billing-side budget-resolution reader: it turns the spending rows into the
 * `BudgetScope[]` admission consumes. It is read-only — it computes a run's
 * remaining headroom per requested scope. The engine's admission hook (chat's
 * `runtime.ts`) calls this to build `AdmissionRequest.budgets`, and the admission
 * Lua gates the run against the `Math.min` of every scope's remaining (plus the
 * owner wallet balance, gated separately by the caller).
 *
 * Three ceilings can gate a run, each an independent scope:
 * - the free-tier daily allowance (period-keyed; cap is `DAILY_ALLOWANCE_NANO_USD`);
 * - a group member's DURABLE, cumulative-forever per-member budget (cap + spent on
 *   the one row); and
 * - the DURABLE, cumulative-forever per-conversation budget (spend on the one row,
 *   cap supplied by the caller from `conversations.conversationBudgetNanoUsd` —
 *   billing never reads the conversations table).
 *
 * Absent-cap = deny (remaining 0), expressible by the caller for both group
 * dimensions:
 * - member: an absent durable row reads as a zero cap here, so remaining is 0.
 *   The caller opts a group-member run into the gate by including `memberBudget`;
 *   the zero-cap deny for an unconfigured member is materialized here.
 * - conversation: the caller passes the per-conversation cap; a 0n cap (no
 *   configured budget) yields remaining 0.
 */

export interface MemberBudgetScopeRequest {
  readonly memberId: string;
}

export interface ConversationBudgetScopeRequest {
  readonly conversationId: string;
  /**
   * The per-conversation cap, supplied by the caller from
   * `conversations.conversationBudgetNanoUsd` (billing never reads that table).
   * Pass 0n to signal no configured budget — the scope then denies (remaining 0).
   */
  readonly capNanoUsd: bigint;
}

export interface BudgetResolutionRequest {
  readonly now: Date;
  /** Present for free-wallet runs — the daily allowance ceiling applies. */
  readonly allowance?: { readonly userId: string };
  /** Present for group-member runs — the durable per-member budget applies. */
  readonly memberBudget?: MemberBudgetScopeRequest;
  /** Present for group runs — the durable per-conversation budget applies. */
  readonly conversationBudget?: ConversationBudgetScopeRequest;
}

/** Remaining headroom is never negative — an overspent scope reads as zero. */
function clampNonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

/**
 * The one derivation of a group scope's admission scope id, shared by the
 * gate (`resolveBudgetScopes` → admission's scope-holds hash) and the
 * display-side scope-holds reader — the hash the display reads is the hash
 * admission checks-and-adds against, by construction, never by agreement.
 */
export function memberBudgetScopeId(memberId: string): string {
  return `member:${memberId}`;
}

export function conversationBudgetScopeId(conversationId: string): string {
  return `conversation:${conversationId}`;
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
    const { memberId } = request.memberBudget;
    scopes.push(
      stores.readMemberBudget(db, memberId).map((row) => ({
        scopeId: memberBudgetScopeId(memberId),
        // Absent durable row = zero cap = deny (the member-budget contract).
        remainingNanoUsd:
          row === null ? 0n : clampNonNegative(row.budgetNanoUsd - row.spentNanoUsd),
      }))
    );
  }

  if (request.conversationBudget !== undefined) {
    const { conversationId, capNanoUsd } = request.conversationBudget;
    scopes.push(
      stores.readConversationSpent(db, conversationId).map((spent) => ({
        scopeId: conversationBudgetScopeId(conversationId),
        remainingNanoUsd: clampNonNegative(capNanoUsd - spent),
      }))
    );
  }

  return ResultAsync.combine(scopes);
}
