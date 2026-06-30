/**
 * Billing reservation gate shared between text and media pipelines.
 *
 * Each modality computes its own pre-reservation worst case upstream (text:
 * per-token worst case from the gateway model list + Smart Model resolution;
 * media: a flat per-output cost from the per-model price map). All modalities
 * then land here for the common gate: resolve the funding source, mismatch-
 * check against the client, then either personal or group budget reservation,
 * with a post-reservation race guard and a release-on-failure flow.
 */

import {
  ERROR_CODE_BALANCE_RESERVED,
  ERROR_CODE_BILLING_MISMATCH,
  effectiveBudgetCents,
  getCushionCents,
  resolveBilling,
} from '@hushbox/shared';
import { createErrorResponse } from './error-response.js';
import {
  reserveBudget,
  releaseBudget,
  reserveGroupBudget,
  releaseGroupBudget,
  type GroupBudgetReservation,
} from './speculative-balance.js';
import type { DenialReason, FundingSource, ResolveBillingInput, UserTier } from '@hushbox/shared';
import type { Context } from 'hono';
import type { Redis } from '@upstash/redis';
import type { AppEnv } from '../types.js';
import type { BuildBillingResult, MemberContext } from '../services/billing/index.js';

/** Builds the 402 response for a billing denial. Caller-supplied so test
 * fixtures can stub error-shape generation independently. */
export type HandleBillingDenialFunction = (
  c: Context<AppEnv>,
  reason: DenialReason,
  billingInput: ResolveBillingInput
) => Response;

export interface ReservationFailure {
  success: false;
  response: Response;
}

export interface ReservationSuccess {
  success: true;
  worstCaseCents: number;
  groupBudget?: GroupBudgetReservation;
  billingUserId: string;
}

export type ReservationResult = ReservationSuccess | ReservationFailure;

interface ReservationContext {
  redis: Redis;
  c: Context<AppEnv>;
  billingResult: BuildBillingResult;
  worstCaseCents: number;
  payerTier: UserTier;
}

export async function reserveGroupBudgetWithGuard(
  ctx: ReservationContext,
  memberContext: MemberContext,
  conversationId: string
): Promise<ReservationResult> {
  const { redis, c, billingResult, worstCaseCents, payerTier } = ctx;
  const groupReservation: GroupBudgetReservation = {
    conversationId,
    memberId: memberContext.memberId,
    payerId: memberContext.ownerId,
    costCents: worstCaseCents,
  };
  const reservedTotals = await reserveGroupBudget(redis, groupReservation);
  const budgetCtx = billingResult.groupBudgetContext;
  if (!budgetCtx) throw new Error('invariant: groupBudgetContext required for group billing');
  const postReservationEffective = effectiveBudgetCents({
    conversationRemainingCents:
      Number.parseFloat(budgetCtx.conversationBudget) * 100 -
      Number.parseFloat(budgetCtx.conversationSpent) * 100 -
      reservedTotals.conversationTotal,
    memberRemainingCents:
      Number.parseFloat(budgetCtx.memberBudget) * 100 -
      Number.parseFloat(budgetCtx.memberSpent) * 100 -
      reservedTotals.memberTotal,
    ownerRemainingCents: budgetCtx.ownerBalanceCents - reservedTotals.payerTotal,
  });
  const cushionCents = getCushionCents(payerTier);
  if (postReservationEffective < -cushionCents) {
    await releaseGroupBudget(redis, groupReservation);
    return {
      success: false,
      response: c.json(createErrorResponse(ERROR_CODE_BALANCE_RESERVED), 402),
    };
  }
  return {
    success: true,
    worstCaseCents,
    groupBudget: groupReservation,
    billingUserId: memberContext.ownerId,
  };
}

