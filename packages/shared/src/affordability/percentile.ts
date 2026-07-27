/**
 * The one percentile over a nano-USD sample. Two money decisions need one —
 * the premium price threshold (`docs/BILLING.md` §Model Classification) and the
 * outlier median (§Predicates) — and both must be reproducible from the pool
 * alone, so the selection rule lives here once rather than being spelled out at
 * each call site.
 *
 * The result is always an OBSERVED member of the sample: for an even-sized
 * sample the upper of the two middle values is taken rather than their average,
 * so no rounding rule is needed and no threshold exists that no model in the
 * pool actually charges. `topContextExemptionTokens` in `catalog-admission.ts`
 * is deliberately NOT folded in here: it selects over token counts and its ties
 * are inclusive by design, so the two answer different questions.
 */

/**
 * The value at `floor(n × p)` of the ascending sample, or `undefined` for an
 * empty one. `p` is clamped into the sample so `p = 1` yields the maximum rather
 * than reading past the end.
 */
function ascending(left: bigint, right: bigint): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export function nanoPercentile(values: readonly bigint[], percentile: number): bigint | undefined {
  const sorted = values.toSorted(ascending);
  if (sorted.length === 0) return undefined;
  const index = Math.min(Math.floor(sorted.length * percentile), sorted.length - 1);
  return sorted[index];
}
