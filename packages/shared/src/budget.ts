/**
 * Budget calculation utilities for pre-send validation.
 *
 * Used by both frontend (real-time UI updates) and backend (validation before the AI Gateway call).
 * All cost calculations use prices with fees already applied.
 */

import {
  MAX_ALLOWED_NEGATIVE_BALANCE_CENTS,
  MAX_TRIAL_MESSAGE_COST_CENTS,
  MINIMUM_OUTPUT_TOKENS,
  LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
  CAPACITY_RED_THRESHOLD,
  STORAGE_COST_PER_CHARACTER,
} from './constants.js';
import { applyFees } from './pricing.js';
import type { UserTier } from './tiers.js';
import type { FundingSource, ResolveBillingResult, DenialReason } from './resolve-billing.js';

export interface NotificationInput {
  billingResult: ResolveBillingResult;
  capacityPercent: number;
  maxOutputTokens: number;
  privilege?: 'read' | 'write' | 'admin' | 'owner';
  hasDelegatedBudget?: boolean;
}

export interface ModelPricingWithContext extends ManifestModelPricing {
  /** Model's maximum context length in tokens */
  contextLength: number;
}

export interface BudgetCalculationInput {
  /** User's tier: 'trial', 'guest', 'free', or 'paid' */
  tier: UserTier;
  /** User's primary balance in cents */
  balanceCents: number;
  /** User's free daily allowance remaining in cents */
  freeAllowanceCents: number;
  /** Total character count: system prompt + history + user message */
  promptCharacterCount: number;
  /** Models to include in budget calculation (1 to MAX_SELECTED_MODELS) */
  models: ModelPricingWithContext[];
  /** Per-search cost in USD (with fees applied). 0 or omitted if search disabled. */
  webSearchCost?: number;
  /**
   * Worst-case cents reserved for pre-inference stages (e.g., Smart Model
   * classifier) that bill separately. The inference budget is sized against
   * `balance - preReservedCents` so the sum `inferenceWorstCase +
   * preReservedCents` fits within the user's effective balance.
   */
  preReservedCents?: number;
}

