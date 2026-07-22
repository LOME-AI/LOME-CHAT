import { describe, expect, it } from 'vitest';

import {
  CANONICAL_REASONING_EFFORTS,
  CanonicalReasoningEffort,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_SELECTIONS,
  ReasoningEffortSelection,
} from './reasoning-effort.js';

describe('CANONICAL_REASONING_EFFORTS', () => {
  it('is exactly min, low, medium, high, max in ascending ladder order', () => {
    expect(CANONICAL_REASONING_EFFORTS).toEqual(['min', 'low', 'medium', 'high', 'max']);
  });

  it('parses every canonical level through the Zod enum', () => {
    for (const level of CANONICAL_REASONING_EFFORTS) {
      expect(CanonicalReasoningEffort.parse(level)).toBe(level);
    }
  });

  it('rejects native upstream levels and non-levels', () => {
    for (const level of ['xhigh', 'minimal', 'none', 'auto', '']) {
      expect(CanonicalReasoningEffort.safeParse(level).success).toBe(false);
    }
  });
});

describe('REASONING_EFFORT_SELECTIONS', () => {
  it('is auto, the canonical ladder, then none', () => {
    expect(REASONING_EFFORT_SELECTIONS).toEqual([
      'auto',
      'min',
      'low',
      'medium',
      'high',
      'max',
      'none',
    ]);
  });

  it('parses through the Zod enum', () => {
    for (const selection of REASONING_EFFORT_SELECTIONS) {
      expect(ReasoningEffortSelection.parse(selection)).toBe(selection);
    }
  });

  it('rejects values outside the set', () => {
    for (const value of ['xhigh', 'minimal', 'off', 'Auto', '']) {
      expect(ReasoningEffortSelection.safeParse(value).success).toBe(false);
    }
  });
});

describe('REASONING_EFFORT_LABELS', () => {
  it('labels every selection with a non-empty display string', () => {
    for (const selection of REASONING_EFFORT_SELECTIONS) {
      const label = REASONING_EFFORT_LABELS[selection];
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('labels the off selection as None (founder-ruled copy)', () => {
    expect(REASONING_EFFORT_LABELS.none).toBe('None');
  });

  it('labels the ladder ends as Min and Max', () => {
    expect(REASONING_EFFORT_LABELS.min).toBe('Min');
    expect(REASONING_EFFORT_LABELS.max).toBe('Max');
  });
});
