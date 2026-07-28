import { describe, expect, it } from 'vitest';
import { serializeReasoningText } from '@hushbox/shared';
import { cheapestClassifierEffort } from '@hushbox/shared/affordability/smart-model/effort-dimension';
import { TURN_DECISION_SCHEMA_NAME, TurnDecision, decideTurn } from './turn-decision.js';

describe('decideTurn', () => {
  it('applies the declared effort fallback when no classifier answered', () => {
    // §Reasoning Effort 8's rule, not a rung named twice: the fallback IS the
    // axis's cheapest option. The second assertion is what discriminates — a
    // mid-rung fallback (the constant this collapsed) would satisfy the first
    // only if the axis reordered, and would fail this one outright.
    expect(decideTurn('write me a poem').effort).toBe(cheapestClassifierEffort());
    expect(decideTurn('write me a poem').effort).not.toBe('medium');
  });

  it('carries the prompt through to every consumer', () => {
    expect(decideTurn('write me a poem').prompt).toBe('write me a poem');
  });

  it('resolves the effort dimension from its labelled line', () => {
    expect(decideTurn('p', 'model: openai/gpt-x\neffort: High').effort).toBe('high');
  });

  it('carries the model dimension line verbatim for the node holding the candidates', () => {
    expect(decideTurn('p', 'model: openai/gpt-x\neffort: High').modelText).toBe('openai/gpt-x');
  });

  it('reads only labelled lines, so an added dimension cannot shift another', () => {
    const decision = decideTurn('p', 'search: yes\neffort: Low\nmodel: openai/gpt-x');
    expect(decision.effort).toBe('low');
    expect(decision.modelText).toBe('openai/gpt-x');
  });

  it('falls back to the cheapest option when the answer names a level outside the ladder', () => {
    expect(decideTurn('p', 'effort: turbo-max-overdrive').effort).toBe(cheapestClassifierEffort());
  });

  it('leaves the model text empty when the answer names no model', () => {
    expect(decideTurn('p', 'effort: Max').modelText).toBe('');
  });

  it('parses the answer out of a reasoning-capable classifier value', () => {
    const value = serializeReasoningText('weighing options', 'effort: Lite');
    expect(decideTurn('p', value).effort).toBe('lite');
  });
});

describe('TurnDecision', () => {
  it('names the registered schema', () => {
    expect(TURN_DECISION_SCHEMA_NAME).toBe('turnDecision');
    expect(TurnDecision.safeParse({ prompt: '', modelText: '', effort: 'medium' }).success).toBe(
      true
    );
  });

  it('rejects an effort outside the closed ladder', () => {
    expect(TurnDecision.safeParse({ prompt: '', modelText: '', effort: 'turbo' }).success).toBe(
      false
    );
  });
});
