/**
 * The two turn-level members of the public surface that resolve a classifier
 * call: what the classifier is shown (`renderOptions`) and what its answer
 * becomes (`chooseFrom`), plus the one constructor of provider parameters
 * (`wireFor`).
 *
 * Every fixture here goes through the real producer: an `OptionSet` may only be
 * constructed by `getTurnOptions` (§Data Structures), so a hand-built one would
 * be testing a shape the system never sees.
 */

import { describe, expect, it } from 'vitest';

import { buildClassifierSystemPrompt } from './smart-model/prompts.js';
import { chooseFrom, renderOptions, wireFor } from './classifier-choice.js';
import { modelId } from './model-id.js';
import { nanoUSD } from './nano-usd.js';
import { getTurnOptions } from './turn-options.js';
import type { PriceableModel } from './priceable-model.js';
import type { FundingSnapshot, OptionSet, PromptBasis, Selection } from './turn-types.js';

const NOW_MS = 1_800_000_000_000;

function modelOf(name: string, rate: bigint, efforts: readonly string[]): PriceableModel {
  return {
    modelId: modelId(`vendor/${name}`),
    inputRateNanoUsd: nanoUSD(rate),
    outputRateNanoUsd: nanoUSD(rate * 2n),
    contextLength: 200_000,
    providerCap: 64_000,
    reasoning: efforts.length === 0 ? undefined : { supportedEfforts: [...efforts] },
    releasedAtMs: 0,
  };
}

const CHEAP = modelOf('cheap', 100n, ['high', 'medium', 'low']);
const MID = modelOf('mid', 400n, ['high', 'medium', 'low']);
const DEAR = modelOf('dear', 900n, ['high', 'medium', 'low']);
const CATALOG = [CHEAP, MID, DEAR];

const BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 300,
  inputChars: 100,
  attachmentBytes: 0,
};

/** A smart slot with nothing pinned: both the model and effort axes are open. */
const SELECTION: Selection = {
  answerSources: { models: [], smartSlot: true },
  modality: 'text',
  pinned: {},
  webSearch: false,
};

function admissibleAt(spendable: bigint): OptionSet {
  const funding: FundingSnapshot = {
    spendableNanoUsd: nanoUSD(spendable),
    heldNanoUsd: nanoUSD(0n),
    payerTier: 'paid',
    payer: 'self',
  };
  return getTurnOptions(funding, BASIS, SELECTION, { models: CATALOG, nowMs: NOW_MS }).admissible;
}

const RICH = admissibleAt(10_000_000_000n);

describe('chooseFrom — the model axis', () => {
  it('resolves the candidate the answer names', () => {
    expect(chooseFrom(RICH, 'model: vendor/mid').modelId).toBe('vendor/mid');
  });

  it('resolves a candidate named without its provider prefix', () => {
    expect(chooseFrom(RICH, 'model: dear').modelId).toBe('vendor/dear');
  });

  it('falls back to the cheapest presented candidate when the answer names nothing known', () => {
    expect(chooseFrom(RICH, 'model: something-else-entirely').modelId).toBe('vendor/cheap');
  });

  it('is total: an empty answer still yields a runnable choice', () => {
    expect(chooseFrom(RICH, '').modelId).toBe('vendor/cheap');
  });
});

describe('chooseFrom — an open dimension', () => {
  it('resolves the option the answer names by its user-facing label', () => {
    expect(chooseFrom(RICH, 'model: vendor/mid\neffort: High').dimensions.effort).toBe('high');
  });

  it('falls back to the cheapest presented option when the answer names no level', () => {
    // Min — reasoning off — is the cheapest rung a model that can disable it
    // presents, and the declared fallback is the cheapest PRESENTED option.
    expect(chooseFrom(RICH, 'model: vendor/mid').dimensions.effort).toBe('off');
  });

  it('falls back to the cheapest presented option when the level is not on offer', () => {
    expect(chooseFrom(RICH, 'effort: Interstellar').dimensions.effort).toBe('off');
  });
});

