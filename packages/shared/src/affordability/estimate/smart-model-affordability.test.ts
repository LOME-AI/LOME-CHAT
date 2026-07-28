import { describe, expect, it } from 'vitest';
import { nanoUSD } from '../nano-usd.js';
import { MINIMUM_OUTPUT_TOKENS } from '../constants.js';
import {
  admitSmartModel,
  classifierReserveLineItems,
  priceSmartModelPool,
  smartModelMinimumRequiredNanoUsd,
} from './smart-model-affordability.js';
import type { SmartModelPoolCandidate } from './smart-model-affordability.js';
import type { Pricing } from '../model-descriptor.js';

const CHEAP: SmartModelPoolCandidate = {
  id: 'cheap',
  description: 'cheap and fast',
  pricing: { inputPerToken: nanoUSD(1n), outputPerToken: nanoUSD(2n) },
  contextLength: 1000,
};
const BIG: SmartModelPoolCandidate = {
  id: 'big',
  pricing: { inputPerToken: nanoUSD(1000n), outputPerToken: nanoUSD(2000n) },
  contextLength: 2000,
};

describe('classifierReserveLineItems', () => {
  it('prices the classifier reserve as a provider line item and nothing else', () => {
    // No storage leg exists to price: the classifier's prompt and answer never
    // rest. A caller that sums this list therefore cannot charge storage.
    const items = classifierReserveLineItems(CHEAP, [{ id: 'cheap' }]);
    expect(items?.map((item) => item.kind)).toEqual(['provider']);
  });

  it('returns undefined when the classifier lacks a per-token rate', () => {
    const rateless: { readonly pricing: Pricing } = { pricing: {} };
    expect(classifierReserveLineItems(rateless, [{ id: 'x' }])).toBeUndefined();
  });
});

describe('billable-only pricing (no fee math in the estimator)', () => {
  it("prices the classifier reserve as the provider item's own billable figure", () => {
    // Rates are billable at ingestion, so the pool's classifier worst case is
    // exactly the provider line item's fixedNano — no markup on top.
    const pool = priceSmartModelPool([CHEAP, BIG])!;
    const providerItem = classifierReserveLineItems(CHEAP, [CHEAP, BIG])?.find(
      (item) => item.kind === 'provider'
    );
    expect(pool.classifierWorstCaseNanoUsd).toBe(providerItem?.fixedNano);
  });
});

