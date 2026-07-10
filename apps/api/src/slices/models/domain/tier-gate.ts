import { trialEligibility } from './trial-eligibility.js';
import type { ModelDescriptor } from '@hushbox/shared';

/**
 * The paid premium-tier gate (legacy `findTierLockedModel` / `isPremiumModel`).
 * "Premium" reuses the trial gate's fresh premium legs verbatim — a model is
 * premium exactly when {@link trialEligibility} would refuse it as `premium`:
 * the top price quartile ({@link trialPriceThresholdNanoUsd}), a release inside
 * the recency window, or a minimal-exchange unaffordability, plus the
 * un-priceable-is-premium fail-closed. Sharing the one predicate keeps the paid
 * gate and the trial gate from ever disagreeing on what premium means. A
 * non-text model is never tier-premium (trial refuses it as `non-text`, a
 * separate class); the paid text single/multi-model paths are the only callers.
 */
function isPremiumModel(
  descriptor: ModelDescriptor,
  exposedCatalog: readonly ModelDescriptor[],
  nowMs: number
): boolean {
  const verdict = trialEligibility(descriptor, exposedCatalog, nowMs);
  return !verdict.eligible && verdict.reason === 'premium';
}

/**
 * The first selected model a caller may not use — the paid MODEL_TIER_LOCKED
 * gate. Returns `undefined` when the caller can access premium (a positive
 * purchased balance, resolved by the caller), when no selected model is
 * premium, or when a selected id is absent from the exposed catalog (the turn
 * build refuses an unknown model, so the gate ignores it here). Iterates in
 * selection order so a multi-model send locks on its first premium member —
 * legacy first-in-set behaviour.
 */
export function findTierLockedModel(
  models: readonly string[],
  exposedCatalog: readonly ModelDescriptor[],
  canAccessPremium: boolean,
  nowMs: number
): ModelDescriptor | undefined {
  if (canAccessPremium) return undefined;
  for (const id of models) {
    const descriptor = exposedCatalog.find((entry) => entry.id === id);
    if (descriptor === undefined) continue;
    if (isPremiumModel(descriptor, exposedCatalog, nowMs)) return descriptor;
  }
  return undefined;
}