describe('renderOptions', () => {
  it('names each open dimension with its options by label and its own answer line', () => {
    const section = renderOptions(RICH);
    expect(section).toContain('Low | Mid | High');
    expect(section).toContain('`effort: <choice>`');
  });

  it('lists each candidate with the ceiling it may run up to', () => {
    const section = renderOptions(RICH);
    expect(section).toContain('vendor/cheap — up to High');
    expect(section).toContain('vendor/dear — up to High');
  });

  it("presents the options the turn offers, never the dimension's declared domain", () => {
    // These models offer four rungs; the effort dimension DECLARES six. Prompting
    // the declared domain would let the classifier pick an option no candidate
    // presented — the one place the wrong set is a money defect (§Affordability).
    const section = renderOptions(RICH);
    expect(section).not.toContain('Lite');
    expect(section).not.toContain('Max');
    // The template renderer still lists the declared domain for a caller that
    // hands it no produced set; the two agree on FORMAT because both render
    // through `renderDimensionSection`, and this is the input difference the
    // classifier's own wiring closes.
    expect(buildClassifierSystemPrompt({ classifyEffort: true })).toContain('Lite | Low');
  });

  it('carries no catalog free text — identifiers and labels only', () => {
    expect(renderOptions(RICH)).not.toContain('description');
  });
});

describe('wireFor', () => {
  it('constructs the provider fragment for the chosen options', () => {
    const chosen = chooseFrom(RICH, 'model: vendor/mid\neffort: High');
    expect(wireFor(chosen, MID)).toEqual({
      model: 'vendor/mid',
      reasoning: { effort: 'high' },
    });
  });

  it('constructs no fragment for a model that offers the axis nothing', () => {
    // A model with no reasoning metadata offers the effort axis nothing, and it
    // is not the model the choice named, so neither fragment applies.
    const plain = modelOf('plain', 100n, []);
    const chosen = chooseFrom(RICH, 'model: vendor/mid\neffort: High');
    expect(wireFor(chosen, plain)).toEqual({});
  });
});

describe('a pinned turn', () => {
  // A selection with no smart slot still produces candidate ROWS: they are the
  // picker's "could I run this beside what I have selected" rows (§Affordability
  // notion 1), not a classifier pool. The produced set does not distinguish the
  // two populations, so a model-axis resolution here answers against the rows
  // that are there; a turn that opens no model axis never consumes the answer.
  const PINNED: Selection = {
    answerSources: { models: [modelId('vendor/mid')], smartSlot: false },
    modality: 'text',
    pinned: {},
    webSearch: false,
  };
  const pinnedOptions = getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(10_000_000_000n),
      heldNanoUsd: nanoUSD(0n),
      payerTier: 'paid',
      payer: 'self',
    },
    BASIS,
    PINNED,
    { models: CATALOG, nowMs: NOW_MS }
  ).admissible;

  it('never resolves the model axis to the sibling the user pinned', () => {
    // The pinned sibling is not a candidate row, so it is not selectable — which
    // is the property that keeps a resolution from "choosing" a fixed choice.
    expect(chooseFrom(pinnedOptions, 'model: vendor/mid').modelId).not.toBe('vendor/mid');
  });

  it('still resolves the open dimensions it does present', () => {
    expect(chooseFrom(pinnedOptions, 'effort: High').dimensions.effort).toBe('high');
  });
});

describe('a candidate with no rungs to annotate', () => {
  const plainOnly = getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(10_000_000_000n),
      heldNanoUsd: nanoUSD(0n),
      payerTier: 'paid',
      payer: 'self',
    },
    BASIS,
    SELECTION,
    { models: [modelOf('plain', 100n, [])], nowMs: NOW_MS }
  ).admissible;

  it('lists the candidate with no ceiling clause', () => {
    expect(renderOptions(plainOnly)).toContain('- vendor/plain');
    expect(renderOptions(plainOnly)).not.toContain('vendor/plain — up to');
  });

  it('wires the chosen model with no dimension fragment', () => {
    const chosen = chooseFrom(plainOnly, '');
    expect(wireFor(chosen, modelOf('plain', 100n, []))).toEqual({ model: 'vendor/plain' });
  });
});

describe('a turn whose funding presents no option on an axis', () => {
  // Funding that cannot fund a minimum answer: the rows still render — greying
  // what a payer cannot afford is the point — and no rung on the axis is
  // available, so there is nothing for the classifier to pick.
  const broke = getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(1000n),
      heldNanoUsd: nanoUSD(0n),
      payerTier: 'paid',
      payer: 'self',
    },
    BASIS,
    SELECTION,
    { models: CATALOG, nowMs: NOW_MS }
  ).admissible;

  it('resolves the axis to nothing rather than to an option it never presented', () => {
    expect(broke.sendable).toBe(false);
    expect(chooseFrom(broke, 'effort: High').dimensions.effort).toBeUndefined();
  });

  it('chooses no model, because no candidate was presented', () => {
    expect(chooseFrom(broke, 'model: vendor/cheap').modelId).toBeUndefined();
  });

  it('renders no candidate list, because none was presented', () => {
    expect(renderOptions(broke)).not.toContain('Available models');
  });
});
