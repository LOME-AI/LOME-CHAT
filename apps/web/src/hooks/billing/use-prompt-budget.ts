import * as React from 'react';
import {
  buildSystemPrompt,
  worstCaseSearchCost,
  generateNotifications,
  nanoUsdToCents,
  type ModelFeatureId,
  type BudgetError,
  type FundingSource,
  type MemberPrivilege,
} from '@hushbox/shared';
import { useBudgetCalculation } from '@/hooks/billing/use-budget-calculation';
import {
  useConversationBudgets,
  type ConversationBudgetsResponse,
} from '@/hooks/billing/use-conversation-budgets';
import { useMediaCostEstimate } from '@/hooks/billing/use-media-cost-estimate';
import { useResolveBilling } from '@/hooks/billing/use-resolve-billing';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models/models';
import { useSession, useAuthStore } from '@/lib/auth';
import { useWebSearch } from '@/hooks/chat/use-web-search';

interface PromptBudgetInput {
  value: string;
  historyCharacters: number;
  capabilities: ModelFeatureId[];
  /** Conversation ID for group budget lookup. Omit or null for solo conversations. */
  conversationId?: string | null;
  /** Current user's privilege in the group conversation. Omit for solo conversations. */
  currentUserPrivilege?: MemberPrivilege;
}

export interface PromptBudgetResult {
  fundingSource: FundingSource | 'denied';
  notifications: BudgetError[];
  capacityPercent: number;
  capacityCurrentUsage: number;
  capacityMaxCapacity: number;
  estimatedCostCents: number;
  isOverCapacity: boolean;
  hasBlockingError: boolean;
  hasContent: boolean;
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
  return isGroupMember && memberRow !== undefined && nanoUsdToCents(memberRow.capNanoUsd) > 0;
}

/**
 * Construct the input shape `useResolveBilling` expects, conditionally
 * including the optional `group` field. Hoisted out of the hook so the
 * conditional spread doesn't bump the hook's cyclomatic complexity past
 * the lint threshold.
 */
function buildBillingResolverInput(args: {
  estimatedCostCents: number;
  isPremiumModel: boolean;
  isAuthenticated: boolean;
  groupContext: GroupBillingContext | undefined;
}): {
  estimatedMinimumCostCents: number;
  isPremiumModel: boolean;
  isAuthenticated: boolean;
  group?: GroupBillingContext;
} {
  const { estimatedCostCents, isPremiumModel, isAuthenticated, groupContext } = args;
  if (groupContext === undefined) {
    return { estimatedMinimumCostCents: estimatedCostCents, isPremiumModel, isAuthenticated };
  }
  return {
    estimatedMinimumCostCents: estimatedCostCents,
    isPremiumModel,
    isAuthenticated,
    group: groupContext,
  };
}

interface GroupBillingContext {
  effectiveCents: number;
  ownerBalanceCents: number;
}

/**
 * Build the group billing context that {@link useResolveBilling} expects from
 * the NanoUSD budgets response. Returns undefined for solo conversations and
 * non-member roles (owners), so the resolver falls back to the per-user balance
 * check. `effectiveCents` is the backend's own effective remaining (the figure
 * admission gates on), never re-derived here. The owner balance drives the
 * negative-balance denial and, through the shared core, the owner-funded
 * premium exemption.
 */
