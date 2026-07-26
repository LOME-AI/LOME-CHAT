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
 * The catalog is a fourth argument. §Where the Code Lives writes the call as
 * `getTurnOptions(funding, basis, selection)`, but a `Selection` names models by
 * identifier and §Smart Model requires the pool to be derivable from the catalog
 * and the prompt size, so the priceable pool has to arrive from somewhere; the
 * documented three stay first and in their documented order.
 */

import { nanoUSD } from './nano-usd.js';
import { evaluateTurn } from './turn-core.js';
import { EMPTY_PROMPT_BASIS } from './turn-types.js';
import type { PriceableModel } from './priceable-model.js';
import type { FundingSnapshot, PromptBasis, Selection, TurnOptions } from './turn-types.js';

export function getTurnOptions(
  funding: FundingSnapshot,
  basis: PromptBasis,
  selection: Selection,
  catalog: readonly PriceableModel[]
): TurnOptions {
  const spendableNanoUsd = BigInt(funding.spendableNanoUsd);
  // `effectiveBalance = spendable + holds`: both funding numbers are derivable
  // from what the wire already serves, so there is no second request for this.
  const effectiveBalanceNanoUsd = spendableNanoUsd + BigInt(funding.heldNanoUsd);

  const affordable = evaluateTurn({
    fundingNanoUsd: effectiveBalanceNanoUsd,
    basis: EMPTY_PROMPT_BASIS,
    selection,
    catalog,
    tier: funding.tier,
  });
  const admissible = evaluateTurn({
    fundingNanoUsd: spendableNanoUsd,
    basis,
    selection,
    catalog,
    tier: funding.tier,
  });

  // A hold is only ever taken against `spendable`, and only when the turn can
  // actually start; the affordable pass's own total is deliberately discarded.
  const holdNanoUsd =
    admissible.optionSet.sendable && admissible.totalNanoUsd !== undefined
      ? nanoUSD(admissible.totalNanoUsd)
      : undefined;

  return { affordable: affordable.optionSet, admissible: admissible.optionSet, holdNanoUsd };
}
