import * as React from 'react';
import {
  buildTurnSystemPrompt,
  generateNotifications,
  promptCharacterCount,
  type CanonicalReasoningEffort,
  type Model,
  type BudgetError,
  type FundingSource,
  type MemberPrivilege,
  type ReasoningEffortSelection,
} from '@hushbox/shared';
import { planReasoning } from '@hushbox/shared/affordability/estimate/reasoning-plan';
import {
  useBudgetCalculation,
  type BudgetModelPricing,
} from '@/hooks/billing/use-budget-calculation';
import {
  useConversationBudgets,
  type ConversationBudgetsResponse,
} from '@/hooks/billing/use-conversation-budgets';
import {
  useMediaCostEstimate,
  type UseMediaCostEstimateInput,
} from '@/hooks/billing/use-media-cost-estimate';
import { useResolveBilling } from '@/hooks/billing/use-resolve-billing';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models/models';
import { useSession, useAuthStore } from '@/lib/auth';
import { useWebSearch } from '@/hooks/chat/use-web-search';
import { useTurnOptions } from '@/hooks/billing/use-turn-options.js';
import type { ResolveBillingResult } from '@hushbox/shared';
import type {
  DimensionAvailability,
  NoticeReason,
  PromptBasis,
  TurnOptions,
} from '@hushbox/shared';

interface PromptBudgetInput {
  value: string;
  historyCharacters: number;
  /** Conversation ID for group budget lookup. Omit or null for solo conversations. */
  conversationId?: string | null;
  /** Current user's privilege in the group conversation. Omit for solo conversations. */
  currentUserPrivilege?: MemberPrivilege;
  /**
   * Effective reasoning-effort selection for the composer. An explicit level
   * adds its shared-plan reasoning budget (the largest across the selected
   * models) to the minimum estimate; `none` prices reasoning-free, and
   * `auto`'s server-side placeholder reserve is NOT mirrored here (its
   * resolution order lives server-side; the estimate shows the reasoning-free
   * floor until a level is explicit). Omit when the selected model has no
   * reasoning support.
   */
  reasoningEffort?: ReasoningEffortSelection;
}

export interface PromptBudgetResult {
  fundingSource: FundingSource | 'denied';
  notifications: BudgetError[];
  capacityPercent: number;
  capacityCurrentUsage: number;
  capacityMaxCapacity: number;
  /** The turn's estimated minimum cost, exact nano-USD (decision domain — never displayed). */
  estimatedCostNanoUsd: bigint;
  isOverCapacity: boolean;
  hasBlockingError: boolean;
  /**
   * Why the send is refused, as a TYPED reason, or `undefined` when it may
   * start. It is the producer's own refusal — NOT an inference from the gap
   * between the two sets, which cannot distinguish a hold from a long prompt
   * because the sets differ in funding AND basis. See {@link sendRefusalOf}.
   */
  sendRefusal: NoticeReason | undefined;
  hasContent: boolean;
  /**
   * Affordable output tokens and estimated input tokens from the shared
   * budget core — the effort menu derives per-level feasibility from these
   * through the shared reasoning plan (G5).
   */
  maxOutputTokens: number;
  estimatedInputTokens: number;
  /**
   * The produced effort dimension off `affordable` — the menu's presented set.
   * It rides the greying set, not the hold-aware one, because a hold blocks the
   * SEND and never greys an option (BILLING §Notices 9).
   */
  effortDimension: DimensionAvailability | undefined;
}

function resolveGroupBudgetArgument(
  isGroupMember: boolean,
  conversationId: string | null | undefined
): string | null {
  if (!isGroupMember) return null;
  /* v8 ignore next -- isGroupMember is true only when resolveIsGroupMember saw a non-null conversationId, so the ?? '' fallback is unreachable */
  return conversationId ?? '';
}

/**
 * A non-owner viewer's budgets response carries only their own member row, so
 * the caller's per-member cap is the first (and only) member entry. Absent when
 * the conversation has no member-budget configuration.
 */
function callerMemberRow(
  data: ConversationBudgetsResponse | undefined
): ConversationBudgetsResponse['members'][number] | undefined {
  return data?.members[0];
}

