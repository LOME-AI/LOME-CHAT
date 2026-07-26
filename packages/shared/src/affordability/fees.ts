import { HUSHBOX_FEE_RATE, CREDIT_CARD_FEE_RATE, PROVIDER_FEE_RATE } from './constants.js';

/** Stable identifier for a fee category. Surfaces use this to map categories to UI placement. */
export type FeeCategoryId = 'hushbox' | 'card-processing' | 'provider';

export interface FeeCategory {
  /** Stable identifier — never changes, even if labels are reworded. */
  readonly id: FeeCategoryId;
  /**
   * Long-form label, sentence-flow casing. Used in legal sentences and descriptive UI lists.
   * Proper nouns and acronyms remain capitalized; everything else is lowercase so the label
   * reads naturally inside a comma-joined sentence.
   */
  readonly label: string;
  /** Compact form, Title Case. Used in tables, emails, and SVG cells where space is tight. */
  readonly shortLabel: string;
  /** "What it covers" copy, used in the pricing SVG table. */
  readonly description: string;
  /** Rate as a fraction in [0, 1]. Sourced from constants.ts so a constant change cascades here. */
  readonly rate: number;
}

/**
 * Every fee category, including those whose rate is currently 0. Surfaces should consume
 * FEE_CATEGORIES (filtered) for rendering; ALL_FEE_CATEGORIES is exposed for tests that
 * verify zero-rate categories are absent from rendered output.
 */
export const ALL_FEE_CATEGORIES: readonly FeeCategory[] = [
  {
    id: 'hushbox',
    label: 'HushBox margin',
    shortLabel: 'HushBox',
    description: 'Development, servers, support',
    rate: HUSHBOX_FEE_RATE,
  },
  {
    id: 'card-processing',
    label: 'credit card processing',
    shortLabel: 'Card processing',
    description: 'Credit card fees',
    rate: CREDIT_CARD_FEE_RATE,
  },
  {
    id: 'provider',
    label: 'AI provider overhead',
    shortLabel: 'Provider overhead',
    description: 'API infrastructure',
    rate: PROVIDER_FEE_RATE,
  },
];

/**
 * Fee categories with rate > 0 — what UI/copy surfaces should render. Surfaces never
 * hardcode percentages or category labels; they iterate this list. A future change that
 * zeros a rate automatically removes the category from every consuming surface.
 */
export const FEE_CATEGORIES: readonly FeeCategory[] = ALL_FEE_CATEGORIES.filter(
  (category) => category.rate > 0
);

/** UI buckets used by the fee-breakdown and cost-pie-chart components to group fees. */
export type FeeBucketId = 'transaction-costs' | 'platform-fee';

/**
 * Maps every fee category id to its UI bucket. Single source of truth — both
 * fee-breakdown.tsx and cost-pie-chart.tsx (plus their tests) import this rather
 * than duplicating the mapping. Exhaustive over FeeCategoryId; adding a new fee
 * category requires extending this Record (TypeScript will catch missing keys).
 */
export const FEE_BUCKET_BY_ID: Record<FeeCategoryId, FeeBucketId> = {
  'card-processing': 'transaction-costs',
  provider: 'transaction-costs',
  hushbox: 'platform-fee',
};

/**
 * Format a rate as a percent string ("0.05" → "5%", "0" → "0%").
 *
 * Clamps floating-point artifacts that arise when callers pass an arithmetic
 * combination of rates (e.g. `0.1 + 0.2` is `0.30000000000000004` in IEEE 754,
 * which would otherwise render as `30.000000000000004%`). Four decimal places
 * of precision is enough for any plausible fee rate; trailing zeros are
 * stripped by the `Number()` round-trip ("4.5000" → "4.5").
 */
export function formatFeePercent(rate: number): string {
  const percent = Number((rate * 100).toFixed(4));
  return `${String(percent)}%`;
}

/**
 * Round numeric values to integers while preserving their total sum (largest-remainder /
 * Hare-Niemeyer method). Minimizes L1 rounding error and guarantees that the sum of the
 * rounded outputs equals Math.round of the input sum — so percentages intended to add up
 * to 100 actually do, after rounding.
 *
 * Tie-break for equal fractional parts: lower index wins (stable across runs).
 */
export function roundPreservingSum(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const target = Math.round(values.reduce((sum, value) => sum + value, 0));
  const floors = values.map((value) => Math.floor(value));
  const floorSum = floors.reduce((sum, value) => sum + value, 0);
  const remainder = target - floorSum;
  if (remainder === 0) return floors;

  const order = values
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .toSorted((a, b) => b.frac - a.frac || a.index - b.index)
    .map((entry) => entry.index);

  const incrementSet = new Set(order.slice(0, remainder));
  return floors.map((value, index) => (incrementSet.has(index) ? value + 1 : value));
}
