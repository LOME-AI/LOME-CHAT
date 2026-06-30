import { describe, expect, it } from 'vitest';

import { resolveClassifierOutput } from './resolve.js';

const ELIGIBLE = [
  'anthropic/claude-opus-4.6',
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-5-nano',
  'google/gemini-2.5-flash',
] as const;

describe('resolveClassifierOutput', () => {
  it('returns null for an empty list', () => {
    expect(resolveClassifierOutput('anthropic/claude-opus-4.6', [])).toBeNull();
  });

  it('returns null for an empty input', () => {
    expect(resolveClassifierOutput('', ELIGIBLE)).toBeNull();
    expect(resolveClassifierOutput('   \n  ', ELIGIBLE)).toBeNull();
  });

  it('matches an exact id', () => {
    expect(resolveClassifierOutput('anthropic/claude-opus-4.6', ELIGIBLE)).toBe(
      'anthropic/claude-opus-4.6'
    );
  });

  it('trims surrounding whitespace before matching', () => {
    expect(resolveClassifierOutput('  anthropic/claude-opus-4.6\n', ELIGIBLE)).toBe(
      'anthropic/claude-opus-4.6'
    );
  });

  it('matches case-insensitively', () => {
    expect(resolveClassifierOutput('Anthropic/Claude-Opus-4.6', ELIGIBLE)).toBe(
      'anthropic/claude-opus-4.6'
    );
    expect(resolveClassifierOutput('ANTHROPIC/CLAUDE-SONNET-4.6', ELIGIBLE)).toBe(
      'anthropic/claude-sonnet-4.6'
    );
  });

  it('matches when classifier omits the provider prefix (substring)', () => {
    expect(resolveClassifierOutput('claude-opus-4.6', ELIGIBLE)).toBe('anthropic/claude-opus-4.6');
    expect(resolveClassifierOutput('gpt-5-nano', ELIGIBLE)).toBe('openai/gpt-5-nano');
  });

  it('matches when classifier wraps the id with extra prose', () => {
    // Substring match: classifier said the id within a sentence.
    expect(resolveClassifierOutput('Use anthropic/claude-opus-4.6 for this task.', ELIGIBLE)).toBe(
      'anthropic/claude-opus-4.6'
    );
  });

  it('matches via Levenshtein when classifier mistypes the id slightly', () => {
    // Drop the dot in version
    expect(resolveClassifierOutput('anthropic/claude-opus-46', ELIGIBLE)).toBe(
      'anthropic/claude-opus-4.6'
    );
    // Replace dot with hyphen
    expect(resolveClassifierOutput('anthropic/claude-opus-4-6', ELIGIBLE)).toBe(
      'anthropic/claude-opus-4.6'
    );
  });

  it('returns null when classifier output is too far from any eligible id', () => {
    expect(resolveClassifierOutput('totally-made-up-model-xyz', ELIGIBLE)).toBeNull();
    // Just a single distinct word — too far from any id
    expect(resolveClassifierOutput('hello', ELIGIBLE)).toBeNull();
  });

  it('does not match a model that is not in the eligible list', () => {
    expect(resolveClassifierOutput('anthropic/claude-haiku-4.5', ELIGIBLE)).toBeNull();
  });

  it('prefers the closest Levenshtein match when multiple candidates are similar', () => {
    expect(resolveClassifierOutput('claude-sonnet-4.6', ELIGIBLE)).toBe(
      'anthropic/claude-sonnet-4.6'
    );
  });
});

// Uncoverable branch note: findLevenshteinMatch's `best === null` guard is
// unreachable — resolveClassifierOutput returns early for an empty eligible
// list, so the helper always loops at least once and assigns `best`. The
// guard only narrows the accumulator's nullable type.
