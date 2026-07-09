import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  MAX_CLASSIFIER_CONTEXT_CHARS,
  computeClassifierPromptOverhead,
  nanoUSD,
} from '@hushbox/shared';
import { applyMarkup } from '../../billing/index.js';
import { callBaseNanoUsd } from './estimate.js';
import { CLASSIFIER_CHARS_PER_TOKEN } from './smart-model-candidates.js';
import { TRIAL_MESSAGE_COST_CAP_NANO_USD } from './trial-eligibility.js';
import { buildTrialSmartModelCandidates } from './trial-smart-model-candidates.js';
import type { Modality, ModelDescriptor, Pricing } from '@hushbox/shared';

/** A release timestamp (unix SECONDS) far outside the premium-recency window. */
const OLD_RELEASE_SECONDS = 1_600_000_000;

/** A fixed reference clock (ms) well past the old releases. */
const NOW_MS = 1_760_000_000_000;

function descriptorOf(params: {
  readonly id: string;
  readonly inputRate: bigint;
  readonly outputRate: bigint;
  readonly releasedAt?: number;
  readonly outputs?: readonly Modality[];
  readonly inputs?: readonly Modality[];
  readonly description?: string;
  readonly pricing?: Pricing;
}): ModelDescriptor {
  const pricing: Pricing = params.pricing ?? {
    inputPerToken: nanoUSD(params.inputRate),
    outputPerToken: nanoUSD(params.outputRate),
  };
  return {
    id: params.id,
    provider: 'openrouter',
    version: '1',
    inputs: [...(params.inputs ?? ['text'])],
    outputs: [...(params.outputs ?? ['text'])],
    parameters: {},
    behaviors: ['streaming'],
    limits: { contextLength: 1000 },
    pricing,
    zdrReachable: true,
    releasedAt: params.releasedAt ?? OLD_RELEASE_SECONDS,
    fetchedAt: 0,
    ...(params.description === undefined ? {} : { description: params.description }),
  };
}

const CHEAP = descriptorOf({
  id: 'cheap/model',
  inputRate: 1n,
  outputRate: 2n,
  description: 'cheap and fast',
});
const MID = descriptorOf({ id: 'mid/model', inputRate: 10n, outputRate: 20n });
// Top price quartile of the text catalog — premium by percentile.
const DEAR = descriptorOf({ id: 'dear/model', inputRate: 1000n, outputRate: 2000n });
// Cheap but released "now" — premium by recency.
const RECENT = descriptorOf({
  id: 'recent/model',
  inputRate: 1n,
  outputRate: 2n,
  releasedAt: Math.floor(NOW_MS / 1000),
});
const IMAGE = descriptorOf({
  id: 'img/model',
  inputRate: 1n,
  outputRate: 1n,
  outputs: ['image'],
  pricing: { perImage: nanoUSD(40n) },
});
const VISION_INPUT = descriptorOf({
  id: 'vision/model',
  inputRate: 1n,
  outputRate: 1n,
  inputs: ['text', 'image'],
});

/** Expensive text decoys that push the price percentile up without ever
 * qualifying themselves, so a lone cheap fixture stays below the quartile. */
function dearDecoys(): ModelDescriptor[] {
  return [1, 2, 3].map((index) =>
    descriptorOf({
      id: `decoy-${String(index)}/model`,
      inputRate: 1_000_000n,
      outputRate: 1_000_000n,
    })
  );
}

/** The classifier worst-case BASE reserve the builder computes (no markup). */
function classifierReserveBase(
  classifier: ModelDescriptor,
  eligibleSorted: readonly ModelDescriptor[]
): bigint {
  const overheadChars = computeClassifierPromptOverhead(
    eligibleSorted.map((descriptor) => ({
      id: descriptor.id,
      description: descriptor.description ?? '',
    }))
  );
  const inputTokens = Math.ceil(
    (MAX_CLASSIFIER_CONTEXT_CHARS + overheadChars) / CLASSIFIER_CHARS_PER_TOKEN
  );
  return callBaseNanoUsd(classifier.pricing, {
    kind: 'tokens',
    inputTokens,
    outputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP,
  })._unsafeUnwrap();
}