function resolveHasDelegatedBudget(
  isGroupMember: boolean,
  data: ConversationBudgetsResponse | undefined
): boolean {
  const memberRow = callerMemberRow(data);
  return isGroupMember && memberRow !== undefined && BigInt(memberRow.capNanoUsd) > 0n;
}

/**
 * Construct the input shape `useResolveBilling` expects, conditionally
 * including the optional `group` field. Hoisted out of the hook so the
 * conditional spread doesn't bump the hook's cyclomatic complexity past
 * the lint threshold.
 */
function buildBillingResolverInput(args: {
  estimatedCostNanoUsd: bigint;
  isPremiumModel: boolean;
  isAuthenticated: boolean;
}): {
  estimatedMinimumCostNanoUsd: bigint;
  isPremiumModel: boolean;
  isAuthenticated: boolean;
} {
  const { estimatedCostNanoUsd, isPremiumModel, isAuthenticated } = args;
  // The GROUP dimension is deliberately NOT passed. `GET /billing/spendable`
  // already applied §Group Funding 2 server-side and named the payer; feeding a
  // hold-aware group remaining back into the client's funding decision was the
  // same re-resolution removed one layer out, and inside the
  // settle-then-release window it resolved `self` where the server resolves
  // `owner` — telling a member they would be charged for a turn the owner pays,
  // and refusing a link guest a turn admission would admit.
  return { estimatedMinimumCostNanoUsd: estimatedCostNanoUsd, isPremiumModel, isAuthenticated };
}

/**
 * The conversation scope the served funding read is keyed by: a solo composer
 * (or a picker opened outside a conversation) asks for its own numbers.
 */
function conversationScope(conversationId: string | null | undefined): string | null {
  return conversationId ?? null;
}

/**
 * A user is a "group member" for billing purposes when they're a non-owner
 * participant in a group conversation. Owners pay from their own balance
 * regardless; only members route through the group budget gate.
 */
function resolveIsGroupMember(
  conversationId: string | null | undefined,
  privilege: MemberPrivilege | undefined
): boolean {
  if (conversationId == null) return false;
  if (privilege == null) return false;
  return privilege !== 'owner';
}

interface MediaRateArrays {
  imageRatesNano: bigint[];
  videoRatesNano: bigint[];
  audioRatesNano: bigint[];
}

/**
 * Pull per-model BASE (pre-markup) nano rates from the live catalog, mirroring
 * `selectedModels` order. A missing rate falls back to `0n` (model not yet
 * loaded, wrong modality) so the model still counts toward per-model storage
 * while contributing no provider cost — the same "unknown model prices at zero"
 * behavior the catalog has always had. Audio carries no wire provider rate
 * (audio inference is deferred, so `WireModelPricing` exposes none); its cost is
 * therefore storage-only until a wire audio rate lands.
 */
function buildMediaRateArrays(
  selectedModels: readonly { id: string }[],
  modelCatalog: readonly Model[] | undefined,
  videoResolution: string
): MediaRateArrays {
  const findModel = (id: string): Model | undefined => modelCatalog?.find((m) => m.id === id);
  return {
    imageRatesNano: selectedModels.map((sm) => BigInt(findModel(sm.id)?.pricing.perImage ?? '0')),
    videoRatesNano: selectedModels.map((sm) =>
      BigInt(findModel(sm.id)?.pricing.perSecondByResolution?.[videoResolution] ?? '0')
    ),
    audioRatesNano: selectedModels.map(() => 0n),
  };
}

interface PromptBudgetDisplayInputs {
  capacityPercent: number;
  isBalanceLoading: boolean;
  currentUsage: number;
  fundingSource: FundingSource | 'denied';
  isGroupMember: boolean;
  isGroupBudgetPending: boolean;
  modelContextLength: number;
  inputValue: string;
  /** The produced pair. `undefined` while its inputs load. */
  turnOptions: TurnOptions | undefined;
  /** Active holds off the same snapshot — the only evidence a hold exists. */
  heldNanoUsd: bigint;
  /** Whether this turn is text; the produced verdict governs the text arm only. */
  isTextTurn: boolean;
}