describe('priceSmartModelPool', () => {
  it('returns null for an empty candidate pool', () => {
    expect(priceSmartModelPool([])).toBeNull();
  });

  it('returns null when the cheapest candidate has no per-token rate to reserve against', () => {
    const rateless: SmartModelPoolCandidate = { id: 'free', pricing: {}, contextLength: 1000 };
    // Missing rates sort as combined 0n, so this candidate is the classifier
    // pick; an unpriceable classifier fails the whole pool closed.
    expect(priceSmartModelPool([rateless, BIG])).toBeNull();
  });

  it('returns null when no candidate can price a floor', () => {
    const noContext: SmartModelPoolCandidate = {
      id: 'nolimit',
      pricing: { inputPerToken: nanoUSD(5n), outputPerToken: nanoUSD(5n) },
    };
    expect(priceSmartModelPool([noContext])).toBeNull();
  });

  it('excludes a candidate whose floor cannot price (context but no output rate)', () => {
    const noOutputRate: SmartModelPoolCandidate = {
      id: 'no-output-rate',
      pricing: { inputPerToken: nanoUSD(500n) },
      contextLength: 1000,
    };
    const pool = priceSmartModelPool([CHEAP, noOutputRate]);
    expect(pool?.priced.map((candidate) => candidate.id)).toEqual(['cheap']);
  });

  it('excludes an unpriceable candidate (no context length) from the priced set', () => {
    const noContext: SmartModelPoolCandidate = {
      id: 'nolimit',
      pricing: { inputPerToken: nanoUSD(5n), outputPerToken: nanoUSD(5n) },
    };
    const pool = priceSmartModelPool([CHEAP, noContext]);
    expect(pool?.priced.map((candidate) => candidate.id)).toEqual(['cheap']);
  });

  it('sorts the priced set ascending by combined base price with the cheapest as classifier', () => {
    const pool = priceSmartModelPool([BIG, CHEAP]);
    expect(pool?.classifierModelId).toBe('cheap');
    expect(pool?.priced.map((candidate) => candidate.id)).toEqual(['cheap', 'big']);
  });

  it('keeps both candidates when two share the same combined price (a sort tie)', () => {
    const tieA: SmartModelPoolCandidate = {
      id: 'tie-a',
      pricing: { inputPerToken: nanoUSD(1n), outputPerToken: nanoUSD(2n) },
      contextLength: 1000,
    };
    const tieB: SmartModelPoolCandidate = {
      id: 'tie-b',
      pricing: { inputPerToken: nanoUSD(1n), outputPerToken: nanoUSD(2n) },
      contextLength: 1000,
    };
    const pool = priceSmartModelPool([tieA, tieB]);
    expect(pool?.priced.map((candidate) => candidate.id).toSorted()).toEqual(['tie-a', 'tie-b']);
  });

  it('sets the minimum required to the reserve plus the cheapest candidate floor', () => {
    const pool = priceSmartModelPool([CHEAP, BIG]);
    const cheapFloor = pool?.priced.find((candidate) => candidate.id === 'cheap')?.floorNanoUsd;
    expect(pool?.minimumRequiredNanoUsd).toBe(pool!.classifierWorstCaseNanoUsd + cheapFloor!);
  });

  it('prices floors against the stamped prompt tokens, below the full-context worst case', () => {
    const stamped = priceSmartModelPool([CHEAP, BIG], 50);
    const fullContext = priceSmartModelPool([CHEAP, BIG]);
    // A small stamped prompt (50 input tokens, MINIMUM_OUTPUT_TOKENS output)
    // yields a smaller floor than pricing the whole context window on both legs.
    expect(stamped!.minimumRequiredNanoUsd).toBeLessThan(fullContext!.minimumRequiredNanoUsd);
  });
});

// Wide-context models (remaining ≫ MINIMUM_OUTPUT_TOKENS after the prompt) so the
// budget — not the context — is the binding limit for the cap. prompt = 100 tokens.
const SMALL: SmartModelPoolCandidate = {
  id: 'small',
  description: 'cheap wide',
  pricing: { inputPerToken: nanoUSD(100n), outputPerToken: nanoUSD(200n) },
  contextLength: 5000,
};
const LARGE: SmartModelPoolCandidate = {
  id: 'large',
  pricing: { inputPerToken: nanoUSD(100_000n), outputPerToken: nanoUSD(200_000n) },
  contextLength: 5000,
};
const PROMPT = 100;

