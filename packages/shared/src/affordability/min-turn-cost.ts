/**
 * `minTurnCost` (`docs/BILLING.md` §Math & Terms) — the least a turn could
 * possibly cost if a given payer paid for it. It is the number the payer
 * decision consumes, never a full estimate: an estimate's ceiling is bounded by
 * the payer's own funding, so pricing one in order to CHOOSE the payer would
 * need the answer first. This is a bound, and bounds are what a decision that
 * gates pricing may consume.
 *
 * It is priced at the `eligible(m)` corner — every fixed term plus the cheapest
 * reasoning rung the model can actually run and a minimum viable answer.
 * Dropping the fixed terms or the reasoning term yields a number that is
 * smaller but NOT sufficient: a headroom clearing it would still fail
 * admission, which is the permanent-refusal class the comparison exists to
 * prevent.
 *
 * Composition only — every term is a named §Math & Terms function, and no
 * formula is restated here. Pure: counts, rates and identifiers, no clock and
 * no content.
 */

import { cheapestEffortOption } from './dimensions/effort.js';
import { webSearchLineItem } from './estimate/search-reservation.js';
import {
  fixedCostsNanoUsd,
  inputStorageNanoUsd,
  inputTokensOf,
  requiredCeilingTokens,
  variableRateNanoUsd,
} from './turn-arithmetic.js';
import type { PriceableModel } from './priceable-model.js';
import type { UserTier } from './tiers.js';
import type { NonEmpty, PromptBasis } from './turn-types.js';

export interface MinTurnCostInput {
  /** Every sibling that will answer. A turn with no model is unpriceable, not free. */
  readonly siblings: NonEmpty<PriceableModel>;
  /**
   * `promptChars` — the measured total (system prompt + instructions + history
   * + input). A total rather than a {@link PromptBasis}: a caller holding one
   * measurement would otherwise have to split it into components it never
   * measured separately, which is a second measurement shape for one number.
   */
  readonly promptChars: number;
  /**
   * The CANDIDATE PAYER's tier — it fixes the input and output-storage ratios,
   * so the same turn prices differently depending on who would pay for it
   * (§Group Funding 1: owner-funded means owner-priced).
   */
  readonly tier: UserTier;
  /** Whether the turn's content will rest. A non-persisting turn carries no storage term. */
  readonly persists: boolean;
  /** Non-zero exactly when a classifier may run (§Reserve ⟺ classify). */
  readonly classifierReserveNanoUsd: bigint;
  /** Whether the web-search tool is on — the one `additive` dimension today. */
  readonly webSearch: boolean;
}

/** The measured total as a basis: one component carrying the whole count. */
function basisOf(promptChars: number): PromptBasis {
  return {
    systemChars: 0,
    instructionChars: 0,
    historyChars: 0,
    inputChars: promptChars,
    attachmentBytes: 0,
  };
}

/**
 * The widest `B(m, e_min(m)) + MINIMUM_OUTPUT_TOKENS` across the siblings.
 *
 * It is a MAX rather than a per-sibling sum for a reason the single-model case
 * hides: the siblings share ONE token count `T`, so every sibling's ceiling is
 * clamped to it, and a turn is runnable only when `T` reaches the WIDEST
 * corner. Pricing each sibling at its own corner (`Σᵢ cornerᵢ × rateᵢ`) yields
 * a weighted average of the corners, which is below the widest one whenever the
 * corners differ — a mandatory-reasoning sibling beside an ordinary one — so it
 * would clear a headroom that cannot in fact run the turn. With one sibling the
 * two readings are the same number.
 */
function widestCornerTokens(siblings: NonEmpty<PriceableModel>): number {
  return Math.max(
    ...siblings.map((model) => requiredCeilingTokens(model, cheapestEffortOption(model)))
  );
}

/** Σ of every `additive` dimension's requirement; web search is today's only one. */
function additiveNanoUsd(input: MinTurnCostInput): bigint {
  if (!input.webSearch) return 0n;
  /* v8 ignore next -- the search reservation is a fixed item by construction;
     the fallback only narrows the line item's optional amount for the compiler */
  return webSearchLineItem(input.siblings.length).fixedNano ?? 0n;
}

/**
 * `minTurnCost` = `fixedCosts + corner × Σᵢ variableRate(mᵢ)`, at the candidate
 * payer's tier.
 */
export function minTurnCostNanoUsd(input: MinTurnCostInput): bigint {
  const basis = basisOf(input.promptChars);
  const fixed = fixedCostsNanoUsd({
    siblings: input.siblings,
    inputTokens: inputTokensOf(basis, input.tier),
    inputStorageNanoUsd: inputStorageNanoUsd(basis, input.persists),
    classifierReserveNanoUsd: input.classifierReserveNanoUsd,
    additiveNanoUsd: additiveNanoUsd(input),
  });
  const summedVariableRate = input.siblings.reduce(
    (total, model) => total + variableRateNanoUsd(model, input.tier, input.persists),
    0n
  );
  return fixed + BigInt(widestCornerTokens(input.siblings)) * summedVariableRate;
}
