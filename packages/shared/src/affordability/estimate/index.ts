/**
 * The estimator's published surface, not a directory barrel.
 *
 * `docs/BILLING.md` §Where the Code Lives keeps the pricing machinery itself
 * unexported — rates, manifests, the two reducers, the per-candidate ceiling
 * solvers, the reasoning-budget ladder, the tier ratios and the clamps. Those
 * units are therefore absent here rather than absent one level up: a name this
 * file does not carry cannot reach either entry point, whichever of them stars
 * it. What is published is the vocabulary a caller legitimately names — the
 * fail-closed result channel, the funding pre-adapters, the storage rates, the
 * wire fragment, the reasoning-plan producers, and the display formatters.
 *
 * The plan producers are published while the LADDER they compute from is not,
 * and the split is the point: a caller may ask what a model's plan at an effort
 * IS, and cannot read the budget table to work one out itself. Withholding the
 * producers while four of their siblings were already published bought nothing
 * — it only pushed callers into re-deriving `B + H`, a mirrored formula
 * `docs/CODE-RULES.md` bans.
 */

export * from './storage-rate.js';
export * from './format.js';
export { estimateErr, estimateOk } from './types.js';
export type { EstimateError, EstimateErrorCode, EstimateResult } from './types.js';
export {
  getCushionNano,
  getEffectiveBalanceNano,
  PAID_CUSHION_NANO_USD,
  spendableFundsNanoUsd,
} from './pre-adapters.js';
export { outputTokensOf } from './run-ceiling.js';
export type { CallUsage } from './run-ceiling.js';
export {
  REASONING_OFF_WIRE,
  ReasoningWire,
  planReasoning,
  planReasoningOff,
  reasoningBudgetForWire,
  reasoningPlanModelFrom,
} from './reasoning-plan.js';
export type { ReasoningPlanDescriptorInput, ReasoningPlanModel } from './reasoning-plan.js';
export type { EffortChoice } from './effort-options.js';
