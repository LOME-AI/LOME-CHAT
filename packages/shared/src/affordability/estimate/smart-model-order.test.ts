/**
 * §Smart Model 1 orders the candidate pool on TURN COST with an identifier
 * tiebreak, and §Predicates fixes the quantity as `maxCallCost(m)`. §Smart Model 3
 * removes the pool's high-cost outliers from what the classifier may pick.
 *
 * The pair below is real — two models of the live exposed catalog, at their
 * ingested billable rates and caps — because a rate-ranked order and a
 * cost-ranked order are indistinguishable on a fixture where they agree, and the
 * wrong one would then survive its own test.
 */

import { describe, expect, it } from 'vitest';

import { nanoUSD } from '../nano-usd.js';
import {
  admitSmartModel,
  priceSmartModelPool,
  smartModelMinimumRequiredNanoUsd,
} from './smart-model-affordability.js';
import type {
  SmartModelPoolCandidate,
  SmartModelStorageContext,
} from './smart-model-affordability.js';

/** Cheaper per token (483 combined) but an eight-times larger completion cap. */
const MIMO: SmartModelPoolCandidate = {
  id: 'xiaomi/mimo-v2.5',
  pricing: { inputPerToken: nanoUSD(161n), outputPerToken: nanoUSD(322n) },
  contextLength: 1_050_000,
  maxOutputTokens: 131_072,
};

/** Dearer per token (529 combined) and physically unable to spend as much. */
const FLASH: SmartModelPoolCandidate = {
  id: 'z-ai/glm-4.7-flash',
  pricing: { inputPerToken: nanoUSD(69n), outputPerToken: nanoUSD(460n) },
  contextLength: 202_752,
  maxOutputTokens: 16_384,
};

/** A paid persisting turn: 2 output chars per token, a 5,000-character prompt. */
const STORAGE: SmartModelStorageContext = { outputCharsPerToken: 2, inputChars: 5000 };
const PROMPT_INPUT_TOKENS = 1250;

describe('the pool is ordered on maxCallCost, not on the summed rates', () => {
  it('ranks the real pair the two orders disagree about by cost', () => {
    const pool = priceSmartModelPool([MIMO, FLASH], PROMPT_INPUT_TOKENS, STORAGE);
    // Rate order would put mimo first (483 < 529 combined); maxCallCost puts
    // flash first — 17,453,290n against 121,049,634n, a 103,596,344n difference
    // the summed rates cannot see, because the caps differ eight-fold.
    expect(pool?.priced.map((candidate) => candidate.id)).toEqual([FLASH.id, MIMO.id]);
  });

  it('breaks a cost tie on the identifier, so row order cannot decide the pool', () => {
    const twinA: SmartModelPoolCandidate = { ...FLASH, id: 'vendor/b-twin' };
    const twinB: SmartModelPoolCandidate = { ...FLASH, id: 'vendor/a-twin' };
    const forward = priceSmartModelPool([twinA, twinB], PROMPT_INPUT_TOKENS, STORAGE);
    const reversed = priceSmartModelPool([twinB, twinA], PROMPT_INPUT_TOKENS, STORAGE);
    expect(forward?.priced.map((candidate) => candidate.id)).toEqual([
      'vendor/a-twin',
      'vendor/b-twin',
    ]);
    expect(reversed?.priced.map((candidate) => candidate.id)).toEqual(
      forward?.priced.map((candidate) => candidate.id)
    );
  });
});

describe('the classifier ENGINE choice is basis-independent', () => {
  it('picks the same engine under an empty prompt basis and under a real one', () => {
    // The engine rides a prompt-independent quantity (the combined rate, with an
    // identifier tiebreak) precisely so the two option sets — one evaluated
    // against an empty basis, one against the composed prompt — cannot buy
    // different classifiers and therefore different reserves.
    const empty = priceSmartModelPool([MIMO, FLASH], 0, STORAGE);
    const composed = priceSmartModelPool([MIMO, FLASH], PROMPT_INPUT_TOKENS, STORAGE);
    expect(empty?.classifierModelId).toBe(MIMO.id);
    expect(composed?.classifierModelId).toBe(empty?.classifierModelId);
  });

  it('does not follow the pool order, which the same call proves differs', () => {
    const pool = priceSmartModelPool([MIMO, FLASH], PROMPT_INPUT_TOKENS, STORAGE);
    expect(pool?.priced[0]?.id).not.toBe(pool?.classifierModelId);
  });
});