describe('admitSmartModel (per-candidate affordable caps)', () => {
  it('refuses a $0 wallet (the classifier reserve alone exceeds it)', () => {
    expect(admitSmartModel([SMALL, LARGE], 0n, PROMPT)).toBeNull();
  });

  it('refuses an empty candidate pool outright', () => {
    expect(admitSmartModel([], 10n ** 18n, PROMPT)).toBeNull();
  });

  it('excludes a candidate whose context is consumed by the prompt (no answer room)', () => {
    // ctx 100 ≤ prompt 100 ⇒ remaining < 1: it prices a (clamped) floor but can
    // never fund an answer, so admission drops it from the eligible set.
    const consumed: SmartModelPoolCandidate = {
      id: 'consumed',
      pricing: { inputPerToken: nanoUSD(100n), outputPerToken: nanoUSD(200n) },
      contextLength: PROMPT,
    };
    const admission = admitSmartModel([SMALL, consumed], 10n ** 18n, PROMPT)!;
    expect(admission.candidates.map((c) => c.id)).toEqual(['small']);
  });

  it('admits without a stamped prompt, giving the whole context as answer room', () => {
    const admission = admitSmartModel([SMALL], 10n ** 18n)!;
    // No stamped prompt assumes a negligible input: cap = full context.
    expect(admission.candidates[0]?.maxOutputTokens).toBe(5000);
  });

  it('admits at exactly the minimum required and refuses one nano below (biconditional boundary)', () => {
    const threshold = smartModelMinimumRequiredNanoUsd([SMALL, LARGE], PROMPT)!;
    expect(admitSmartModel([SMALL, LARGE], threshold, PROMPT)).not.toBeNull();
    expect(admitSmartModel([SMALL, LARGE], threshold - 1n, PROMPT)).toBeNull();
  });

  it('gives a cheaper model a larger cap; every cap ≥ MINIMUM and the reserve ≤ balance', () => {
    const balance = smartModelMinimumRequiredNanoUsd([SMALL, LARGE], PROMPT)! + 5_000_000_000n;
    const admission = admitSmartModel([SMALL, LARGE], balance, PROMPT)!;
    const small = admission.candidates.find((c) => c.id === 'small')!;
    const large = admission.candidates.find((c) => c.id === 'large')!;
    expect(small.maxOutputTokens).toBeGreaterThanOrEqual(large.maxOutputTokens);
    expect(small.maxOutputTokens).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
    expect(large.maxOutputTokens).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
    expect(admission.reserveNanoUsd).toBeLessThanOrEqual(balance);
  });

  it('excludes an unaffordable candidate — the classifier can only pick from the eligible set', () => {
    // At exactly the (SMALL-driven) minimum, SMALL affords a minimum answer but
    // LARGE cannot: only SMALL is in node.candidates, so LARGE is unclassifiable.
    const threshold = smartModelMinimumRequiredNanoUsd([SMALL, LARGE], PROMPT)!;
    const admission = admitSmartModel([SMALL, LARGE], threshold, PROMPT)!;
    expect(admission.candidates.map((c) => c.id)).toEqual(['small']);
  });

  it('keeps the reserve balance-INDEPENDENT for a well-funded wallet (concurrency preserved)', () => {
    const rich = admitSmartModel([SMALL, LARGE], 10n ** 18n, PROMPT)!;
    const richer = admitSmartModel([SMALL, LARGE], 10n ** 20n, PROMPT)!;
    expect(rich.reserveNanoUsd).toBe(richer.reserveNanoUsd);
    // Each candidate reaches its full remaining context (5000 − 100).
    expect(rich.candidates.every((c) => c.maxOutputTokens === 4900)).toBe(true);
  });

  it('carries the description through and omits it where the candidate has none', () => {
    const admission = admitSmartModel([SMALL, LARGE], 10n ** 18n, PROMPT)!;
    expect(admission.candidates.find((c) => c.id === 'small')).toMatchObject({
      description: 'cheap wide',
    });
    expect(admission.candidates.find((c) => c.id === 'large')).not.toHaveProperty('description');
  });
});