interface PromptBudgetDisplayResult {
  isOverCapacity: boolean;
  hasBlockingError: boolean;
  /**
   * Why the send is refused, as a TYPED reason, or `undefined` when it may
   * start. It is the producer's own refusal — NOT an inference from the gap
   * between the two sets, which cannot distinguish a hold from a long prompt
   * because the sets differ in funding AND basis. See {@link sendRefusalOf}.
   */
  sendRefusal: NoticeReason | undefined;
  hasContent: boolean;
  capacityCurrentUsage: number;
  capacityMaxCapacity: number;
}

/**
 * The turn's prompt basis: COUNTS ONLY, which is what keeps content out of the
 * money layer. Custom instructions are already inside the built system prompt,
 * so they are counted there rather than twice.
 */
function promptBasisOf(systemPrompt: string, historyChars: number, value: string): PromptBasis {
  return {
    systemChars: systemPrompt.length,
    instructionChars: 0,
    historyChars,
    inputChars: value.length,
    attachmentBytes: 0,
  };
}

/**
 * Read-only access refuses every paid action outright, ahead of any money
 * question: no balance and no waiting changes it, so it replaces the funding
 * verdict rather than joining it.
 */
function readOnlyOverride(
  isReadOnly: boolean,
  fundingSource: FundingSource | 'denied',
  sendRefusal: NoticeReason | undefined
): { fundingSource: FundingSource | 'denied'; sendRefusal: NoticeReason | undefined } {
  if (!isReadOnly) return { fundingSource, sendRefusal };
  return { fundingSource: 'denied', sendRefusal: 'conversation_read_only' };
}

/**
 * The reason a send is refused, taken from the REFUSAL the producer gave.
 *
 * A hold is claimed ONLY on positive evidence that one exists — `heldNanoUsd`
 * from the same snapshot. The difference between the two option sets cannot
 * establish it: they differ in funding AND prompt basis, so with nothing held
 * `affordable` sends purely because it is evaluated against the EMPTY basis.
 * Reading that gap as a hold told a free user — whose entire daily allowance is
 * 5¢ — to wait for a reply that was not running, on an ordinary long
 * conversation. Waiting never helps there.
 *
 * With nothing held, a funding refusal that the empty basis would have cleared
 * is a LENGTH problem: the funding covers a minimum answer and the prompt is
 * what makes the turn infeasible (§Notices 4 tests the minimum-answer floor
 * first, then attributes to length).
 *
 * Residual, stated rather than hidden: when funds ARE held and the prompt is
 * also long, both causes are live and this names the hold. The hold is the
 * right choice, and the reason is what each notice ASKS THE USER TO DO — not
 * that a hold clears itself, which is only the weaker half.
 *
 * "Wait" costs nothing, is reversible, and becomes true within seconds.
 * "Shorten your message" asks for an irreversible destruction of the user's
 * draft that would NOT unblock the send, because the hold is still there. A
 * false "wait" self-corrects; a false "shorten" leaves the user with less text
 * and the same block. That asymmetry is the whole argument, and it is why a
 * future reader must not reverse this on the grounds that length is "more
 * actionable".
 *
 * What is GUARANTEED, stated exactly: the hold claim is true in every case that
 * reaches it — funds really are held — and it is transient. What is NOT
 * guaranteed is that releasing the hold sends: at a small spendable with a long
 * history, release yields `prompt_too_long` instead. So the notice self-corrects
 * to the length wording rather than to a send. That is still categorically
 * better than the state this replaced, where the claim was false and permanent.
 *
 * Cite §Notices 3 ("waiting is an action"), NOT §Notices 4 — that clause is
 * written about money-versus-length precedence and does not cover
 * hold-versus-length at all.
 */
function sendRefusalOf(
  options: TurnOptions | undefined,
  heldNanoUsd: bigint,
  isTextTurn: boolean
): NoticeReason | undefined {
  // E1 is the TEXT arm. The producer explicitly declines to price a non-text
  // modality (`modality_not_priceable`), so consuming its verdict there would
  // impose the text arm's gate on an arm that has no verdict yet — and this
  // composer is the media composer, so it disabled image and video generation
  // outright. Media keeps the path it had until G2 and E4 land.
  if (!isTextTurn) return undefined;
  if (options === undefined) return undefined;
  if (options.admissible.sendable) return undefined;
  const refusal = options.admissible.refusal;
  if (refusal !== 'insufficient_funds' || !options.affordable.sendable) return refusal;
  return heldNanoUsd > 0n ? 'funds_held_by_run' : 'prompt_too_long';
}