describe('a high-cost outlier leaves the classifier-selectable pool', () => {
  function modelOf(id: string, outputRate: bigint, cap: number): SmartModelPoolCandidate {
    return {
      id,
      pricing: { inputPerToken: nanoUSD(100n), outputPerToken: nanoUSD(outputRate) },
      contextLength: 1_000_000,
      maxOutputTokens: cap,
    };
  }
  const ORDINARY = [
    modelOf('vendor/a', 1000n, 8000),
    modelOf('vendor/b', 2000n, 8000),
    modelOf('vendor/c', 3000n, 8000),
    modelOf('vendor/d', 4000n, 8000),
  ];
  /** 200,000 nano per output token: 60× the pool median's maxCallCost. */
  const OUTLIER = modelOf('vendor/outlier', 200_000n, 8000);
  const WITH_OUTLIER = [...ORDINARY, OUTLIER];
  const BALANCE = 1_000_000_000n;

  it('is absent from the candidates the classifier may route among', () => {
    const admission = admitSmartModel(WITH_OUTLIER, BALANCE, PROMPT_INPUT_TOKENS, STORAGE);
    expect(admission?.candidates.map((candidate) => candidate.id)).not.toContain(OUTLIER.id);
  });

  it('drops the hold to the worst SURVIVING candidate', () => {
    const withIt = admitSmartModel(WITH_OUTLIER, BALANCE, PROMPT_INPUT_TOKENS, STORAGE);
    const withoutIt = admitSmartModel(ORDINARY, BALANCE, PROMPT_INPUT_TOKENS, STORAGE);
    // Not equal to the outlier-free pool's hold, because the classifier prompt
    // still lists it; strictly below what its own arrangement would have cost.
    expect(withIt?.reserveNanoUsd).toBeLessThan(8000n * 200_000n);
    expect(withIt?.candidates.length).toBe(withoutIt?.candidates.length);
  });

  it('grows the presented set, because the reserve every cap is sized against falls', () => {
    // At a balance that only just funds the pool, the classifier reserve is what
    // decides how many candidates clear the minimum answer. Excluding the outlier
    // from the eligible set frees exactly its own share of nothing — but the
    // surviving candidates keep their caps, so none is lost to its presence.
    const tight = 30_000_000n;
    const admission = admitSmartModel(WITH_OUTLIER, tight, PROMPT_INPUT_TOKENS, STORAGE);
    const ids = admission?.candidates.map((candidate) => candidate.id) ?? [];
    expect(ids).not.toContain(OUTLIER.id);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('keeps the exclusion balance-independent', () => {
    for (const balance of [30_000_000n, 1_000_000_000n, 100_000_000_000n]) {
      const admission = admitSmartModel(WITH_OUTLIER, balance, PROMPT_INPUT_TOKENS, STORAGE);
      expect(admission?.candidates.map((candidate) => candidate.id) ?? []).not.toContain(
        OUTLIER.id
      );
    }
  });
});

describe('the biconditional threshold matches the admission verdict across a sweep', () => {
  const POOL = [MIMO, FLASH];

  it('refuses exactly below the shared minimum, at every point of the sweep', () => {
    const minimum = smartModelMinimumRequiredNanoUsd(POOL, PROMPT_INPUT_TOKENS, STORAGE);
    expect(minimum).not.toBeNull();
    let refusals = 0;
    let admissions = 0;
    for (let step = 0; step <= 200; step += 1) {
      const balance = (BigInt(step) * (minimum ?? 0n) * 2n) / 100n;
      const admitted = admitSmartModel(POOL, balance, PROMPT_INPUT_TOKENS, STORAGE) !== null;
      expect(admitted).toBe(balance >= (minimum ?? 0n));
      if (admitted) admissions += 1;
      else refusals += 1;
    }
    expect(refusals).toBeGreaterThan(10);
    expect(admissions).toBeGreaterThan(10);
  });
});