describe('provider completion cap (maxOutputTokens) bounds candidate caps', () => {
  it('caps a rich payer at the provider completion ceiling, not the context', () => {
    const capped: SmartModelPoolCandidate = { ...SMALL, maxOutputTokens: 2000 };
    const admission = admitSmartModel([capped], 10n ** 18n)!;
    expect(admission.candidates[0]?.maxOutputTokens).toBe(2000);
  });

  it('keeps the remaining-context bound when it is tighter than the cap', () => {
    const capped: SmartModelPoolCandidate = { ...SMALL, maxOutputTokens: 100_000 };
    const admission = admitSmartModel([capped], 10n ** 18n, PROMPT)!;
    expect(admission.candidates[0]?.maxOutputTokens).toBe(5000 - PROMPT);
  });

  it('reserves less for a capped model than the identical uncapped model', () => {
    const capped: SmartModelPoolCandidate = { ...SMALL, maxOutputTokens: 2000 };
    const cappedReserve = admitSmartModel([capped], 10n ** 18n, PROMPT)!.reserveNanoUsd;
    const uncappedReserve = admitSmartModel([SMALL], 10n ** 18n, PROMPT)!.reserveNanoUsd;
    expect(cappedReserve).toBeLessThan(uncappedReserve);
  });

  it('falls back to the context bound when the cap is absent (unchanged behavior)', () => {
    const admission = admitSmartModel([SMALL], 10n ** 18n)!;
    expect(admission.candidates[0]?.maxOutputTokens).toBe(5000);
  });

  it('excludes a candidate whose cap cannot fit a minimum answer', () => {
    const tiny: SmartModelPoolCandidate = {
      ...SMALL,
      id: 'tiny-cap',
      maxOutputTokens: MINIMUM_OUTPUT_TOKENS - 1,
    };
    const admission = admitSmartModel([SMALL, tiny], 10n ** 18n, PROMPT)!;
    expect(admission.candidates.map((c) => c.id)).toEqual(['small']);
  });

  it('excludes a below-minimum cap from the minimum-required threshold too', () => {
    const tiny: SmartModelPoolCandidate = {
      ...SMALL,
      id: 'tiny-cap',
      maxOutputTokens: MINIMUM_OUTPUT_TOKENS - 1,
    };
    expect(smartModelMinimumRequiredNanoUsd([tiny], PROMPT)).toBeNull();
  });

  it('bounds the full-context worst-case floor by the cap', () => {
    const capped: SmartModelPoolCandidate = { ...SMALL, maxOutputTokens: 2000 };
    const cappedFloor = priceSmartModelPool([capped])!.minimumRequiredNanoUsd;
    const uncappedFloor = priceSmartModelPool([SMALL])!.minimumRequiredNanoUsd;
    expect(cappedFloor).toBeLessThan(uncappedFloor);
  });

  it('never emits a candidate cap above the provider ceiling at any balance (sweep)', () => {
    const capped: SmartModelPoolCandidate = { ...SMALL, maxOutputTokens: 2000 };
    for (let exponent = 6n; exponent <= 20n; exponent += 1n) {
      const admission = admitSmartModel([capped, LARGE], 10n ** exponent, PROMPT);
      for (const candidate of admission?.candidates ?? []) {
        if (candidate.id === 'small') {
          expect(candidate.maxOutputTokens).toBeLessThanOrEqual(2000);
        }
      }
    }
  });
});

describe('smartModelMinimumRequiredNanoUsd', () => {
  it('returns null for an empty candidate pool', () => {
    expect(smartModelMinimumRequiredNanoUsd([], PROMPT)).toBeNull();
  });

  it('returns null when no priced candidate has room for a minimum answer', () => {
    // ctx 500 leaves remaining 400 < MINIMUM_OUTPUT_TOKENS after the prompt:
    // the pool prices, but no candidate can fit a minimum answer.
    const cramped: SmartModelPoolCandidate = {
      id: 'cramped',
      pricing: { inputPerToken: nanoUSD(1n), outputPerToken: nanoUSD(2n) },
      contextLength: 500,
    };
    expect(smartModelMinimumRequiredNanoUsd([cramped], PROMPT)).toBeNull();
  });

  it('takes the smaller threshold when a pricier-rate candidate is cheaper at the minimum', () => {
    // Ascending combined rate puts inputHeavy (10+1=11) after outputHeavy
    // (1+2=3), but at prompt=100 the LATER candidate's minimum-answer threshold
    // is smaller: 100×10 + 1000×1 = 2000 < 100×1 + 1000×2 = 2100.
    const outputHeavy: SmartModelPoolCandidate = {
      id: 'output-heavy',
      pricing: { inputPerToken: nanoUSD(1n), outputPerToken: nanoUSD(2n) },
      contextLength: 100_000,
    };
    const inputHeavy: SmartModelPoolCandidate = {
      id: 'input-heavy',
      pricing: { inputPerToken: nanoUSD(10n), outputPerToken: nanoUSD(1n) },
      contextLength: 100_000,
    };
    const pair = smartModelMinimumRequiredNanoUsd([outputHeavy, inputHeavy], PROMPT)!;
    const alone = smartModelMinimumRequiredNanoUsd([outputHeavy], PROMPT)!;
    expect(pair).toBeLessThan(alone);
  });
});