export interface BudgetCalculationResult {
  /** Maximum output tokens based on personal budget (0 if personal balance insufficient) */
  maxOutputTokens: number;
  /** Estimated input tokens based on tier */
  estimatedInputTokens: number;
  /** Estimated input cost in dollars (model cost + storage cost) */
  estimatedInputCost: number;
  /** Estimated minimum total cost (input + min output) in dollars */
  estimatedMinimumCost: number;
  /** Effective balance including any cushion, in dollars */
  effectiveBalance: number;
  /** Effective cost per output token used by this calculation (model + storage).
   *  Downstream code MUST use this for worst-case cost to maintain the budget invariant. */
  outputCostPerToken: number;
  /** Current usage in tokens (input + min output) */
  currentUsage: number;
  /** Capacity percentage (currentUsage / modelContextLength * 100) */
  capacityPercent: number;
  /**
   * Pre-reserved cents (e.g., Smart Model classifier) deducted from balance
   * before sizing inference. Echoed back from input — callers reading
   * `totalWorstCaseCents` rely on this for the sum.
   */
  preReservedCents: number;
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

/**
 * A fixed cost item known before generation starts.
 * Examples: input tokens, input storage, web search, image input.
 */
export interface FixedCostItem {
  /** Cost category identifier */
  type: string;
  /** Number of units (tokens, characters, images, searches) */
  units: number;
  /** Cost per unit in USD (before fees) */
  costPerUnit: number;
  /** Whether the total fee rate (TOTAL_FEE_RATE) applies to this cost */
  applyFees: boolean;
}

/**
 * A variable cost item that scales with output token count.
 * Examples: output tokens, output storage.
 */
export interface VariableCostItem {
  /** Cost category identifier */
  type: string;
  /** Cost per output token in USD (before fees) */
  costPerUnit: number;
  /** Whether the total fee rate (TOTAL_FEE_RATE) applies to this cost */
  applyFees: boolean;
}

/**
 * A cost manifest describing all costs for a request as line items.
 * Separates "what costs exist" from "how to calculate budget from costs".
 *
 * Adding a new cost type (images, audio, etc.) means adding a line item
 * to the appropriate array — the budget calculation function is unchanged.
 */
export interface CostManifest {
  /** Costs known before generation (input tokens, storage, search, etc.) */
  fixedItems: FixedCostItem[];
  /** Costs that scale with output token count (output tokens, output storage) */
  variableItems: VariableCostItem[];
}

/**
 * Characters-per-token ratio for a given tier.
 * Single source of truth for token↔character conversion.
 * Conservative (2) for free/trial/guest since we absorb overruns.
 * Standard (4) for paid users.
 */
export function charsPerTokenForTier(tier: UserTier): number {
  return tier === 'paid' ? CHARS_PER_TOKEN_STANDARD : CHARS_PER_TOKEN_CONSERVATIVE;
}

/**
 * Estimate token count based on user tier.
 * Uses conservative (2 chars/token) for free/trial users since we absorb overruns.
 * Uses standard (4 chars/token) for paid users.
 */
export function estimateTokensForTier(tier: UserTier, characterCount: number): number {
  if (characterCount === 0) return 0;
  return Math.ceil(characterCount / charsPerTokenForTier(tier));
}

/**
 * Output-storage chars-per-token, tier-inverted from {@link charsPerTokenForTier}:
 * paid → CONSERVATIVE (2), free/trial/guest → STANDARD (4). Output storage is
 * sized with the opposite ratio to input — a paid turn reserves the tighter
 * (more-tokens) output-storage estimate. Single source for the inversion.
 */
export function outputCharsPerTokenForTier(tier: UserTier): number {
  return tier === 'paid' ? CHARS_PER_TOKEN_CONSERVATIVE : CHARS_PER_TOKEN_STANDARD;
}

/**
 * Negative-balance cushion by tier. Only paid users get the $0.50 cushion.
 * Single source of truth — used by getEffectiveBalance and race guards in chat.ts.
 */
export function getCushionCents(tier: UserTier): number {
  return tier === 'paid' ? MAX_ALLOWED_NEGATIVE_BALANCE_CENTS : 0;
}

/**
 * Calculate effective balance based on tier.
 * - Trial: Fixed max cost per message ($0.01)
 * - Guest: Fixed max cost per message ($0.01) — guests use delegated budget
 * - Free: Free allowance only, no cushion
 * - Paid: Balance + $0.50 cushion
 *
 * @returns Effective balance in dollars
 */
export function getEffectiveBalance(
  tier: UserTier,
  balanceCents: number,
  freeAllowanceCents: number
): number {
  switch (tier) {
    case 'trial':
    case 'guest': {
      return MAX_TRIAL_MESSAGE_COST_CENTS / 100;
    }
    case 'free': {
      return freeAllowanceCents / 100;
    }
    case 'paid': {
      return (balanceCents + getCushionCents('paid')) / 100;
    }
  }
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
 * Maps the output of `resolveBilling()` plus capacity/privilege context
 * into an array of user-facing notification messages.
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

export interface ManifestModelPricing {
  /** Model's input price per token (with fees already applied) */
  modelInputPricePerToken: number;
  /** Model's output price per token (with fees already applied) */
  modelOutputPricePerToken: number;
}

export interface BuildCostManifestInput {
  /** User's tier for token estimation */
  tier: UserTier;
  /** Total character count: system prompt + history + user message */
  promptCharacterCount: number;
  /** Models to include in cost calculation (1 to MAX_SELECTED_MODELS) */
  models: ManifestModelPricing[];
  /** Per-search cost in USD (with fees already applied). 0 or omitted if search disabled. */
  webSearchCost?: number;
}

/**
 * Build a cost manifest describing all costs for a request.
 * Single source of truth for cost structure — replaces inline formulas.
 *
 * All prices are fee-inclusive (fees applied before calling this function).
 * Manifest items use applyFees=false since fees are already baked in.
 * Future cost types with base prices can use applyFees=true.
 */
export function buildCostManifest(input: BuildCostManifestInput): CostManifest {
  const { tier, promptCharacterCount, models, webSearchCost = 0 } = input;

  const modelCount = models.length;
  const estimatedInputTokens = estimateTokensForTier(tier, promptCharacterCount);

  // Sum input prices across all models — each model charges for the same input tokens
  const sumInputPrice = models.reduce((sum, m) => sum + m.modelInputPricePerToken, 0);

  const fixedItems: FixedCostItem[] = [
    {
      type: 'text-input-tokens',
      units: estimatedInputTokens,
      costPerUnit: sumInputPrice,
      applyFees: false,
    },
    {
      type: 'input-storage',
      units: promptCharacterCount,
      costPerUnit: STORAGE_COST_PER_CHARACTER,
      applyFees: false,
    },
  ];

  if (webSearchCost > 0) {
    fixedItems.push({
      type: 'web-search',
      units: modelCount,
      costPerUnit: webSearchCost,
      applyFees: false,
    });
  }

  // Output storage chars-per-token is tier-inverted (single source below).
  const outputCharsPerToken = outputCharsPerTokenForTier(tier);

  // Sum output prices across all models — each model generates output tokens
  const sumOutputPrice = models.reduce((sum, m) => sum + m.modelOutputPricePerToken, 0);

  const variableItems: VariableCostItem[] = [
    {
      type: 'text-output-tokens',
      costPerUnit: sumOutputPrice,
      applyFees: false,
    },
    {
      type: 'output-storage',
      costPerUnit: outputCharsPerToken * STORAGE_COST_PER_CHARACTER * modelCount,
      applyFees: false,
    },
  ];

  return { fixedItems, variableItems };
}

export interface ManifestBudgetResult {
  /** Total fixed cost (input tokens + storage + search) in dollars */
  totalFixedCost: number;
  /** Cost per output token (model + storage) in dollars */
  variableCostPerToken: number;
  /** Estimated minimum cost (fixed + MINIMUM_OUTPUT_TOKENS * variable) in dollars */
  estimatedMinimumCost: number;
  /** Maximum output tokens the balance can cover (0 if insufficient) */
  maxOutputTokens: number;
}

/**
 * Calculate budget from a cost manifest.
 * Pure math — sums fixed costs, computes variable cost per token,
 * derives maxOutputTokens and minimumCost.
 *
 * @param manifest - Cost line items
 * @param effectiveBalance - What the user can spend, in dollars
 * @returns Budget calculation results
 */
export function calculateBudgetFromManifest(
  manifest: CostManifest,
  effectiveBalance: number
): ManifestBudgetResult {
  let totalFixedCost = 0;
  for (const item of manifest.fixedItems) {
    const raw = item.units * item.costPerUnit;
    totalFixedCost += item.applyFees ? applyFees(raw) : raw;
  }

  let variableCostPerToken = 0;
  for (const item of manifest.variableItems) {
    const raw = item.costPerUnit;
    variableCostPerToken += item.applyFees ? applyFees(raw) : raw;
  }

  const estimatedMinimumCost = totalFixedCost + MINIMUM_OUTPUT_TOKENS * variableCostPerToken;

  const personalCanAfford = effectiveBalance >= estimatedMinimumCost;
  let maxOutputTokens = 0;
  if (personalCanAfford) {
    const remainingBudget = effectiveBalance - totalFixedCost;
    maxOutputTokens = Math.floor(remainingBudget / variableCostPerToken);
  }

  return { totalFixedCost, variableCostPerToken, estimatedMinimumCost, maxOutputTokens };
}

export interface CanAffordModelInput {
  /** User's tier */
  tier: UserTier;
  /** User's primary balance in cents */
  balanceCents: number;
  /** User's free daily allowance remaining in cents */
  freeAllowanceCents: number;
  /** Total character count: system prompt + history + user message */
  promptCharacterCount: number;
  /** Model's input price per token (with fees applied) */
  modelInputPricePerToken: number;
  /** Model's output price per token (with fees applied) */
  modelOutputPricePerToken: number;
  /** Whether the model is premium (requires paid tier) */
  isPremium: boolean;
  /** Per-search cost in USD (with fees applied). 0 or omitted if search disabled. */
  webSearchCost?: number;
}

export interface CanAffordModelResult {
  /** Whether the user can afford to send a message with this model */
  affordable: boolean;
  /** Estimated minimum cost in dollars */
  estimatedMinimumCost: number;
  /** Maximum output tokens the user's balance can cover */
  maxOutputTokens: number;
}

/**
 * Single function answering "can this user send a message with this model?"
 *
 * Combines premium gating + budget calculation. Used by `validateBilling`
 * for affordability checks.
 */
export function canAffordModel(input: CanAffordModelInput): CanAffordModelResult {
  const {
    tier,
    balanceCents,
    freeAllowanceCents,
    promptCharacterCount,
    modelInputPricePerToken,
    modelOutputPricePerToken,
    isPremium,
    webSearchCost,
  } = input;

  // Premium models require paid tier
  if (isPremium && tier !== 'paid') {
    return { affordable: false, estimatedMinimumCost: 0, maxOutputTokens: 0 };
  }

  const manifestInput: BuildCostManifestInput = {
    tier,
    promptCharacterCount,
    models: [{ modelInputPricePerToken, modelOutputPricePerToken }],
  };
  if (webSearchCost !== undefined) {
    manifestInput.webSearchCost = webSearchCost;
  }
  const manifest = buildCostManifest(manifestInput);

  const effectiveBalance = getEffectiveBalance(tier, balanceCents, freeAllowanceCents);
  const result = calculateBudgetFromManifest(manifest, effectiveBalance);

  return {
    affordable: result.maxOutputTokens > 0,
    estimatedMinimumCost: result.estimatedMinimumCost,
    maxOutputTokens: result.maxOutputTokens,
  };
}

/**
 * Calculate budget math for a message.
 * Pure math only — no billing decisions or notifications.
 * Used by frontend for real-time UI and backend for cost estimation.
 *
 * Internally builds a CostManifest and calculates from it.
 * This preserves the existing API while using the manifest pattern.
 *
 * Billing decisions (can you send? who pays?) are handled by `resolveBilling()`.
 * Notifications (what to show the user) are handled by `generateNotifications()`.
 *
 * @param input - All inputs needed for budget calculation
 * @returns Math results: tokens, costs, capacity, max output tokens
 */
export function calculateBudget(input: BudgetCalculationInput): BudgetCalculationResult {
  const {
    tier,
    balanceCents,
    freeAllowanceCents,
    promptCharacterCount,
    models,
    webSearchCost = 0,
    preReservedCents = 0,
  } = input;

  // Stage reservations (e.g., Smart Model classifier) get deducted FIRST so
  // the inference budget below can never sum past the user's balance when
  // worst-case is added back: `worstCase = inferenceWorstCase +
  // preReservedCents ≤ balance`. Without this, the post-reservation cushion
  // guard fails by exactly `preReservedCents`.
  const stageBalanceCents = Math.max(0, balanceCents - preReservedCents);
  const stageFreeAllowanceCents = Math.max(0, freeAllowanceCents - preReservedCents);

  // 1. Build manifest and calculate
  const manifest = buildCostManifest({
    tier,
    promptCharacterCount,
    models,
    webSearchCost,
  });

  const effectiveBalance = getEffectiveBalance(tier, stageBalanceCents, stageFreeAllowanceCents);
  const manifestResult = calculateBudgetFromManifest(manifest, effectiveBalance);

  // 2. Extract estimatedInputTokens from the manifest's text-input-tokens item
  const inputTokenItem = manifest.fixedItems.find((item) => item.type === 'text-input-tokens');
  const estimatedInputTokens = inputTokenItem?.units ?? 0;

  // 3. Calculate capacity using the most restrictive model context length
  const modelContextLength = Math.min(...models.map((m) => m.contextLength));
  const capacityInputTokens = Math.ceil(promptCharacterCount / CHARS_PER_TOKEN_STANDARD);
  const currentUsage = capacityInputTokens + MINIMUM_OUTPUT_TOKENS;
  const capacityPercent = modelContextLength > 0 ? (currentUsage / modelContextLength) * 100 : 0;

  return {
    maxOutputTokens: manifestResult.maxOutputTokens,
    estimatedInputTokens,
    estimatedInputCost: manifestResult.totalFixedCost,
    estimatedMinimumCost: manifestResult.estimatedMinimumCost,
    effectiveBalance,
    outputCostPerToken: manifestResult.variableCostPerToken,
    currentUsage,
    capacityPercent,
    preReservedCents,
  };
}

export interface ComputeMaxTokensParams {
  /** Max output tokens based on user's budget */
  budgetMaxTokens: number;
  /** Model's maximum context length in tokens */
  modelContextLength: number;
  /** Estimated input tokens (system prompt + history + user message) */
  estimatedInputTokens: number;
}

/**
 * Compute safe max_tokens value for the AI Gateway request.
 *
 * No headroom reduction — `calculateBudget` uses `Math.floor` on the token
 * calculation which already guarantees `worstCaseCents ≤ availableCents`.
 *
 * @returns undefined if budget exceeds remaining context (omit max_tokens, let model use default)
 * @returns budgetMaxTokens if budget is the limiting factor
 */
export function computeSafeMaxTokens(params: ComputeMaxTokensParams): number | undefined {
  const remainingContext = params.modelContextLength - params.estimatedInputTokens;

  if (params.budgetMaxTokens >= remainingContext) {
    return undefined;
  }

  return params.budgetMaxTokens;
}

export interface EffectiveBudgetParams {
  /** conversationBudget - conversationSpent - conversationReserved. */
  conversationRemainingCents: number;
  /** memberBudget - memberSpent - memberReserved. 0 when no member_budgets row exists. */
  memberRemainingCents: number;
  /** ownerBalance - ownerReserved. */
  ownerRemainingCents: number;
}

/**
 * Calculates the effective remaining budget a member can spend.
 * All inputs should be NET values (raw budget minus spent minus reserved).
 * Returns min of all constraints.
 */
export function effectiveBudgetCents(params: EffectiveBudgetParams): number {
  return Math.min(
    params.conversationRemainingCents,
    params.memberRemainingCents,
    params.ownerRemainingCents
  );
}
