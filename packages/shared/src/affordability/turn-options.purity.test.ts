/**
 * The producer is pure — no clock, no I/O, no randomness — and content-free.
 * Asserted structurally over the source, not by comment: a comment claiming
 * purity is exactly what a later edit slips past.
 *
 * The behavioural half is asserted too, because a structural scan cannot see a
 * reach through a helper: identical inputs produce deep-equal output, and no
 * input object is mutated.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { modelId } from './model-id.js';
import { nanoUSD } from './nano-usd.js';
import { getTurnOptions } from './turn-options.js';
import type { PriceableModel } from './priceable-model.js';
import type { FundingSnapshot, PromptBasis, Selection } from './turn-types.js';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = 1_800_000_000_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The units the producer is composed of. Adding one belongs on this list. */
const PRODUCER_SOURCES = [
  'turn-types.ts',
  'turn-arithmetic.ts',
  'turn-core.ts',
  'turn-options.ts',
] as const;

/**
 * Every way impurity reaches a pure module: a clock, a random source, a network
 * or filesystem call, or the ambient environment.
 */
const IMPURE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['a clock', /\bDate\b|performance\s*\.\s*now/],
  ['randomness', /Math\s*\.\s*random|crypto\s*\.\s*(?:random|getRandomValues)/],
  ['network or filesystem I/O', /\bfetch\s*\(|XMLHttpRequest|WebSocket|readFileSync|writeFileSync/],
  ['the ambient environment', /\bprocess\s*\.\s*env\b|import\s+[^;]*from\s+'node:/],
];

/**
 * Content shapes the money layer must never accept (§Where the Code Lives: no
 * export accepts a prompt, a message, or a history array).
 */
const CONTENT_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['a message or history array', /\b(?:messages|history)\s*[?]?\s*:\s*readonly/],
  ['prompt text', /\b(?:prompt|text|content)\s*[?]?\s*:\s*string/],
];

function sourceOf(file: string): string {
  return readFileSync(path.join(HERE, file), 'utf8');
}

describe('structural purity', () => {
  for (const file of PRODUCER_SOURCES) {
    for (const [what, pattern] of IMPURE_PATTERNS) {
      it(`${file} reaches for ${what} nowhere`, () => {
        expect(sourceOf(file)).not.toMatch(pattern);
      });
    }
  }
});

describe('the module is content-free', () => {
  for (const file of PRODUCER_SOURCES) {
    for (const [what, pattern] of CONTENT_PATTERNS) {
      it(`${file} declares no field carrying ${what}`, () => {
        expect(sourceOf(file)).not.toMatch(pattern);
      });
    }
  }
});

describe('the scan can fail', () => {
  it('matches its own patterns against a source that does reach for them', () => {
    const impure = 'const now = Date.now(); const r = Math.random();';
    expect(IMPURE_PATTERNS.filter(([, pattern]) => pattern.test(impure))).toHaveLength(2);
    expect(CONTENT_PATTERNS.some(([, pattern]) => pattern.test('readonly prompt: string;'))).toBe(
      true
    );
  });
});

const MODEL: PriceableModel = {
  modelId: modelId('vendor/model'),
  inputRateNanoUsd: nanoUSD(500n),
  outputRateNanoUsd: nanoUSD(1500n),
  contextLength: 120_000,
  providerCap: 16_000,
  releasedAtMs: 0,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

const FUNDING: FundingSnapshot = {
  spendableNanoUsd: nanoUSD(90_000_000n),
  heldNanoUsd: nanoUSD(10_000_000n),
  payerTier: 'paid',
  payer: 'self',
};

const BASIS: PromptBasis = {
  systemChars: 500,
  instructionChars: 60,
  historyChars: 4400,
  inputChars: 40,
  attachmentBytes: 0,
};

const SELECTION: Selection = {
  answerSources: { models: [modelId('vendor/model')], smartSlot: true },
  modality: 'text',
  pinned: {},
  webSearch: true,
};

describe('behavioural purity', () => {
  it('returns deep-equal output for identical input', () => {
    const first = getTurnOptions(FUNDING, BASIS, SELECTION, { models: [MODEL], nowMs: NOW_MS });
    const second = getTurnOptions(FUNDING, BASIS, SELECTION, { models: [MODEL], nowMs: NOW_MS });
    expect(second).toEqual(first);
  });

  it('mutates none of its inputs', () => {
    const funding = structuredClone(FUNDING);
    const basis = structuredClone(BASIS);
    const selection = structuredClone(SELECTION);
    const catalog = [structuredClone(MODEL)];
    getTurnOptions(funding, basis, selection, { models: catalog, nowMs: NOW_MS });
    expect(funding).toEqual(FUNDING);
    expect(basis).toEqual(BASIS);
    expect(selection).toEqual(SELECTION);
    expect(catalog).toEqual([MODEL]);
  });
});