describe('client verdict tracks server admission (one shared gate)', () => {
  // The client denies below `smartModelMinimumRequiredNanoUsd`; the server refuses
  // when admitSmartModel is null. Both derive from the SAME per-candidate math, so
  // the two verdicts cannot disagree at the threshold.
  it('client (≥ threshold) matches server admission across a balance sweep', () => {
    const threshold = smartModelMinimumRequiredNanoUsd([SMALL, LARGE], PROMPT)!;
    const step = threshold / 5n || 1n;
    for (let balance = 0n; balance <= threshold * 3n; balance += step) {
      const clientAffordable = balance >= threshold;
      const serverAdmits = admitSmartModel([SMALL, LARGE], balance, PROMPT) !== null;
      expect(serverAdmits).toBe(clientAffordable);
    }
  });
});

// The client threshold and the server pre-gate (admitSmartModel non-null) both
// price the classifier reserve over the FULL priceable pool; the run estimator
// re-prices it over the ELIGIBLE subset (node.candidates — the classifier's real
// runtime menu), which is a SUBSET, so its hold is only ever ≤ the full-pool
// reserve the client budgeted for. This pins that the client==server boundary is
// EXACT even when the eligible subset is strictly smaller than the full pool AND
// the full-pool cheapest (the classifier) is itself ineligible — the case the
// classifier-reserve basis could otherwise drift on.
describe('biconditional holds when the eligible subset ⊊ the full pool', () => {
  // Cheapest ⇒ the classifier, but its context (500) cannot fit prompt (100) +
  // MINIMUM_OUTPUT_TOKENS (1000) ⇒ ineligible: it is the classifier yet absent
  // from the eligible candidate set. Its description still rides the FULL-pool
  // classifier prompt the client/server pre-gate price, not the eligible-subset
  // prompt the estimator prices.
  const TINY_CLASSIFIER: SmartModelPoolCandidate = {
    id: 'tiny',
    description: 'cheapest but tiny context — the classifier, not a candidate',
    pricing: { inputPerToken: nanoUSD(1n), outputPerToken: nanoUSD(2n) },
    contextLength: 500,
  };
  const WIDE_CHEAP: SmartModelPoolCandidate = {
    id: 'wide-cheap',
    description: 'wide context, cheap rate',
    pricing: { inputPerToken: nanoUSD(5n), outputPerToken: nanoUSD(10n) },
    contextLength: 8000,
  };
  const WIDE_PRICEY: SmartModelPoolCandidate = {
    id: 'wide-pricey',
    description: 'wide context, pricier rate',
    pricing: { inputPerToken: nanoUSD(6n), outputPerToken: nanoUSD(12n) },
    contextLength: 8000,
  };
  const POOL = [TINY_CLASSIFIER, WIDE_CHEAP, WIDE_PRICEY];
  const STORAGE = { outputCharsPerToken: 2, inputChars: 400 };

  it('keeps the ineligible cheapest as the classifier while excluding it from the candidate set', () => {
    const threshold = smartModelMinimumRequiredNanoUsd(POOL, PROMPT, STORAGE)!;
    const admission = admitSmartModel(POOL, threshold, PROMPT, STORAGE)!;
    expect(admission.classifierModelId).toBe('tiny');
    expect(admission.candidates.map((c) => c.id)).not.toContain('tiny');
    // The eligible set at the threshold is a strict subset (only the cheapest
    // wide model affords a minimum answer), so the estimator's node.candidates
    // prompt differs from the full-pool prompt the threshold priced.
    expect(admission.candidates.map((c) => c.id)).toEqual(['wide-cheap']);
  });

  it('admits at exactly the client threshold and refuses one nano below (both edges exact)', () => {
    const threshold = smartModelMinimumRequiredNanoUsd(POOL, PROMPT, STORAGE)!;
    expect(admitSmartModel(POOL, threshold, PROMPT, STORAGE)).not.toBeNull();
    expect(admitSmartModel(POOL, threshold - 1n, PROMPT, STORAGE)).toBeNull();
  });

  it('never lets the server refuse a balance the client accepts, across a sweep', () => {
    const threshold = smartModelMinimumRequiredNanoUsd(POOL, PROMPT, STORAGE)!;
    const step = threshold / 7n || 1n;
    for (let balance = 0n; balance <= threshold * 3n; balance += step) {
      const clientAffordable = balance >= threshold;
      const serverAdmits = admitSmartModel(POOL, balance, PROMPT, STORAGE) !== null;
      expect(serverAdmits).toBe(clientAffordable);
    }
  });
});
