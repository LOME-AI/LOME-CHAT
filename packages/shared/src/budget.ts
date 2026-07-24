/**
 * Pre-send notification and max-tokens helpers.
 *
 * `generateNotifications` maps a client billing decision + context onto the
 * user-facing notice vocabulary; `computeSafeMaxTokens` picks the AI-Gateway
 * `max_tokens` for a turn. Cost/affordability math lives in the canonical
 * nano-USD estimator (`packages/shared/src/estimate/`), not here.
 */

import { CAPACITY_RED_THRESHOLD, LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD } from './constants.js';
import type {
  FundingSource,
  ResolveBillingResult,
  DenialReason,
} from './billing/client-billing.js';

export interface NotificationInput {
  billingResult: ResolveBillingResult;
  capacityPercent: number;
  maxOutputTokens: number;
  privilege?: 'read' | 'write' | 'admin' | 'owner';
  hasDelegatedBudget?: boolean;
}

/**
 * A segment of a message, optionally with a link.
 */
export interface MessageSegment {
  /** The text content of this segment */
  text: string;
  /** Route path if this segment should be a clickable link */
  link?: string;
}

export interface BudgetError {
  /** Unique identifier for the error type */
  id: string;
  /** Severity: 'error' blocks send, 'warning' allows, 'info' is informational */
  type: 'warning' | 'error' | 'info';
  /** Human-readable message to display (plain text fallback) */
  message: string;
  /** Structured message with optional links for rendering */
  segments?: MessageSegment[];
}

const DENIAL_NOTIFICATIONS: Record<DenialReason, BudgetError> = {
  premium_requires_balance: {
    id: 'premium_requires_balance',
    type: 'error',
    message: 'This model requires a paid account.',
    segments: [
      { text: 'This model requires a paid account. ' },
      { text: 'Top up', link: '/billing' },
      { text: ' to use premium models.' },
    ],
  },
  insufficient_balance: {
    id: 'insufficient_balance',
    type: 'error',
    message: 'Insufficient balance. Top up or try a more affordable model.',
    segments: [
      { text: 'Insufficient balance. ' },
      { text: 'Top up', link: '/billing' },
      { text: ' or try a more affordable model.' },
    ],
  },
  insufficient_free_allowance: {
    id: 'insufficient_free_allowance',
    type: 'error',
    message:
      "Your free daily usage can't cover this message. Top up or try a shorter conversation.",
    segments: [
      { text: "Your free daily usage can't cover this message. " },
      { text: 'Top up', link: '/billing' },
      { text: ' or try a shorter conversation.' },
    ],
  },
  trial_limit_exceeded: {
    id: 'trial_limit_exceeded',
    type: 'error',
    message: 'This message exceeds the usage limit.',
    segments: [
      { text: 'This message exceeds the usage limit. ' },
      { text: 'Sign up', link: '/signup' },
      { text: ' for more capacity.' },
    ],
  },
  guest_budget_exhausted: {
    id: 'guest_budget_exhausted',
    type: 'error',
    message: 'No budget allocated. Contact the conversation owner.',
    segments: [{ text: 'No budget allocated. Contact the conversation owner.' }],
  },
};

const FUNDING_SOURCE_NOTICES: Partial<Record<FundingSource, BudgetError>> = {
  free_allowance: {
    id: 'free_tier_notice',
    type: 'info',
    message: 'Using free allowance. Top up for longer conversations.',
    segments: [
      { text: 'Using free allowance. ' },
      { text: 'Top up', link: '/billing' },
      { text: ' for longer conversations.' },
    ],
  },
  trial_fixed: {
    id: 'trial_notice',
    type: 'info',
    message: 'Free preview. Sign up for full access.',
    segments: [
      { text: 'Free preview. ' },
      { text: 'Sign up', link: '/signup' },
      { text: ' for full access.' },
    ],
  },
};

const DELEGATED_BUDGET_ACTIVE: BudgetError = {
  id: 'delegated_budget_notice',
  type: 'info',
  message: "You won't be charged. The conversation owner has allocated budget for your messages.",
  segments: [
    {
      text: "You won't be charged. The conversation owner has allocated budget for your messages.",
    },
  ],
};

const DELEGATED_BUDGET_EXHAUSTED: BudgetError = {
  id: 'delegated_budget_exhausted',
  type: 'info',
  message: 'Allocated budget used up. Your personal balance will be used.',
  segments: [{ text: 'Allocated budget used up. Your personal balance will be used.' }],
};

