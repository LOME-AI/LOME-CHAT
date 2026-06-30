import {
  applyFees,
  calculateMessageCostFromActual,
  estimateTokenCount,
  STORAGE_COST_PER_CHARACTER,
  type PreInferenceBilling,
} from '@hushbox/shared';
import { recordServiceEvidence, SERVICE_NAMES, type EvidenceConfig } from '@hushbox/db';
import type { AIClient } from '../ai/index.js';

/**
 * Result of resolving a model's cost (pre-storage).
 *
 *   - Success path: `modelCostUsd` is the gateway's `totalCost` — RAW
 *     (pre-fee) cost that already reflects any web-search calls, cache
 *     discounts, and tier pricing. Caller applies fees on top.
 *   - Fallback path: `modelCostUsd` is a token-count × catalog-price estimate.
 *     The catalog prices on `ModelInfo.pricing` are fee-inclusive per the
 *     `pricingFromRawModel` contract, so the estimate is ALREADY fee-inclusive
 *     and the caller must NOT re-apply fees.
 *
 * Storage is intentionally NOT included so the caller can add it exactly
 * once at the right attribution level (always main, never per-stage).
 *
 * Known fallback inaccuracies (acceptable for the rare path):
 *   - Web-search-enabled requests are UNDER-billed because the estimate
 *     ignores `worstCaseSearchCost()`. Surfacing this requires plumbing
 *     `webSearchEnabled` from the request through the billing pipeline; for
 *     now the under-charge is accepted because fallback should be rare.
 *   - Cache discounts and tiered pricing are not modeled by the estimate, so
 *     fallback over-charges any request that would have benefited from them.
 */
interface CostResolution {
  modelCostUsd: number;
  wasEstimated: boolean;
}

interface ResolveGatewayCostOrEstimateParams {
  aiClient: AIClient;
  generationId: string;
  modelId: string;
  inputContent: string;
  outputContent: string;
}

/**
 * Try the gateway lookup; on failure (retries already exhausted inside the
 * AIClient) fall back to a token-count × catalog-price estimate.
 *
 * Returns `wasEstimated: false` with RAW gateway cost (caller applies fees), or
 * `wasEstimated: true` with FEE-INCLUSIVE estimate (caller adds storage only).
 *
 * Non-token-priced models (image/video/audio) can't be meaningfully estimated
 * this way — re-throw so the operator sees a real failure rather than a wrong
 * bill. In practice these never reach this code (media flows through
 * `media-pipeline.ts`); the guard exists in case a future refactor changes
 * that.
 */
async function resolveGatewayCostOrEstimate(
  params: ResolveGatewayCostOrEstimateParams
): Promise<CostResolution> {
  const { aiClient, generationId, modelId, inputContent, outputContent } = params;
  try {
    const { costUsd } = await aiClient.getGenerationStats(generationId);
    return { modelCostUsd: costUsd, wasEstimated: false };
  } catch (error) {
    const model = await aiClient.getModel(modelId);
    if (model.pricing.kind !== 'token') {
      throw error;
    }
    // `ModelInfo.pricing.{input,output}PerToken` is fee-inclusive per the
    // `pricingFromRawModel` contract, so the result here is already fee-inclusive.
    const tokenInputCost = estimateTokenCount(inputContent) * model.pricing.inputPerToken;
    const tokenOutputCost = estimateTokenCount(outputContent) * model.pricing.outputPerToken;
    const modelCostUsd = tokenInputCost + tokenOutputCost;
    const status = (error as { statusCode?: number }).statusCode;
    console.error('[billing] gateway lookup exhausted, billing from estimate', {
      generationId,
      modelId,
      modelCostUsd,
      gatewayErrorStatus: status,
    });
    return { modelCostUsd, wasEstimated: true };
  }
}

function storageCostForChars(inputCharacters: number, outputCharacters: number): number {
  return (inputCharacters + outputCharacters) * STORAGE_COST_PER_CHARACTER;
}

/**
 * Combine a resolved model cost with storage. Branches on `wasEstimated`:
 * gateway path applies fees to raw cost via `calculateMessageCostFromActual`;
 * estimate path is already fee-inclusive and just adds storage.
 */
function finalizeMessageCost(
  resolution: CostResolution,
  inputCharacters: number,
  outputCharacters: number
): number {
  if (resolution.wasEstimated) {
    return resolution.modelCostUsd + storageCostForChars(inputCharacters, outputCharacters);
  }
  return calculateMessageCostFromActual({
    gatewayCost: resolution.modelCostUsd,
    inputCharacters,
    outputCharacters,
  });
}

