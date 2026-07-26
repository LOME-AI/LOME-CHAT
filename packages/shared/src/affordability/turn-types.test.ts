import { describe, expect, it } from 'vitest';

import {
  EMPTY_PROMPT_BASIS,
  promptCharsOf,
  refusalPrecedence,
  REFUSAL_CODES,
} from './turn-types.js';
import type { ModelEntry } from './turn-types.js';

describe('promptCharsOf', () => {
  it('derives the total from its four character components', () => {
    expect(
      promptCharsOf({
        systemChars: 500,
        instructionChars: 40,
        historyChars: 1200,
        inputChars: 60,
        attachmentBytes: 9000,
      })
    ).toBe(1800);
  });

  it('excludes attachment bytes, which are not characters', () => {
    const withAttachment = promptCharsOf({
      systemChars: 1,
      instructionChars: 2,
      historyChars: 3,
      inputChars: 4,
      attachmentBytes: 1_000_000,
    });
    expect(withAttachment).toBe(10);
  });
});

describe('EMPTY_PROMPT_BASIS', () => {
  it('is the zero-length prompt the affordable set is evaluated against', () => {
    expect(promptCharsOf(EMPTY_PROMPT_BASIS)).toBe(0);
    expect(EMPTY_PROMPT_BASIS.attachmentBytes).toBe(0);
  });
});

describe('REFUSAL_CODES', () => {
  it('is a closed set with no duplicate members', () => {
    expect(new Set(REFUSAL_CODES).size).toBe(REFUSAL_CODES.length);
  });

  it('covers the tier axis as well as the feasibility axis', () => {
    // A premium row and a trial-capped row are MARKED with a reason rather than
    // removed, so each condition needs a member here to carry one wording.
    expect(REFUSAL_CODES).toContain('premium_requires_account');
    expect(REFUSAL_CODES).toContain('premium_requires_credit');
    expect(REFUSAL_CODES).toContain('trial_message_cap_exceeded');
  });
});

describe('ModelEntry', () => {
  const CANDIDATE: ModelEntry = {
    kind: 'candidate',
    modelId: 'vendor/candidate',
    availability: { available: true },
    ceilingTokens: 8000,
    dimensions: [],
  };
  const PINNED: ModelEntry = {
    kind: 'pinned',
    modelId: 'vendor/pinned',
    availability: { available: false, reason: 'model_output_cap_too_low' },
    ceilingTokens: 9000,
  };

  it('reaches a per-option list only after narrowing to the decision-bearing kind', () => {
    const rungCount = (entry: ModelEntry): number =>
      entry.kind === 'candidate' ? entry.dimensions.length : -1;
    expect(rungCount(CANDIDATE)).toBe(0);
    expect(rungCount(PINNED)).toBe(-1);
  });

  it('does not publish a pinned row`s own-fit option verdicts to any consumer', () => {
    // The two-kinds-of-row rule is the type rather than a comment on it: a pinned
    // sibling's per-option own-fit diagnosis is deliberately finer than the turn's
    // verdict, so consuming it as a decision is a compile error rather than a
    // documented mistake. A control asking what the turn can run reads
    // `turnDimensions`; a pinned row carries the blocking reason and nothing else.
    // @ts-expect-error -- `dimensions` exists only on the candidate arm
    const rungs = PINNED.dimensions;
    expect(rungs).toBeUndefined();
    expect(PINNED.availability).toEqual({
      available: false,
      reason: 'model_output_cap_too_low',
    });
  });
});

describe('refusalPrecedence', () => {
  it('reports money rather than length when both bind', () => {
    expect(refusalPrecedence(['prompt_too_long', 'insufficient_funds'])).toBe('insufficient_funds');
  });

  it('reports length once the funding covers a minimum answer', () => {
    expect(refusalPrecedence(['option_not_offered', 'prompt_too_long'])).toBe('prompt_too_long');
  });

  it('is total: an empty reason list resolves to nothing being priceable', () => {
    expect(refusalPrecedence([])).toBe('model_not_priceable');
  });

  it('reports the tier lock ahead of money, because no balance unlocks the model', () => {
    expect(refusalPrecedence(['insufficient_funds', 'premium_requires_credit'])).toBe(
      'premium_requires_credit'
    );
  });
});