function useGroupBillingContext(
  isGroupMember: boolean,
  data: ConversationBudgetsResponse | undefined
): GroupBillingContext | undefined {
  return React.useMemo(() => {
    if (!isGroupMember || !data) return;
    const memberRow = data.members[0];
    const effectiveCents =
      memberRow === undefined ? 0 : nanoUsdToCents(memberRow.effectiveRemainingNanoUsd);
    const ownerBalanceCents = nanoUsdToCents(data.ownerBalanceNanoUsd);
    return {
      effectiveCents,
      ownerBalanceCents,
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

interface MediaPriceArrays {
  pricesPerImage: number[];
  pricesPerVideoSecond: number[];
  pricesPerAudioSecond: number[];
}

interface CatalogModel {
  id: string;
  pricePerImage?: number | undefined;
  pricePerSecond?: number | undefined;
  pricePerSecondByResolution?: Record<string, number> | undefined;
}

/**
 * Pull per-model price arrays from the live model catalog. The arrays mirror
 * `selectedModels` order so each entry's price corresponds to the model the
 * user picked. Missing prices fall back to 0 (model not yet loaded, wrong
 * modality), which makes the resulting cost estimate $0 instead of NaN.
 */
function buildMediaPriceArrays(
  selectedModels: readonly { id: string }[],
  modelCatalog: readonly CatalogModel[] | undefined,
  videoResolution: string
): MediaPriceArrays {
  const findModel = (id: string): CatalogModel | undefined =>
    modelCatalog?.find((m) => m.id === id);
  return {
    pricesPerImage: selectedModels.map((sm) => findModel(sm.id)?.pricePerImage ?? 0),
    pricesPerVideoSecond: selectedModels.map(
      (sm) => findModel(sm.id)?.pricePerSecondByResolution?.[videoResolution] ?? 0
    ),
    pricesPerAudioSecond: selectedModels.map((sm) => findModel(sm.id)?.pricePerSecond ?? 0),
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

interface ModelTokenPricing {
  modelInputPricePerToken: number;
  modelOutputPricePerToken: number;
  contextLength: number;
}

interface TokenPricingCatalogEntry {
  id: string;
  pricePerInputToken: number;
  pricePerOutputToken: number;
  contextLength: number;
}

/**
 * Map each selected model to its per-token pricing tuple. Missing models
 * (catalog still loading) collapse to zero prices, which produces a $0
 * estimate rather than NaN downstream.
 */
function buildModelTokenPricing(
  selectedModels: readonly { id: string }[],
  modelCatalog: readonly TokenPricingCatalogEntry[] | undefined
): ModelTokenPricing[] {
  return selectedModels.map((sm) => {
    const model = modelCatalog?.find((m) => m.id === sm.id);
    return {
      modelInputPricePerToken: model?.pricePerInputToken ?? 0,
      modelOutputPricePerToken: model?.pricePerOutputToken ?? 0,
      contextLength: model?.contextLength ?? 0,
    };
  });
}

/**
 * Build the modality-specific input shape that {@link useMediaCostEstimate}
 * accepts. Returns no media-pricing keys for `text`, in which case the cost
 * estimate is 0 and the caller falls back to the token-derived cost.
 */
function buildMediaCostInput(args: {
  activeModality: 'text' | 'image' | 'video' | 'audio';
  prices: MediaPriceArrays;
  videoDurationSeconds: number;
  audioMaxDurationSeconds: number;
}): {
  modality: 'text' | 'image' | 'video' | 'audio';
  imagePricing?: { pricesPerImage: number[] };
  videoPricing?: { pricesPerSecond: number[]; durationSeconds: number };
  audioPricing?: { pricesPerSecond: number[]; durationSeconds: number };
} {
  const { activeModality, prices, videoDurationSeconds, audioMaxDurationSeconds } = args;
  if (activeModality === 'image') {
    return { modality: 'image', imagePricing: { pricesPerImage: prices.pricesPerImage } };
  }
  if (activeModality === 'video') {
    return {
      modality: 'video',
      videoPricing: {
        pricesPerSecond: prices.pricesPerVideoSecond,
        durationSeconds: videoDurationSeconds,
      },
    };
  }
  if (activeModality === 'audio') {
    return {
      modality: 'audio',
      audioPricing: {
        pricesPerSecond: prices.pricesPerAudioSecond,
        durationSeconds: audioMaxDurationSeconds,
      },
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
  const webSearchCost = webSearchActive ? worstCaseSearchCost() : 0;

  const isGroupMember = resolveIsGroupMember(input.conversationId, input.currentUserPrivilege);

  const { data: groupBudgetData, isPending: isGroupBudgetPending } = useConversationBudgets(
    resolveGroupBudgetArgument(isGroupMember, input.conversationId)
  );

  const systemPrompt = React.useMemo(
    () => buildSystemPrompt(input.capabilities, customInstructions ?? undefined),
    [input.capabilities, customInstructions]
  );
  const promptCharacterCount = systemPrompt.length + input.historyCharacters + input.value.length;

  // 1. Math-only budget calculation
  const budgetResult = useBudgetCalculation({
    promptCharacterCount,
    models: modelsPricing.map((m) => ({
      modelInputPricePerToken: m.modelInputPricePerToken,
      modelOutputPricePerToken: m.modelOutputPricePerToken,
      contextLength: m.contextLength,
    })),
    isAuthenticated,
    webSearchCost,
  });

  const groupContext = useGroupBillingContext(isGroupMember, groupBudgetData);

  // 2.5. Media cost — for image/video/audio modalities, the token-based budget
  // result is irrelevant (token prices are 0). Use the same per-modality
  // helpers the backend uses for reservation, so the displayed cost matches
  // the value the server-side balance gate compares against. Returns 0 for
  // text, in which case `estimatedCostCents` falls through to the token-based
  // computation below.
  const mediaPrices = buildMediaPriceArrays(
    selectedModels,
    modelsData?.models,
    videoConfig.resolution
  );
  const mediaCost = useMediaCostEstimate(
    buildMediaCostInput({
      activeModality,
      prices: mediaPrices,
      videoDurationSeconds: videoConfig.durationSeconds,
      audioMaxDurationSeconds: audioConfig.maxDurationSeconds,
    })
  );

  // 3. Resolve billing: who pays or why denied
  const isPremiumModel = selectedModels.some((sm) => modelsData?.premiumIds.has(sm.id) ?? false);
  const estimatedCostCents =
    activeModality === 'text' ? budgetResult.estimatedMinimumCost * 100 : mediaCost.estimatedCents;

  const billingResult = useResolveBilling(
    buildBillingResolverInput({
      estimatedCostCents,
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
    estimatedCostCents,
    isOverCapacity: display.isOverCapacity,
    hasBlockingError: display.hasBlockingError || isReadOnly,
    hasContent: display.hasContent,
  };
}
