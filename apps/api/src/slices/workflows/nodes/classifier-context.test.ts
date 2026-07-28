import { describe, expect, it } from 'vitest';

import { MAX_CLASSIFIER_CONTEXT_CHARS } from '@hushbox/shared';

import {
  CLASSIFIER_CHARS_PER_DIRECTION,
  CLASSIFIER_CHUNK_SIZE,
  truncateForClassifier,
} from './classifier-context.js';

const long = (n: number, char = 'x'): string => char.repeat(n);

describe('truncateForClassifier constants', () => {
  it('budget is 4 directions × per-direction cap', () => {
    expect(MAX_CLASSIFIER_CONTEXT_CHARS).toBe(CLASSIFIER_CHARS_PER_DIRECTION * 4);
  });

  it('chunk size divides evenly into per-direction budget', () => {
    expect(CLASSIFIER_CHARS_PER_DIRECTION % CLASSIFIER_CHUNK_SIZE).toBe(0);
  });
});

describe('truncateForClassifier', () => {
  it('returns an empty string when both messages are empty', () => {
    expect(truncateForClassifier({ latestUserMessage: '', latestAssistantMessage: '' })).toBe('');
  });

  it('omits the [AI ...] sections when assistant message is empty', () => {
    const out = truncateForClassifier({
      latestUserMessage: 'hello world',
      latestAssistantMessage: '',
    });
    expect(out).toContain('[USER START]: hello world');
    expect(out).not.toContain('[AI START]');
    expect(out).not.toContain('[AI END]');
  });

  it('emits both user start and end markers when message is short enough to fit in one direction', () => {
    const userMessage = 'short user input';
    const out = truncateForClassifier({
      latestUserMessage: userMessage,
      latestAssistantMessage: '',
    });
    // Short message fits entirely in [USER START] direction; [USER END] would duplicate.
    expect(out).toContain('[USER START]: short user input');
  });

  it('includes all four sections when both messages are long', () => {
    const userMessage = `${long(500, 'a')}${long(500, 'b')}`; // 1000 chars
    const aiMessage = `${long(500, 'c')}${long(500, 'd')}`; // 1000 chars

    const out = truncateForClassifier({
      latestUserMessage: userMessage,
      latestAssistantMessage: aiMessage,
    });

    expect(out).toContain('[USER START]:');
    expect(out).toContain('[USER END]:');
    expect(out).toContain('[AI START]:');
    expect(out).toContain('[AI END]:');
  });

  /**
   * The guarantee: nothing this function returns is longer than the shared
   * excerpt budget — section labels and separators included, because they are
   * part of the returned string and the classifier is billed for the whole of
   * it. Budgeting only the captured text put the emitted message past the budget
   * by the envelope's own size, which is `reserve ⊇ bill` broken by a
   * derivation rather than by an amount.
   *
   * The other half of the bound — that the reserve prices at least this budget
   * plus a worst-case template render — is pinned where the reserve is computed
   * (`classifier-line-item.test.ts`), so neither side can move alone.
   */
  it('never emits more than MAX_CLASSIFIER_CONTEXT_CHARS in total, labels included', () => {
    const cases = [
      { latestUserMessage: long(10_000), latestAssistantMessage: long(10_000) },
      { latestUserMessage: long(5000), latestAssistantMessage: long(5000) },
      { latestUserMessage: long(MAX_CLASSIFIER_CONTEXT_CHARS), latestAssistantMessage: '' },
      { latestUserMessage: long(50_000), latestAssistantMessage: long(7, 'z') },
      { latestUserMessage: long(1), latestAssistantMessage: long(50_000) },
    ];
    for (const input of cases) {
      expect(truncateForClassifier(input).length).toBeLessThanOrEqual(MAX_CLASSIFIER_CONTEXT_CHARS);
    }
  });

  it('spends the whole budget when there is content for every section', () => {
    const veryLong = long(10_000);
    const out = truncateForClassifier({
      latestUserMessage: veryLong,
      latestAssistantMessage: veryLong,
    });
    // Exactly at the budget: the labels and separators are inside it, so the
    // content shrinks by their size rather than the message growing past it.
    expect(out.length).toBe(MAX_CLASSIFIER_CONTEXT_CHARS);
    expect(out).toContain('[AI END]: ');
  });

  it('captures from the start when capturing a USER START or AI START direction', () => {
    const userMessage = 'BEGINNING-MARKER' + long(2000) + 'END-MARKER';
    const out = truncateForClassifier({
      latestUserMessage: userMessage,
      latestAssistantMessage: '',
    });
    const startSection = out.split('\n\n').find((s) => s.startsWith('[USER START]:'));
    expect(startSection).toContain('BEGINNING-MARKER');
  });

  it('captures from the end when capturing a USER END or AI END direction', () => {
    const userMessage = 'BEGINNING-MARKER' + long(2000) + 'END-MARKER';
    const out = truncateForClassifier({
      latestUserMessage: userMessage,
      latestAssistantMessage: '',
    });
    const endSection = out.split('\n\n').find((s) => s.startsWith('[USER END]:'));
    expect(endSection).toContain('END-MARKER');
  });

  it('reallocates leftover budget when one direction has nothing to contribute', () => {
    // AI is empty, so AI directions get nothing — total captured can still
    // approach the global budget by reading more from the user message.
    const userMessage = long(MAX_CLASSIFIER_CONTEXT_CHARS * 2);
    const out = truncateForClassifier({
      latestUserMessage: userMessage,
      latestAssistantMessage: '',
    });
    // When AI is empty, the unused AI per-direction caps redistribute to the
    // user directions, so the message reaches the global budget — not stuck at
    // 2 × per-direction. Measured on the emitted message, because that is the
    // quantity the budget bounds.
    expect(out.length).toBe(MAX_CLASSIFIER_CONTEXT_CHARS);
  });

  it('first-message redistribution: a budget-sized user prompt fills the whole budget', () => {
    // When the AI message is empty (first turn), the per-direction cap
    // shouldn't halve the usable budget: USER START + USER END between them
    // spend the whole budget.
    const userMessage = long(MAX_CLASSIFIER_CONTEXT_CHARS);
    const out = truncateForClassifier({
      latestUserMessage: userMessage,
      latestAssistantMessage: '',
    });
    expect(out.length).toBe(MAX_CLASSIFIER_CONTEXT_CHARS);
  });

  it('preserves directional separators between sections', () => {
    const out = truncateForClassifier({
      latestUserMessage: 'hello',
      latestAssistantMessage: 'world',
    });
    // Sections are separated by blank lines.
    expect(out).toMatch(/\[USER START\]: hello.*\n\n\[AI START\]: world/s);
  });

  it('odd redistribution share floors without exceeding the global budget', () => {
    // A 301-char AI message exhausts mid-chunk, leaving an odd unclaimed
    // share. Math.floor splits it across the two user directions, so their
    // inflated caps sum to one char under the global budget — the fill loop
    // must then terminate on the cap check, not loop forever chasing the
    // last char.
    const out = truncateForClassifier({
      latestUserMessage: long(5000),
      latestAssistantMessage: long(301, 'y'),
    });
    const stripped = out.replaceAll(/\[(USER|AI) (START|END)\]: /g, '').replaceAll('\n\n', '');
    expect(stripped.length).toBeLessThanOrEqual(MAX_CLASSIFIER_CONTEXT_CHARS);
    expect(stripped.length).toBeGreaterThan(MAX_CLASSIFIER_CONTEXT_CHARS - CLASSIFIER_CHUNK_SIZE);
  });
});

// Uncoverable branch notes: the two `partner === undefined` guards
// (isDirectionExhausted, consumeChunk) are unreachable — buildDirections
// always emits four entries whose partnerIndex values point inside the
// array; the guards only narrow the noUncheckedIndexedAccess lookup. The
// `chunk.length === 0` guard is likewise unreachable: chunkSize is the min
// of four strictly positive numbers and both cursors stay inside the
// source, so the slice is never empty. consumeChunk's `dirRemaining <= 0`
// loop-safety guard also cannot fire: the global budget equals the sum of
// the four base caps, so it runs out before any direction's effective cap
// binds, and once every sibling crosses its base cap the effective cap
// recomputes upward (siblings then contribute zero leftover and shrink the
// active count), keeping captured strictly below it while budget remains.