describe('buildTrialSmartModelCandidates', () => {
  it('keeps trial-eligible text models ascending by price with the cheapest as classifier', () => {
    // The decoys spread the price percentile AND are themselves premium on the
    // minimal-exchange leg, so exactly cheap + mid survive the gate.
    const result = buildTrialSmartModelCandidates({
      descriptors: [MID, CHEAP, RECENT, IMAGE, VISION_INPUT, ...dearDecoys()],
      nowMs: NOW_MS,
      prompt: 'hi',
      history: [],
    });
    expect(result?.classifierModelId).toBe('cheap/model');
    expect(result?.candidates.map((candidate) => candidate.id)).toEqual([
      'cheap/model',
      'mid/model',
    ]);
  });

  it('excludes a top-price-quartile model as premium', () => {
    // Without the decoy spread, DEAR tops the four-model text distribution.
    const result = buildTrialSmartModelCandidates({
      descriptors: [
        DEAR,
        MID,
        CHEAP,
        descriptorOf({ id: 'low/model', inputRate: 1n, outputRate: 1n }),
      ],
      nowMs: NOW_MS,
      prompt: 'hi',
      history: [],
    });
    expect(result?.candidates.map((candidate) => candidate.id)).not.toContain('dear/model');
  });

  it('carries descriptions through and omits them where the catalog has none', () => {
    const result = buildTrialSmartModelCandidates({
      descriptors: [CHEAP, MID, ...dearDecoys()],
      nowMs: NOW_MS,
      prompt: 'hi',
      history: [],
    });
    expect(result?.candidates[0]).toEqual({ id: 'cheap/model', description: 'cheap and fast' });
    expect(result?.candidates[1]).toEqual({ id: 'mid/model' });
  });

  it('excludes a candidate whose per-message base cannot be priced (missing rates)', () => {
    // Priced above the classifier pick so its missing output rate hits the
    // per-candidate message pricing, not the classifier reserve.
    const partial = descriptorOf({
      id: 'partial/model',
      inputRate: 1n,
      outputRate: 1n,
      pricing: { inputPerToken: nanoUSD(50n) },
    });
    const result = buildTrialSmartModelCandidates({
      descriptors: [CHEAP, partial, ...dearDecoys()],
      nowMs: NOW_MS,
      prompt: 'hi',
      history: [],
    });
    expect(result?.candidates.map((candidate) => candidate.id)).toEqual(['cheap/model']);
  });

  it('keeps a candidate at exactly reserve + message base == the 1¢ cap and drops it one token over', () => {
    const decoys = dearDecoys();
    const reserve = classifierReserveBase(CHEAP, [CHEAP]);
    const outputLegNanoUsd = 4000n; // 2000 minimum output tokens × 2n output rate
    // Solve for the prompt length whose input leg lands the total exactly on
    // the cap: input tokens = prompt chars / 2 at a 1n input rate.
    const exactInputTokens = TRIAL_MESSAGE_COST_CAP_NANO_USD - reserve - outputLegNanoUsd;
    const exactPrompt = 'x'.repeat(Number(exactInputTokens) * 2);

    const kept = buildTrialSmartModelCandidates({
      descriptors: [CHEAP, ...decoys],
      nowMs: NOW_MS,
      prompt: exactPrompt,
      history: [],
    });
    expect(kept?.candidates.map((candidate) => candidate.id)).toEqual(['cheap/model']);

    const dropped = buildTrialSmartModelCandidates({
      descriptors: [CHEAP, ...decoys],
      nowMs: NOW_MS,
      prompt: `${exactPrompt}xx`,
      history: [],
    });
    expect(dropped).toBeNull();
  });

  it('prices the full resent history into each candidate’s message base', () => {
    const decoys = dearDecoys();
    const reserve = classifierReserveBase(CHEAP, [CHEAP]);
    const exactInputTokens = TRIAL_MESSAGE_COST_CAP_NANO_USD - reserve - 4000n;
    // The same exact-boundary send, split across history and the prompt: still
    // kept at the cap, dropped once the history adds one more token.
    const half = Number(exactInputTokens); // chars: half the 2-chars-per-token budget
    const kept = buildTrialSmartModelCandidates({
      descriptors: [CHEAP, ...decoys],
      nowMs: NOW_MS,
      prompt: 'x'.repeat(half),
      history: [{ role: 'user', content: 'x'.repeat(half) }],
    });
    expect(kept?.candidates.map((candidate) => candidate.id)).toEqual(['cheap/model']);

    const dropped = buildTrialSmartModelCandidates({
      descriptors: [CHEAP, ...decoys],
      nowMs: NOW_MS,
      prompt: 'x'.repeat(half),
      history: [{ role: 'user', content: 'x'.repeat(half + 2) }],
    });
    expect(dropped).toBeNull();
  });

  it('returns null when the classifier reserve alone meets the cap, even with a free answer leg', () => {
    // Old, below-percentile (the decoys spread the distribution), and its
    // minimal exchange passes the eligibility leg — but the classifier reserve
    // at its rates already swallows the whole per-message ceiling.
    const steep = descriptorOf({ id: 'steep/model', inputRate: 6000n, outputRate: 0n });
    const result = buildTrialSmartModelCandidates({
      descriptors: [steep, ...dearDecoys()],
      nowMs: NOW_MS,
      prompt: 'hi',
      history: [],
    });
    expect(result).toBeNull();
  });

  it('returns null when no text model is trial-eligible', () => {
    const result = buildTrialSmartModelCandidates({
      descriptors: [RECENT, IMAGE],
      nowMs: NOW_MS,
      prompt: 'hi',
      history: [],
    });
    expect(result).toBeNull();
  });

  it('returns null for an empty catalog', () => {
    expect(
      buildTrialSmartModelCandidates({ descriptors: [], nowMs: NOW_MS, prompt: 'hi', history: [] })
    ).toBeNull();
  });

  it('excludes an unpriceable model at the gate instead of poisoning the whole list', () => {
    // A model with no per-token rates cannot be priced for trial, so the
    // eligibility gate refuses it (fail-closed = drop the model, never the
    // classifier pick); the priceable MID drives the list, which still builds.
    const rateless = descriptorOf({ id: 'free/model', inputRate: 1n, outputRate: 1n, pricing: {} });
    const result = buildTrialSmartModelCandidates({
      descriptors: [rateless, MID, ...dearDecoys()],
      nowMs: NOW_MS,
      prompt: 'hi',
      history: [],
    });
    expect(result?.classifierModelId).toBe('mid/model');
    expect(result?.candidates.map((candidate) => candidate.id)).not.toContain('free/model');
  });

  it('supports a single-eligible list (the run then short-circuits the classifier)', () => {
    const result = buildTrialSmartModelCandidates({
      descriptors: [CHEAP, ...dearDecoys()],
      nowMs: NOW_MS,
      prompt: 'hi',
      history: [],
    });
    expect(result?.classifierModelId).toBe('cheap/model');
    expect(result?.candidates).toHaveLength(1);
  });

  it('exposes the BASE classifier reserve it filtered against (never marked up)', () => {
    const result = buildTrialSmartModelCandidates({
      descriptors: [CHEAP, MID, ...dearDecoys()],
      nowMs: NOW_MS,
      prompt: 'hi',
      history: [],
    });
    const expected = classifierReserveBase(CHEAP, [CHEAP, MID]);
    expect(result?.classifierWorstCaseBaseNanoUsd).toBe(expected);
    expect(result?.classifierWorstCaseBaseNanoUsd).not.toBe(applyMarkup(expected));
  });
});