/**
 * Tolerated fractional deviation between the pre-flight billing estimate and
 * the post-flight gateway-reported actual cost. Anything larger triggers a
 * `billing-mismatch` evidence row so ops can correlate spikes with model or
 * pricing changes.
 *
 * Picked at 0.5 (50%): pricing tiers and tool calls can legitimately push
 * actuals beyond a tight bound; unfounded "double-bills" rarely sit inside
 * 50%. Tune via dashboard, not by silently lowering this constant.
 */
export const BILLING_MISMATCH_THRESHOLD_RATIO = 0.5;

export interface CalculateMessageCostParams {
  /** The AIClient — used to fetch exact cost from the gateway post-hoc. */
  aiClient: AIClient;
  /** Generation ID captured from the stream's finish event. */
  generationId: string;
  /** Resolved model id — required for catalog-based estimate fallback. */
  modelId: string;
  /** The user's input message. */
  inputContent: string;
  /** The AI's response. */
  outputContent: string;
}

export interface CalculateMessageCostResult {
  /** Final billable dollars including fees and storage. */
  totalDollars: number;
  /**
   * True when the gateway lookup exhausted retries and the cost was estimated
   * from token counts + catalog pricing. False on the normal exact path.
   */
  wasEstimated: boolean;
}

/**
 * Calculate the final billable cost for a message.
 *
 * The gateway lookup retries internally; on exhaustion we fall back to a
 * token-count × catalog-price estimate (`wasEstimated: true`). Either way,
 * fees and storage are added uniformly on top: storage stays exact because
 * it's driven by character counts we hold in memory, and fees apply once.
 *
 * Non-token-priced models (image/video/audio) bubble the original gateway
 * error rather than estimate — see `resolveGatewayCostOrEstimate`. Today the
 * media path never reaches here in production, but the guard fails loud if a
 * future refactor changes that.
 */
export async function calculateMessageCost(
  params: CalculateMessageCostParams
): Promise<CalculateMessageCostResult> {
  const { aiClient, generationId, modelId, inputContent, outputContent } = params;

  const resolution = await resolveGatewayCostOrEstimate({
    aiClient,
    generationId,
    modelId,
    inputContent,
    outputContent,
  });

  const totalDollars = finalizeMessageCost(resolution, inputContent.length, outputContent.length);

  return { totalDollars, wasEstimated: resolution.wasEstimated };
}

export interface CalculateMessageCostWithStagesParams {
  aiClient: AIClient;
  /** Generation id from the main inference's finish event. */
  mainGenerationId: string;
  /** Resolved model id of the main inference — required for estimate fallback. */
  mainModelId: string;
  /** Pre-inference stage billings — each one will produce its own usage_records row. */
  stageBillings: readonly PreInferenceBilling[];
  /** The user's input message (for storage cost). */
  inputContent: string;
  /** The AI's response (for storage cost). */
  outputContent: string;
}

export interface StageCostAttribution {
  billing: PreInferenceBilling;
  /**
   * USD cost from the underlying cost resolution.
   *   - `wasEstimated: false` — raw (pre-fee) gateway cost from `getGenerationStats`.
   *   - `wasEstimated: true`  — fee-inclusive token-count × catalog-price estimate
   *     (catalog prices on `ModelInfo.pricing.*` are fee-inclusive per the
   *     `pricingFromRawModel` contract).
   */
  gatewayCostUsd: number;
  /**
   * Cost in dollars attributable to this stage.
   *   - `wasEstimated: false` — `applyFees(gatewayCostUsd)`.
   *   - `wasEstimated: true`  — `gatewayCostUsd` directly (already fee-inclusive).
   * No storage component — stages don't attribute storage.
   */
  costDollars: number;
  /** True when this stage fell back to an estimate. */
  wasEstimated: boolean;
}

export interface CalculateMessageCostWithStagesResult {
  /** Total cost in dollars to denormalize into `content_items.cost`. */
  totalDollars: number;
  /** Cost attributable to the main inference call (with fees and storage). */
  mainCostDollars: number;
  /** Per-stage cost breakdown for the additional `usage_records` rows. */
  stageBreakdown: StageCostAttribution[];
  /** True when the main inference cost fell back to an estimate. */
  mainWasEstimated: boolean;
}

/**
 * Calculate the final billable cost for a message that ran one or more
 * pre-inference stages (e.g., Smart Model classifier) ahead of the main
 * inference call.
 *
 * Each stage and the main inference produce separate `usage_records` rows
 * with their own model id and generationId. The breakdown returned here
 * gives the per-row dollar attribution; `totalDollars` is the sum and
 * matches what the UI displays as the message's total cost.
 *
 * Storage cost is attributed entirely to the main inference (the user's
 * message and the AI's response are what's persisted; stage prompts and
 * outputs are ephemeral). Fees apply to every model cost identically, so
 * the additive property holds:
 *   totalDollars === mainCostDollars + Σ stageBreakdown.costDollars
 *
 * Each gateway lookup retries independently inside the AIClient and may fall
 * back to a token-based estimate (`wasEstimated: true`); one stage falling
 * back does not affect the others. See `resolveGatewayCostOrEstimate` for the
 * fallback's accuracy caveats.
 */
