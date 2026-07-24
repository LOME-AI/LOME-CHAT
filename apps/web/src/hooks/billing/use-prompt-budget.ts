import * as React from 'react';
import {
  SMART_MODEL_ID,
  buildTurnSystemPrompt,
  generateNotifications,
  nanoUSD,
  outputCharsPerTokenForTier,
  planReasoning,
  promptCharacterCount,
  smartModelMinimumRequiredNanoUsd,
  type CanonicalReasoningEffort,
  type Model,
  type BudgetError,
  type FundingSource,
  type MemberPrivilege,
  type Pricing,
  type ReasoningEffortSelection,
  type SmartModelPoolCandidate,
  type SmartModelStorageContext,
} from '@hushbox/shared';
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
import { useUserTierInfo } from '@/hooks/billing/use-user-tier-info';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models/models';
import { useSession, useAuthStore } from '@/lib/auth';
import { useWebSearch } from '@/hooks/chat/use-web-search';

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
  hasContent: boolean;
  /**
   * Affordable output tokens and estimated input tokens from the shared
   * budget core — the effort menu derives per-level feasibility from these
   * through the shared reasoning plan (G5).
   */
  maxOutputTokens: number;
  estimatedInputTokens: number;
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
  groupContext: GroupBillingContext | undefined;
}): {
  estimatedMinimumCostNanoUsd: bigint;
  isPremiumModel: boolean;
  isAuthenticated: boolean;
  group?: GroupBillingContext;
} {
  const { estimatedCostNanoUsd, isPremiumModel, isAuthenticated, groupContext } = args;
  if (groupContext === undefined) {
    return { estimatedMinimumCostNanoUsd: estimatedCostNanoUsd, isPremiumModel, isAuthenticated };
  }
  return {
    estimatedMinimumCostNanoUsd: estimatedCostNanoUsd,
    isPremiumModel,
    isAuthenticated,
    group: groupContext,
  };
}

interface GroupBillingContext {
  effectiveRemainingNanoUsd: bigint;
  ownerBalanceNanoUsd: bigint;
}

/**
 * Build the group billing context that {@link useResolveBilling} expects from
 * the NanoUSD budgets response. Returns undefined for solo conversations and
 * non-member roles (owners), so the resolver falls back to the per-user balance
 * check. `effectiveRemainingNanoUsd` is the backend's own hold-aware effective
 * remaining (the figure admission gates on), never re-derived here — carried
 * through as an exact bigint. The owner balance drives the negative-balance
 * denial and, through the shared core, the owner-funded premium exemption.
 */
function useGroupBillingContext(
  isGroupMember: boolean,
  data: ConversationBudgetsResponse | undefined
): GroupBillingContext | undefined {
  return React.useMemo(() => {
    if (!isGroupMember || !data) return;
    const memberRow = data.members[0];
    return {
      effectiveRemainingNanoUsd:
        memberRow === undefined ? 0n : BigInt(memberRow.effectiveRemainingNanoUsd),
      ownerBalanceNanoUsd: BigInt(data.ownerBalanceNanoUsd),
    };
  }, [isGroupMember, data]);
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
}

interface PromptBudgetDisplayResult {
  isOverCapacity: boolean;
  hasBlockingError: boolean;
  hasContent: boolean;
  capacityCurrentUsage: number;
  capacityMaxCapacity: number;
}