export async function reservePersonalBudgetWithGuard(
  ctx: ReservationContext,
  userId: string,
  fundingSource: FundingSource
): Promise<ReservationResult> {
  const { redis, c, billingResult, worstCaseCents, payerTier } = ctx;
  const newTotalReserved = await reserveBudget(redis, userId, worstCaseCents);
  const availableCents =
    fundingSource === 'free_allowance'
      ? billingResult.rawFreeAllowanceCents
      : billingResult.rawUserBalanceCents;
  const finalEffective = availableCents - newTotalReserved;
  const cushionCents = getCushionCents(payerTier);
  if (finalEffective < -cushionCents) {
    await releaseBudget(redis, userId, worstCaseCents);
    return {
      success: false,
      response: c.json(createErrorResponse(ERROR_CODE_BALANCE_RESERVED), 402),
    };
  }
  return {
    success: true,
    worstCaseCents,
    billingUserId: userId,
  };
}

export interface ReserveAfterDecisionInput {
  billingResult: BuildBillingResult;
  userId: string;
  worstCaseCents: number;
  clientFundingSource: FundingSource;
  memberContext?: MemberContext;
  conversationId?: string;
}

export interface DecisionDenial {
  success: false;
  response: Response;
}

export interface DecisionProceed {
  success: true;
  fundingSource: FundingSource;
  isGroupBilling: boolean;
  payerTier: UserTier;
}

export interface DecideFundingSourceInput {
  c: Context<AppEnv>;
  billingResult: BuildBillingResult;
  worstCaseCents: number;
  clientFundingSource: FundingSource;
  handleBillingDenial: HandleBillingDenialFunction;
}

/**
 * Run resolveBilling()'s funding-source decision and short-circuit on
 * denial / mismatch. Returns the resolved fundingSource + payerTier when the
 * decision proceeds; caller is responsible for actually reserving budget.
 */
export function decideFundingSource(
  input: DecideFundingSourceInput
): DecisionProceed | DecisionDenial {
  const { c, billingResult, worstCaseCents, clientFundingSource, handleBillingDenial } = input;
  billingResult.input.estimatedMinimumCostCents = worstCaseCents;
  const billingDecision = resolveBilling(billingResult.input);

  if (billingDecision.fundingSource === 'denied') {
    return {
      success: false,
      response: handleBillingDenial(c, billingDecision.reason, billingResult.input),
    };
  }

  if (clientFundingSource !== billingDecision.fundingSource) {
    return {
      success: false,
      response: c.json(
        createErrorResponse(ERROR_CODE_BILLING_MISMATCH, {
          serverFundingSource: billingDecision.fundingSource,
        }),
        409
      ),
    };
  }

  const isGroupBilling =
    billingDecision.fundingSource === 'owner_balance' && billingResult.input.group !== undefined;
  const payerTier =
    isGroupBilling && billingResult.input.group
      ? billingResult.input.group.ownerTier
      : billingResult.input.tier;

  return {
    success: true,
    fundingSource: billingDecision.fundingSource,
    isGroupBilling,
    payerTier,
  };
}

/**
 * Common pre-reservation checks shared by image/video/audio billing resolvers.
 * Returns a validated reservation OR a failure response, letting each
 * modality-specific caller append its own result shape.
 */
export async function reserveMediaBilling(
  c: Context<AppEnv>,
  input: ReserveAfterDecisionInput,
  handleBillingDenial: HandleBillingDenialFunction
): Promise<ReservationResult> {
  const decision = decideFundingSource({
    c,
    billingResult: input.billingResult,
    worstCaseCents: input.worstCaseCents,
    clientFundingSource: input.clientFundingSource,
    handleBillingDenial,
  });
  if (!decision.success) return decision;

  const reservationCtx: ReservationContext = {
    redis: c.get('redis'),
    c,
    billingResult: input.billingResult,
    worstCaseCents: input.worstCaseCents,
    payerTier: decision.payerTier,
  };

  if (decision.isGroupBilling && input.memberContext && input.conversationId) {
    return reserveGroupBudgetWithGuard(reservationCtx, input.memberContext, input.conversationId);
  }
  return reservePersonalBudgetWithGuard(reservationCtx, input.userId, decision.fundingSource);
}