function computePromptBudgetDisplay(inputs: PromptBudgetDisplayInputs): PromptBudgetDisplayResult {
  const isOverCapacity = inputs.capacityPercent > 100;
  const isDenied = inputs.fundingSource === 'denied';
  const isBillingLoading =
    inputs.isBalanceLoading || (inputs.isGroupMember && inputs.isGroupBudgetPending);
  const sendRefusal = sendRefusalOf(inputs.turnOptions, inputs.heldNanoUsd, inputs.isTextTurn);
  const hasBlockingError =
    isDenied || isOverCapacity || isBillingLoading || sendRefusal !== undefined;
  const hasContent = inputs.inputValue.trim().length > 0;

  const hasContext = inputs.modelContextLength > 0;
  const capacityCurrentUsage = hasContext ? inputs.currentUsage : 0;
  const capacityMaxCapacity = hasContext ? inputs.modelContextLength : 1;

  return {
    isOverCapacity,
    hasBlockingError,
    sendRefusal,
    hasContent,
    capacityCurrentUsage,
    capacityMaxCapacity,
  };
}

/**
 * The reasoning token budget B the composer's estimate prices, THROUGH the
 * shared plan (G5): the largest feasible per-level budget across the selected
 * models — matching the server's minimum gate, which counts the turn's
 * largest reasoning budget on top of the minimum answer. Only an explicit
 * canonical level prices a budget: `none` is the hard off (B = 0), and
 * `auto`'s placeholder reserve resolves server-side. A model that does not
 * offer the level contributes nothing (the effort menu greys the option; the server
 * refuses the send — G3, never a substituted level).
 */
function reasoningBudgetInput(
  selection: ReasoningEffortSelection | undefined,
  selectedModels: readonly { id: string }[],
  modelCatalog: readonly Model[] | undefined
): { reasoningBudgetTokens?: number } {
  if (selection === undefined || selection === 'auto' || selection === 'off') return {};
  const level: CanonicalReasoningEffort = selection;
  let largest = 0;
  for (const sm of selectedModels) {
    const model = modelCatalog?.find((m) => m.id === sm.id);
    if (model === undefined) continue;
    const planned = planReasoning(model, level, 1);
    if (planned.feasible) largest = Math.max(largest, planned.plan.reasoningBudgetTokens);
  }
  return largest > 0 ? { reasoningBudgetTokens: largest } : {};
}

/**
 * Map each selected model to its BASE (pre-markup) nano per-token pricing.
 * Missing models (catalog still loading) collapse to zero rates, which produces
 * a $0 estimate rather than NaN downstream.
 */
function buildModelTokenPricing(
  selectedModels: readonly { id: string }[],
  modelCatalog: readonly Model[] | undefined
): BudgetModelPricing[] {
  return selectedModels.map((sm) => {
    const model = modelCatalog?.find((m) => m.id === sm.id);
    return {
      inputPerTokenNano: BigInt(model?.pricing.inputPerToken ?? '0'),
      outputPerTokenNano: BigInt(model?.pricing.outputPerToken ?? '0'),
      contextLength: model?.contextLength ?? 0,
    };
  });
}

/**
 * Build the modality-specific input shape that {@link useMediaCostEstimate}
 * accepts. Returns no media-rate keys for `text`, in which case the cost
 * estimate is 0 and the caller falls back to the token-derived cost.
 */
function buildMediaCostInput(args: {
  activeModality: 'text' | 'image' | 'video' | 'audio';
  rates: MediaRateArrays;
  videoDurationSeconds: number;
  audioMaxDurationSeconds: number;
}): UseMediaCostEstimateInput {
  const { activeModality, rates, videoDurationSeconds, audioMaxDurationSeconds } = args;
  if (activeModality === 'image') {
    return { modality: 'image', imageRatesNano: rates.imageRatesNano };
  }
  if (activeModality === 'video') {
    return {
      modality: 'video',
      videoRatesNano: { ratesNano: rates.videoRatesNano, durationSeconds: videoDurationSeconds },
    };
  }
  if (activeModality === 'audio') {
    return {
      modality: 'audio',
      audioRatesNano: { ratesNano: rates.audioRatesNano, durationSeconds: audioMaxDurationSeconds },
    };
  }
  return { modality: activeModality };
}

