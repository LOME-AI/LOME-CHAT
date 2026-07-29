/**
 * `getTurnOptions` — the one producer. Nothing else in the system may construct
 * a {@link TurnOptions} or either of its option sets.
 *
 * It is called ONCE, with the composed prompt basis, and internally evaluates
 * one pure core over two `(funding, basis)` pairs:
 *
 * | set          | funding                          | basis         |
 * | ------------ | -------------------------------- | ------------- |
 * | `affordable` | `effectiveBalance` = spendable + held | empty    |
 * | `admissible` | `spendable`                      | the composed one |
 *
 * The two sets differ in TWO inputs, not one. `affordable` answers a question
 * about the model and the payer's money, so it must not move while the user
 * types; `admissible` answers what can start right now. The producer applies
 * both substitutions itself — no signature here accepts a basis for the
 * `affordable` set — so a prompt-dependent floor and a hold-blind send gate are
 * unobtainable rather than merely discouraged (`docs/BILLING.md` §Affordability
 * 2, §Affordability §Scope).
 *
 * `admissible ⊆ affordable` follows because both differing inputs push the same
 * way: `spendable ≤ effectiveBalance` shrinks what the money buys, and a real
 * prompt basis is never smaller than the empty one, so it shrinks context
 * headroom and raises fixed costs.
 *
 * The fourth argument is a catalog SNAPSHOT rather than the catalog itself.
 * §The public surface already documents a fourth `catalog` argument and calls it
 * necessary rather than convenient — a `Selection` names models by identifier, and
 * §Smart Model requires the pool to be derivable from the catalog and the prompt
 * size, so the pool has to arrive from somewhere. What this signature adds to that
 * argument is the reference instant, because both legs of premium classification
 * are properties of the pool AS OF an instant: the price percentile is taken over
 * the pool, and the recency window is measured from the instant
 * (§Model Classification). This module holds no clock, so the instant arrives as
 * an argument or not at all — and one snapshot feeds both passes, so `affordable`
 * and `admissible` cannot classify a model differently.
 */

import { nanoUSD } from './nano-usd.js';
import { PREMIUM_RECENCY_MS } from './premium.js';
import { evaluateTurn } from './turn-core.js';
import { EMPTY_PROMPT_BASIS } from './turn-types.js';
import type {
  CatalogSnapshot,
  FundingSnapshot,
  PromptBasis,
  Selection,
  TurnOptions,
} from './turn-types.js';

/**
 * The snapshot's instant, refused unless it can carry the meaning premium
 * classification gives it.
 *
 * This is the same posture the module already takes on a count (`promptChars`
 * throws) and on an identifier (`ModelId` refuses the empty string), and it is
 * needed for the same reason: classification is a money verdict, so an unusable
 * instant must not be absorbed. Absorbing one fails PERMISSIVE — a
 * non-comparable instant makes every recency test false, which turns a premium
 * row available rather than refusing it.
 *
 * The lower bound is the recency window itself: below it the window reaches
 * before the epoch, so "released recently" would be true of every model ever
 * released. There is deliberately NO upper bound — a far-future instant is a
 * representable instant whose recency leg is legitimately vacuous, and this module
 * holds no clock to check a caller's against. What protects money there is the
 * other leg: the price percentile reads no clock at all.
 */
function requireUsableInstant(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < PREMIUM_RECENCY_MS) {
    throw new RangeError(
      'getTurnOptions: the catalog snapshot instant must be a safe integer no earlier than the premium recency window'
    );
  }
}

export function getTurnOptions(
  funding: FundingSnapshot,
  basis: PromptBasis,
  selection: Selection,
  catalog: CatalogSnapshot
): TurnOptions {
  requireUsableInstant(catalog.nowMs);
  const spendableNanoUsd = BigInt(funding.spendableNanoUsd);
  // `effectiveBalance = spendable + holds`: both funding numbers are derivable
  // from what the wire already serves, so there is no second request for this.
  const effectiveBalanceNanoUsd = spendableNanoUsd + BigInt(funding.heldNanoUsd);

  const affordable = evaluateTurn({
    fundingNanoUsd: effectiveBalanceNanoUsd,
    basis: EMPTY_PROMPT_BASIS,
    selection,
    catalog: catalog.models,
    tier: funding.payerTier,
    nowMs: catalog.nowMs,
  });
  const admissible = evaluateTurn({
    fundingNanoUsd: spendableNanoUsd,
    basis,
    selection,
    catalog: catalog.models,
    tier: funding.payerTier,
    nowMs: catalog.nowMs,
  });

  // A hold is only ever taken against `spendable`, and only when the turn can
  // actually start; the affordable pass's own total is deliberately discarded.
  const holdNanoUsd =
    admissible.optionSet.sendable && admissible.totalNanoUsd !== undefined
      ? nanoUSD(admissible.totalNanoUsd)
      : undefined;

  return { affordable: affordable.optionSet, admissible: admissible.optionSet, holdNanoUsd };
}