export async function calculateMessageCostWithStages(
  params: CalculateMessageCostWithStagesParams
): Promise<CalculateMessageCostWithStagesResult> {
  const { aiClient, mainGenerationId, mainModelId, stageBillings, inputContent, outputContent } =
    params;

  const [mainResolution, ...stageResolutions] = await Promise.all([
    resolveGatewayCostOrEstimate({
      aiClient,
      generationId: mainGenerationId,
      modelId: mainModelId,
      inputContent,
      outputContent,
    }),
    ...stageBillings.map((b) =>
      resolveGatewayCostOrEstimate({
        aiClient,
        generationId: b.generationId,
        modelId: b.modelId,
        inputContent: b.inputContent,
        outputContent: b.outputContent,
      })
    ),
  ]);

  // Resolutions return RAW gateway cost (apply fees) or FEE-INCLUSIVE estimate
  // (already includes fees). `finalizeMessageCost` branches; we re-use a
  // 0-char variant here since stages have no storage attribution.
  const stageBreakdown: StageCostAttribution[] = stageBillings.map((billing, index) => {
    const resolution = stageResolutions[index];
    if (!resolution) {
      throw new Error('stageResolutions invariant: missing resolution for stage');
    }
    const costDollars = resolution.wasEstimated
      ? resolution.modelCostUsd
      : applyFees(resolution.modelCostUsd);
    return {
      billing,
      gatewayCostUsd: resolution.modelCostUsd,
      costDollars,
      wasEstimated: resolution.wasEstimated,
    };
  });

  const mainCostDollars = finalizeMessageCost(
    mainResolution,
    inputContent.length,
    outputContent.length
  );
  const stageDollarsSum = stageBreakdown.reduce((sum, b) => sum + b.costDollars, 0);
  const totalDollars = mainCostDollars + stageDollarsSum;

  return {
    totalDollars,
    mainCostDollars,
    stageBreakdown,
    mainWasEstimated: mainResolution.wasEstimated,
  };
}

export interface RecordBillingMismatchInput {
  /** Pre-flight reservation/estimate cost in USD. */
  estimateUsd: number;
  /** Post-flight gateway-reported actual cost in USD. */
  actualUsd: number;
  /** Optional evidence config — when omitted, this is a no-op. */
  evidence?: EvidenceConfig;
  /** Override the default 50% threshold for ops experimentation. */
  thresholdRatio?: number;
}

/**
 * Compare the pre-flight billing estimate against the post-flight actual
 * gateway cost, and record a `billing-mismatch` evidence row when the
 * deviation exceeds the threshold. Never throws and never blocks billing —
 * this is a non-blocking ops signal.
 *
 * Behaviour:
 * - `evidence` undefined → no-op (callers without ops wiring stay quiet).
 * - both estimate and actual are zero → no-op (nothing happened to compare).
 * - estimate is zero, actual is non-zero → record (unbounded relative
 *   deviation; treat as always-over-threshold).
 * - otherwise: record when |actual − estimate| / estimate > threshold.
 *
 * `recordServiceEvidence` itself gates the DB write on `isCI === true`, so
 * production sees the comparison run but never persists a row — exactly the
 * same pattern as the AI Gateway / Helcim recording paths.
 */
export async function recordBillingMismatchIfExceeded(
  input: RecordBillingMismatchInput
): Promise<void> {
  const { estimateUsd, actualUsd, evidence } = input;
  if (evidence === undefined) return;

  const threshold = input.thresholdRatio ?? BILLING_MISMATCH_THRESHOLD_RATIO;

  // Both zero: nothing to compare. Estimate zero with non-zero actual: treat
  // as unbounded deviation. Otherwise: compare relative deviation against
  // the threshold.
  let exceeds: boolean;
  let deviation: number | null;
  if (estimateUsd === 0) {
    exceeds = actualUsd !== 0;
    deviation = null;
  } else {
    deviation = Math.abs(actualUsd - estimateUsd) / estimateUsd;
    exceeds = deviation > threshold;
  }

  if (!exceeds) return;

  await recordServiceEvidence(evidence.db, evidence.isCI, SERVICE_NAMES.BILLING_MISMATCH, {
    estimateUsd,
    actualUsd,
    deviation,
    thresholdRatio: threshold,
  });
}