/**
 * Restate the client's funding verdict in terms of the payer THE SERVER NAMED.
 *
 * Nothing here decides who pays — `GET /billing/spendable` already applied
 * §Group Funding 2 and returned `payer` alongside the figures. This only picks
 * which sentence describes that answer, which is what §Notices 5 requires:
 * "A change of payer requires an affirmative pre-send disclosure … Switching
 * who pays is not a detail to discover from a balance later."
 *
 * Both disclosures hang off it. An owner-funded turn must not tell a member
 * their own allowance is paying — they are not charged at all — and a member
 * who has fallen through to personal funds must be told so BEFORE sending.
 */
function withServedPayer(
  result: ResolveBillingResult,
  payer: 'self' | 'owner',
  isGroupMember: boolean
): ResolveBillingResult {
  // ORDER IS THE RULE, not an optimisation. When the server says the owner
  // pays, the owner-funded arm is the WHOLE answer, so it must sit ahead of
  // every self-wallet verdict — including the denial early-return below.
  // A patch applied AFTER that return cannot reach the arms that short-circuit
  // into it, which is how the premium lock and the negative-balance block
  // (both statements about the SELF wallet) blocked sends the server admits:
  // §Funding Decision Matrix priority 1 is "Conversation owner pays, premium
  // allowed", and the picker beside the composer already marks those rows
  // available because the served tier is the owner's.
  //
  // The result is replaced rather than spread: a denial carries a `reason`
  // about a wallet that is not paying, and it must not travel with the answer.
  if (payer === 'owner') return { fundingSource: 'owner_balance' };
  if (result.fundingSource === 'denied') return result;
  // Self-funding inside a group conversation IS the fall-through §Notices 5
  // exists for; a solo conversation is simply self-funded and discloses nothing.
  if (!isGroupMember) return result;
  return { ...result, payerSwitch: 'group_headroom_insufficient' };
}

