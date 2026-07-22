import { describe, expect, it } from 'vitest';

import { parseReasoningText, serializeReasoningText } from './reasoning-format.js';

/**
 * Deterministic PRNG (mulberry32) so the property loops are reproducible.
 * fast-check is not a dependency of this package; a seeded generator keeps
 * the property tests dependency-free per the task's zero-deps constraint.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return (): number => {
    // Math.imul coerces to int32 internally, so unbounded integer growth of
    // `a` does not affect the sequence; Math.trunc satisfies the lint rule.
    a = Math.trunc(a) + 0x6d_2b_79_f5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/**
 * Random string over a charset that includes newlines, spaces, angle brackets,
 * and delimiter-adjacent fragments — but never a full delimiter token, which
 * is reserved by the format (a literal delimiter inside reasoning/answer is
 * outside the round-trip contract).
 */
function randomText(rand: () => number, maxLength: number): string {
  const atoms = [
    'a',
    'Z',
    '9',
    ' ',
    '\n',
    '\t',
    '<',
    '>',
    '/',
    '<thin',
    '</thin',
    'think>',
    '<t>',
    'é',
    '𝛑',
    'word ',
  ];
  const length = Math.floor(rand() * maxLength);
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += atoms[Math.floor(rand() * atoms.length)] ?? '';
  }
  return out.replaceAll('<think>', '').replaceAll('</think>', '');
}

describe('serializeReasoningText', () => {
  it('wraps reasoning before the answer in the canonical format', () => {
    expect(serializeReasoningText('thoughts', 'answer')).toBe('<think>thoughts</think>\n\nanswer');
  });

  it('returns the answer verbatim when reasoning is empty', () => {
    expect(serializeReasoningText('', 'plain answer')).toBe('plain answer');
  });

  it('returns a natively-delimited answer verbatim when reasoning is empty', () => {
    const native = '<think>native thoughts</think>\n\nanswer';
    expect(serializeReasoningText('', native)).toBe(native);
  });

  it('drops a natively-emitted empty think block when wrapping reasoning', () => {
    expect(serializeReasoningText('mine', '<think></think>rest')).toBe(
      '<think>mine</think>\n\nrest'
    );
  });

  it('never double-wraps an answer that natively begins with the delimiter', () => {
    const serialized = serializeReasoningText('mine', '<think>native</think>\n\nrest');
    expect(serialized.split('<think>').length - 1).toBe(1);
    expect(parseReasoningText(serialized)).toEqual({
      reasoning: 'mine\nnative',
      answer: 'rest',
    });
  });
});

describe('parseReasoningText', () => {
  it('treats text without a delimiter entirely as answer', () => {
    expect(parseReasoningText('just an answer')).toEqual({ answer: 'just an answer' });
  });

  it('does not treat a mid-text delimiter as reasoning', () => {
    const text = 'prefix <think>not reasoning</think> suffix';
    expect(parseReasoningText(text)).toEqual({ answer: text });
  });

  it('splits a closed leading delimiter into reasoning and answer', () => {
    expect(parseReasoningText('<think>why</think>because')).toEqual({
      reasoning: 'why',
      answer: 'because',
    });
  });

  it('tolerates whitespace before a natively-emitted leading delimiter', () => {
    expect(parseReasoningText('\n<think>\nthoughts\n</think>\n\nanswer')).toEqual({
      reasoning: '\nthoughts\n',
      answer: 'answer',
    });
  });

  it('parses a natively-emitted empty think block', () => {
    expect(parseReasoningText('<think></think>answer')).toEqual({
      reasoning: '',
      answer: 'answer',
    });
  });

  it('treats everything after an unclosed delimiter as reasoning-so-far', () => {
    expect(parseReasoningText('<think>streaming thoughts so f')).toEqual({
      reasoning: 'streaming thoughts so f',
      answer: '',
    });
  });

  it('parses a bare open delimiter as empty reasoning-so-far', () => {
    expect(parseReasoningText('<think>')).toEqual({ reasoning: '', answer: '' });
  });
});

describe('round-trip', () => {
  it('preserves leading whitespace of the answer', () => {
    expect(parseReasoningText(serializeReasoningText('r', '  indented'))).toEqual({
      reasoning: 'r',
      answer: '  indented',
    });
  });

  it('preserves an answer that starts with a newline', () => {
    expect(parseReasoningText(serializeReasoningText('r', '\nnl'))).toEqual({
      reasoning: 'r',
      answer: '\nnl',
    });
  });

  it('parse(serialize(reasoning, answer)) is identity for generated inputs', () => {
    const rand = mulberry32(1337);
    for (let run = 0; run < 300; run += 1) {
      const reasoning = randomText(rand, 40);
      const answer = randomText(rand, 40);
      const parsed = parseReasoningText(serializeReasoningText(reasoning, answer));
      if (reasoning === '') {
        // Empty reasoning serializes to the answer verbatim; the answer's own
        // shape (delimiter-free by construction) parses as all-answer.
        expect(parsed).toEqual({ answer });
      } else {
        expect(parsed).toEqual({ reasoning, answer });
      }
    }
  });

  it('re-serializing a parse result is idempotent for generated inputs', () => {
    const rand = mulberry32(4242);
    for (let run = 0; run < 300; run += 1) {
      const reasoning = randomText(rand, 40);
      const answer = randomText(rand, 40);
      const once = serializeReasoningText(reasoning, answer);
      const parsed = parseReasoningText(once);
      const twice = serializeReasoningText(parsed.reasoning ?? '', parsed.answer);
      expect(twice).toBe(once);
    }
  });
});
