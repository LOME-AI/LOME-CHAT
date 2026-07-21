# Canonical Cost-Estimator — Consumer Map

Scope: excludes `/legacy/`, `dist/`, `.d.ts`, `node_modules`. Test files marked `[test]`.
"comment-ref" = appears only in a docstring/comment. Barrel = pure re-export.

## Rewire targets (real, non-test, non-barrel callers)

**apps/web:** use-budget-calculation.ts, use-prompt-budget.ts, use-resolve-billing.ts,
use-media-cost-estimate.ts, lib/format.ts (re-exports applyFees), lib/tokens.ts (re-exports estimateTokenCount).
**apps/marketing:** src/lib/calculate-cost.ts (estimateTokenCount).
**packages/shared:** models/premium-check.ts, billing/client-billing.ts, smart-model/eligible-models.ts.
**apps/api:** chat/domain/turn-definition.ts, chat/domain/runtime.ts, chat/domain/smart-model-turn.ts,
chat/domain/settlement.ts, billing/domain/admission.ts, billing/domain/charge.ts,
billing/domain/public-usage-stats.ts (roundHalfEvenDiv), models/domain/trial-eligibility.ts,
models/domain/smart-model-candidates.ts, models/domain/estimate-run.ts, models/domain/trial-smart-model-candidates.ts,
workflows/engine/model-resolver.ts, workflows/engine/live-execution-registry.ts,
workflows/nodes/model-call-execution.ts, workflows/nodes/smart-model-execution.ts,
platform/dev/{seed-billing-history,seed-toolkit,wallet}.ts.
**Barrels needing export-list edits:** models/index.ts, models/domain/index.ts, billing/index.ts, billing/domain/index.ts.

## Symbols with ONLY test/comment/barrel consumers — safe to DELETE with their tests

- **budget.ts:** buildCostManifest, calculateBudgetFromManifest, charsPerTokenForTier, effectiveBudgetCents,
  PAID_CUSHION_NANO_USD (test-only); types CostManifest / FixedCostItem / VariableCostItem / ManifestModelPricing
  (last three have zero external refs at all).
- **pricing.ts:** estimateVideoWorstCaseCents, mediaStorageCost, effectiveOutputCostPerToken,
  estimateMessageCostDevelopment, calculateMessageCostFromActual, calculateTokenCost (all test-only).
- **client-billing.ts:** deriveClientFundingInputs (test-only).
- **eligible-models.ts:** buildEligibleModels, computeMaxClassifierOverhead (test-only);
  computeClassifierWorstCaseCents (private, never exported).
- **estimate.ts (api):** estimateCallNanoUsd (barrel+test-only). **estimate-run.ts:** estimateMinMediaOutputBytes (test-only).
- **money.ts:** MARKUP_BASIS_POINTS (barrel+test-only; rate consumed internally via assert helper).

## Key real callers by source

- **budget.ts calculateBudget** → use-budget-calculation.ts; premium-check.ts. (turn-definition.ts / use-resolve-billing.ts = comment-ref)
- **budget.ts canAffordModel / getEffectiveBalance** → eligible-models.ts.
- **budget.ts estimateTokensForTier** → trial-eligibility.ts, smart-model-candidates.ts, turn-definition.ts, eligible-models.ts.
- **budget.ts outputCharsPerTokenForTier** → turn-definition.ts.
- **budget.ts getCushionCents** → client-billing.ts. **spendableFundsNanoUsd** → admission.ts, turn-definition.ts.
- **budget.ts computeSafeMaxTokens** → turn-definition.ts. **generateNotifications** → use-prompt-budget.ts.
- **budget.ts BudgetCalculationResult (type)** → use-budget-calculation.ts (re-exported as hook return).
- **pricing.ts applyFees** → list-models.ts, format.ts (re-export), premium-check.ts, budget.ts.
- **pricing.ts computeImageExactCents/computeVideoExactCents/computeAudioWorstCaseCents** → use-media-cost-estimate.ts.
- **pricing.ts worstCaseSearchCost** → use-prompt-budget.ts. **estimateTokenCount** → marketing calculate-cost.ts, web tokens.ts.
- **client-billing.ts resolveClientBilling** → use-resolve-billing.ts.
- **eligible-models.ts CLASSIFIER_OUTPUT_TOKEN_CAP** → smart-model-execution.ts, smart-model-candidates.ts.
- **estimate.ts callBaseNanoUsd** → trial-eligibility.ts, smart-model-candidates.ts.
- **estimate.ts estimateRunCeilingNanoUsd** → smart-model-candidates.ts, estimate-run.ts.
- **estimate.ts WORST_CASE_SEARCH_RESERVATION_NANO_USD / mediaCallUsageFor** → estimate-run.ts.
- **estimate.ts priceMediaBaseNanoUsd / priceUsageBaseNanoUsd** → workflows/engine/model-resolver.ts.
- **estimate-run.ts createEstimateRun** → chat/domain/runtime.ts.
- **smart-model-candidates.ts classifierWorstCaseBaseNanoUsd** → estimate-run.ts, trial-smart-model-candidates.ts.
- **smart-model-candidates.ts buildSmartModelCandidates** → chat/domain/smart-model-turn.ts.
- **money.ts applyMarkup** → estimate.ts, smart-model-candidates.ts, estimate-run.ts, settlement.ts, turn-definition.ts,
  charge.ts, seed-billing-history.ts.
- **money.ts usdToNanoUsd** → live-execution-registry.ts, model-call-execution.ts, estimate.ts, seed-* / wallet.ts.
- **money.ts roundHalfEvenDiv** → public-usage-stats.ts.

## Watch-outs
- Comment-ref false positives: worstCaseSearchCost (estimate.ts/constants.ts); getEffectiveBalance/effectiveBudgetCents/
  resolveClientBilling (turn-context/group-budget/nano-usd/budget). Not behavioral callers.
- `process-models.ts` does NOT exist (stale comment); the nano→float collapse happens once in `list-models.ts`.
- Heaviest hubs to sequence first: estimateTokensForTier, applyMarkup (4+ real callers each); the smart-model chain
  (CLASSIFIER_OUTPUT_TOKEN_CAP / callBaseNanoUsd / estimateRunCeilingNanoUsd).