function computePromptBudgetDisplay(inputs: PromptBudgetDisplayInputs): PromptBudgetDisplayResult {
  const isOverCapacity = inputs.capacityPercent > 100;
  const isDenied = inputs.fundingSource === 'denied';
  const isBillingLoading =
    inputs.isBalanceLoading || (inputs.isGroupMember && inputs.isGroupBudgetPending);
  const hasBlockingError = isDenied || isOverCapacity || isBillingLoading;
  const hasContent = inputs.inputValue.trim().length > 0;

  const hasContext = inputs.modelContextLength > 0;
  const capacityCurrentUsage = hasContext ? inputs.currentUsage : 0;
  const capacityMaxCapacity = hasContext ? inputs.modelContextLength : 1;

  return {
    isOverCapacity,
    hasBlockingError,
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
  if (selection === undefined || selection === 'auto' || selection === 'none') return {};
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
 * The priceable text pool the Smart Model affordability gate reasons over — the
 * real per-token text models, never the synthetic Smart Model row (which carries
 * the catalog's headline-min pricing). Media/audio rows carry no per-token rate,
 * so requiring both input and output rates naturally selects text.
 */
function smartModelPoolFromCatalog(modelCatalog: readonly Model[]): SmartModelPoolCandidate[] {
  return modelCatalog.flatMap((model): SmartModelPoolCandidate[] => {
    if (model.isSmartModel === true) return [];
    const { inputPerToken, outputPerToken } = model.pricing;
    if (inputPerToken === undefined || outputPerToken === undefined) return [];
    const pricing: Pricing = {
      inputPerToken: nanoUSD(BigInt(inputPerToken)),
      outputPerToken: nanoUSD(BigInt(outputPerToken)),
    };
    return [
      {
        id: model.id,
        description: model.description,
        pricing,
        contextLength: model.contextLength,
      },
    ];
  });
}

/**
 * The turn's minimum cost in exact nano-USD. Media modalities take the
 * per-modality media estimate; a text turn takes the token-derived minimum,
 * EXCEPT Smart Model, which prices through the shared affordability gate
 * (reserve + cheapest floor) so the client refuses exactly the sends the
 * server refuses. Extracted so the hook stays under the complexity budget.
 */
function resolveEstimatedCostNanoUsd(args: {
  activeModality: 'text' | 'image' | 'video' | 'audio';
  selectedModels: readonly { id: string }[];
  modelCatalog: readonly Model[] | undefined;
  estimatedInputTokens: number;
  tokenMinimumCostNanoUsd: bigint;
  mediaNanoUsd: bigint;
  storage: SmartModelStorageContext;
}): bigint {
  if (args.activeModality !== 'text') return args.mediaNanoUsd;
  const smart = smartModelMinimumNanoUsd(
    args.selectedModels,
    args.modelCatalog,
    args.estimatedInputTokens,
    args.storage
  );
  return smart ?? args.tokenMinimumCostNanoUsd;
}

/**
 * Smart Model's minimum-required cost in exact nano-USD, priced through the
 * ONE shared affordability gate — the classifier worst-case reserve plus the
 * cheapest candidate's realistic floor, the exact threshold below which the
 * server refuses the send. Returns undefined when Smart Model is not selected or
 * no priceable text pool exists, so the caller falls back to the token cost. This
 * replaces pricing Smart Model at the catalog's balance-tracking headline-min,
 * which let a $0 free-tier session slip past the client while the server 402'd.
 */
function smartModelMinimumNanoUsd(
  selectedModels: readonly { id: string }[],
  modelCatalog: readonly Model[] | undefined,
  estimatedInputTokens: number,
  storage: SmartModelStorageContext
): bigint | undefined {
  if (!selectedModels.some((model) => model.id === SMART_MODEL_ID)) return undefined;
  if (modelCatalog === undefined) return undefined;
  // The SAME storage-inclusive per-candidate threshold the server admits on, so
  // the client denies exactly the sends the server refuses (the biconditional):
  // the effective balance below which no candidate can fund a minimum answer.
  const minimum = smartModelMinimumRequiredNanoUsd(
    smartModelPoolFromCatalog(modelCatalog),
    estimatedInputTokens,
    storage
  );
  if (minimum === null) return undefined;
  return minimum;
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
  // The payer tier drives the output-storage ratio the Smart Model per-candidate
  // caps price against — the SAME storage the server admission holds, so the
  // client and server affordability verdicts agree.
  const tierInfo = useUserTierInfo(isAuthenticated);

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
    ...(webSearchActive && { webSearch: true }),
    ...reasoningBudgetInput(input.reasoningEffort, selectedModels, modelsData?.models),
  });

  const groupContext = useGroupBillingContext(isGroupMember, groupBudgetData);

  // 2.5. Media cost — for image/video/audio modalities, the token-based budget
  // result is irrelevant (token prices are 0). Use the same per-modality
  // helpers the backend uses for reservation, so the displayed cost matches
  // the value the server-side balance gate compares against. Returns 0 for
  // text, in which case `estimatedCostNanoUsd` falls through to the token-based
  // computation below.
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
  // Smart Model prices through the shared affordability gate (reserve + cheapest
  // floor), never the catalog's headline-min — so the client refuses exactly the
  // sends the server refuses. A non-Smart text turn keeps the token-derived cost.
  const estimatedCostNanoUsd = resolveEstimatedCostNanoUsd({
    activeModality,
    selectedModels,
    modelCatalog: modelsData?.models,
    estimatedInputTokens: budgetResult.estimatedInputTokens,
    tokenMinimumCostNanoUsd: budgetResult.estimatedMinimumCostNanoUsd,
    mediaNanoUsd: mediaCost.estimatedNanoUsd,
    storage: {
      outputCharsPerToken: outputCharsPerTokenForTier(tierInfo.tier),
      inputChars: promptChars,
    },
  });

  const billingResult = useResolveBilling(
    buildBillingResolverInput({
      estimatedCostNanoUsd,
      isPremiumModel,
      isAuthenticated,
      groupContext,
    })
  );

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
  });

  const isReadOnly = input.currentUserPrivilege === 'read';

  return {
    fundingSource: isReadOnly ? 'denied' : billingResult.fundingSource,
    notifications,
    capacityPercent: budgetResult.capacityPercent,
    capacityCurrentUsage: display.capacityCurrentUsage,
    capacityMaxCapacity: display.capacityMaxCapacity,
    estimatedCostNanoUsd,
    isOverCapacity: display.isOverCapacity,
    hasBlockingError: display.hasBlockingError || isReadOnly,
    hasContent: display.hasContent,
    maxOutputTokens: budgetResult.maxOutputTokens,
    estimatedInputTokens: budgetResult.estimatedInputTokens,
  };
}