export function usePromptBudget(input: PromptBudgetInput): PromptBudgetResult {
  const activeModality = useModelStore((state) => state.activeModality);
  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  // imageConfig has aspect ratio only — image cost is per-image regardless of
  // ratio, so no need to read it here. Video and audio configs DO drive cost
  // (resolution and duration are billed).
  const videoConfig = useModelStore((state) => state.videoConfig);
  const audioConfig = useModelStore((state) => state.audioConfig);
  const { active: webSearchActive } = useWebSearch();
  const { data: modelsData } = useModels();
  const { data: session, isPending: isSessionPending } = useSession();

  const modelsPricing = buildModelTokenPricing(selectedModels, modelsData?.models);
  const modelContextLength = Math.min(...modelsPricing.map((m) => m.contextLength));
  const isAuthenticated = !isSessionPending && Boolean(session?.user);
  const customInstructions = useAuthStore((s) => s.customInstructions);
  const isGroupMember = resolveIsGroupMember(input.conversationId, input.currentUserPrivilege);

  const { data: groupBudgetData, isPending: isGroupBudgetPending } = useConversationBudgets(
    resolveGroupBudgetArgument(isGroupMember, input.conversationId)
  );

  // The send-path builder is the truth: the preview measures the exact system
  // prompt the language adapter sends (base preamble + custom instructions —
  // never capability blocks), through the ONE shared counter. The builder's
  // date line is fixed-width, so the count is stable across renders.
  const systemPrompt = React.useMemo(
    () =>
      buildTurnSystemPrompt({
        now: new Date(),
        ...(customInstructions == null ? {} : { customInstructions }),
      }),
    [customInstructions]
  );
  const promptChars = promptCharacterCount({
    systemPrompt,
    historyCharacters: input.historyCharacters,
    prompt: input.value,
  });

  // 1. Math-only budget calculation. Web search is authenticated-only; the core
  // adds its own worst-case reservation line item when enabled (never a mirrored
  // client cost), matching the server reservation.
  const budgetResult = useBudgetCalculation({
    promptCharacterCount: promptChars,
    models: modelsPricing,
    isAuthenticated,
    // The conversation names the payer whose funds and tier size the turn.
    conversationId: conversationScope(input.conversationId),
    ...(webSearchActive && { webSearch: true }),
    ...reasoningBudgetInput(input.reasoningEffort, selectedModels, modelsData?.models),
  });

  // The send gate's own source. `admissible` is evaluated against the COMPOSED
  // basis and the hold-aware figure — the question "can this turn start right
  // now" — while the picker's `affordable` is neither. One call yields both.
  const turnOptions = useTurnOptions({
    basis: promptBasisOf(systemPrompt, input.historyCharacters, input.value),
    isAuthenticated,
    conversationId: conversationScope(input.conversationId),
  });

  // Media cost — image/video/audio only. It uses the same per-modality helpers
  // the backend uses for reservation, so the displayed estimate matches what
  // the server-side balance gate compares against. A text turn contributes no
  // money estimate at all; there is no token-based fallback to fall through to.
  const mediaRates = buildMediaRateArrays(
    selectedModels,
    modelsData?.models,
    videoConfig.resolution
  );
  const mediaCost = useMediaCostEstimate(
    buildMediaCostInput({
      activeModality,
      rates: mediaRates,
      videoDurationSeconds: videoConfig.durationSeconds,
      audioMaxDurationSeconds: audioConfig.maxDurationSeconds,
    })
  );

  // 3. Resolve billing: who pays or why denied
  const isPremiumModel = selectedModels.some((sm) => modelsData?.premiumIds.has(sm.id) ?? false);
  // A TEXT turn contributes no money estimate to the funding decision:
  // `admissible` is its whole money verdict. Only a per-unit media generation
  // still needs one, and it keeps its own path until G2/E4 collapse it.
  const estimatedCostNanoUsd = activeModality === 'text' ? 0n : mediaCost.estimatedNanoUsd;

  const selfFundedResult = useResolveBilling(
    buildBillingResolverInput({
      estimatedCostNanoUsd,
      isPremiumModel,
      isAuthenticated,
    })
  );
  const billingResult = withServedPayer(selfFundedResult, turnOptions.payer, isGroupMember);

  // 4. Generate notifications
  const hasDelegatedBudget = resolveHasDelegatedBudget(isGroupMember, groupBudgetData);
  const notifications = React.useMemo(
    () =>
      generateNotifications({
        billingResult,
        capacityPercent: budgetResult.capacityPercent,
        maxOutputTokens: budgetResult.maxOutputTokens,
        ...(input.currentUserPrivilege !== undefined && { privilege: input.currentUserPrivilege }),
        ...(hasDelegatedBudget && { hasDelegatedBudget: true }),
      }),
    [
      billingResult,
      budgetResult.capacityPercent,
      budgetResult.maxOutputTokens,
      input.currentUserPrivilege,
      hasDelegatedBudget,
    ]
  );

  // 5. Derive display values
  const display = computePromptBudgetDisplay({
    capacityPercent: budgetResult.capacityPercent,
    isBalanceLoading: budgetResult.isBalanceLoading,
    currentUsage: budgetResult.currentUsage,
    fundingSource: billingResult.fundingSource,
    isGroupMember,
    isGroupBudgetPending,
    modelContextLength,
    inputValue: input.value,
    turnOptions: turnOptions.options,
    heldNanoUsd: turnOptions.heldNanoUsd,
    isTextTurn: activeModality === 'text',
  });

  const isReadOnly = input.currentUserPrivilege === 'read';
  const gated = readOnlyOverride(isReadOnly, billingResult.fundingSource, display.sendRefusal);

  return {
    fundingSource: gated.fundingSource,
    notifications,
    capacityPercent: budgetResult.capacityPercent,
    capacityCurrentUsage: display.capacityCurrentUsage,
    capacityMaxCapacity: display.capacityMaxCapacity,
    estimatedCostNanoUsd,
    isOverCapacity: display.isOverCapacity,
    hasBlockingError: display.hasBlockingError || isReadOnly,
    sendRefusal: gated.sendRefusal,
    hasContent: display.hasContent,
    maxOutputTokens: budgetResult.maxOutputTokens,
    estimatedInputTokens: budgetResult.estimatedInputTokens,
    effortDimension: turnOptions.options?.affordable.turnDimensions.find(
      (dimension) => dimension.dimensionId === 'effort'
    ),
  };
}