/** Push non-blocking warning notifications (capacity + low balance). */
function pushWarningNotifications(
  notifications: BudgetError[],
  capacityPercent: number,
  fundingSource: FundingSource | 'denied',
  maxOutputTokens: number
): void {
  if (capacityPercent >= CAPACITY_RED_THRESHOLD * 100) {
    notifications.push({
      id: 'capacity_warning',
      type: 'warning',
      message: "Your conversation is near this model's memory limit. Responses may be cut short.",
    });
  }
  if (
    fundingSource === 'personal_balance' &&
    maxOutputTokens < LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD
  ) {
    notifications.push({
      id: 'low_balance',
      type: 'warning',
      message: 'Low balance. Long responses may be shortened.',
    });
  }
}

/** Push info-level notifications (funding source + delegated budget). */
function pushInfoNotifications(
  notifications: BudgetError[],
  fundingSource: FundingSource | 'denied',
  isDenied: boolean,
  hasDelegatedBudget: boolean | undefined
): void {
  if (!isDenied) {
    const notice = FUNDING_SOURCE_NOTICES[fundingSource as FundingSource];
    if (notice) notifications.push(notice);
  }
  if (hasDelegatedBudget === true) {
    notifications.push(
      fundingSource === 'owner_balance' ? DELEGATED_BUDGET_ACTIVE : DELEGATED_BUDGET_EXHAUSTED
    );
  }
}

/**
 * Generate notification messages based on a billing decision and context.
 *
 * Maps a `ResolveBillingResult` (from the client's `resolveClientBilling()`)
 * plus capacity/privilege context into an array of user-facing notification
 * messages.
 */
export function generateNotifications(input: NotificationInput): BudgetError[] {
  const { billingResult, capacityPercent, maxOutputTokens, privilege, hasDelegatedBudget } = input;

  // Read-only members can't send — only show privilege notice
  if (privilege === 'read') {
    return [
      {
        id: 'read_only_notice',
        type: 'info' as const,
        message: 'You have read-only access to this conversation.',
        segments: [{ text: 'You have read-only access to this conversation.' }],
      },
    ];
  }

  const notifications: BudgetError[] = [];
  const isDenied = billingResult.fundingSource === 'denied';
  const isOverCapacity = capacityPercent > 100;

  // 1. Blocking errors
  if (isOverCapacity) {
    notifications.push({
      id: 'capacity_exceeded',
      type: 'error',
      message: 'Message exceeds model capacity. Shorten your message or start a new conversation.',
    });
  }
  if (isDenied) {
    notifications.push(DENIAL_NOTIFICATIONS[billingResult.reason]);
  }

  // 2. Non-blocking warnings (only when no blocking errors)
  if (!isDenied && !isOverCapacity) {
    pushWarningNotifications(
      notifications,
      capacityPercent,
      billingResult.fundingSource,
      maxOutputTokens
    );
  }

  // 3. Info notices (always, even with blocking errors)
  // Suppress "Your personal balance will be used" when guest has no budget —
  // the guest_budget_exhausted denial error already covers it.
  const effectiveHasDelegatedBudget =
    hasDelegatedBudget &&
    !(
      billingResult.fundingSource === 'denied' && billingResult.reason === 'guest_budget_exhausted'
    );
  pushInfoNotifications(
    notifications,
    billingResult.fundingSource,
    isDenied,
    effectiveHasDelegatedBudget
  );

  return notifications;
}

export interface ComputeMaxTokensParams {
  /** Max output tokens based on user's budget */
  budgetMaxTokens: number;
  /** Model's maximum context length in tokens */
  modelContextLength: number;
  /** Estimated input tokens (system prompt + history + user message) */
  estimatedInputTokens: number;
  /**
   * The model's provider completion ceiling (`descriptor.limits
   * .maxOutputTokens`, ingested from the gateway catalog). Bounds the output
   * ceiling together with the remaining context — strict tightening; absent
   * means the context alone bounds (the fallback for uncapped models).
   */
  modelMaxOutputTokens?: number;
}

/**
 * Compute safe max_tokens value for the AI Gateway request.
 *
 * No headroom reduction — the budget max-tokens already floors the token
 * calculation, guaranteeing `worstCaseCents ≤ availableCents`.
 *
 * The output ceiling is the tighter of the remaining context and the model's
 * provider completion cap; a budget at or past it omits the param safely —
 * the provider enforces its own cap, and admission bounds the hold by the
 * same catalog cap.
 *
 * @returns undefined if budget covers the output ceiling (omit max_tokens, let model use default)
 * @returns budgetMaxTokens if budget is the limiting factor
 */
export function computeSafeMaxTokens(params: ComputeMaxTokensParams): number | undefined {
  const remainingContext = params.modelContextLength - params.estimatedInputTokens;
  const outputCeiling =
    params.modelMaxOutputTokens === undefined
      ? remainingContext
      : Math.min(remainingContext, params.modelMaxOutputTokens);

  if (params.budgetMaxTokens >= outputCeiling) {
    return undefined;
  }

  return params.budgetMaxTokens;
}
