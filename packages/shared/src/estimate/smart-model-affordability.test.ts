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
  it('prices the classifier reserve into a provider and a storage line item', () => {
    const items = classifierReserveLineItems(CHEAP, [{ id: 'cheap' }], 4);
    expect(items?.map((item) => item.marksUp)).toEqual([true, false]);
  });

  it('returns undefined when the classifier lacks a per-token rate', () => {
    const rateless: { readonly pricing: Pricing } = { pricing: {} };
    expect(classifierReserveLineItems(rateless, [{ id: 'x' }], 4)).toBeUndefined();
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
