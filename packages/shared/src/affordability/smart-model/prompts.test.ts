import { describe, expect, it } from 'vitest';

import {
  buildClassifierSystemPrompt,
  CLASSIFIER_EFFORT_DIMENSION_MARKER,
  CLASSIFIER_MAX_DESCRIPTION_CHARS,
  CLASSIFIER_MODEL_DIMENSION_MARKER,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  computeClassifierPromptOverhead,
} from './prompts.js';

const MODELS = [
  {
    id: 'anthropic/claude-opus-4.6',
    description: 'Most capable model for complex reasoning and coding.',
  },
  { id: 'openai/gpt-5-nano', description: 'Cheap and fast.' },
];

describe('buildClassifierSystemPrompt', () => {
  it('contains the classifier marker', () => {
    expect(buildClassifierSystemPrompt({ eligibleModels: MODELS })).toContain(
      CLASSIFIER_SYSTEM_PROMPT_MARKER
    );
  });

  it('lists every eligible model', () => {
    const prompt = buildClassifierSystemPrompt({ eligibleModels: MODELS });
    expect(prompt).toContain('anthropic/claude-opus-4.6');
    expect(prompt).toContain('Most capable model for complex reasoning and coding.');
    expect(prompt).toContain('openai/gpt-5-nano');
    expect(prompt).toContain('Cheap and fast.');
  });

  it('truncates very long descriptions', () => {
    const longDesc = 'A'.repeat(CLASSIFIER_MAX_DESCRIPTION_CHARS * 2);
    const prompt = buildClassifierSystemPrompt({
      eligibleModels: [{ id: 'foo/bar', description: longDesc }],
    });
    // Description rendered no longer than the cap.
    const renderedSegment = prompt.split('foo/bar')[1] ?? '';
    expect(renderedSegment.length).toBeLessThanOrEqual(CLASSIFIER_MAX_DESCRIPTION_CHARS + 16);
  });

  it('instructs the model to reply with only the model id', () => {
    expect(buildClassifierSystemPrompt({ eligibleModels: MODELS }).toLowerCase()).toMatch(
      /(reply|respond|output).*model id/
    );
  });

  it('handles an empty eligible list without crashing', () => {
    expect(buildClassifierSystemPrompt({ eligibleModels: [] }).length).toBeGreaterThan(0);
  });
});

describe('buildClassifierSystemPrompt — dimension composition', () => {
  it('tags the model dimension with its marker on the marker line', () => {
    const firstLine = buildClassifierSystemPrompt({ eligibleModels: MODELS }).split('\n')[0] ?? '';
    expect(firstLine).toContain(CLASSIFIER_SYSTEM_PROMPT_MARKER);
    expect(firstLine).toContain(CLASSIFIER_MODEL_DIMENSION_MARKER);
    expect(firstLine).not.toContain(CLASSIFIER_EFFORT_DIMENSION_MARKER);
  });

  it('renders an effort-only prompt: marker + effort instruction, no model list', () => {
    const prompt = buildClassifierSystemPrompt({ classifyEffort: true });
    const firstLine = prompt.split('\n')[0] ?? '';
    expect(firstLine).toContain(CLASSIFIER_SYSTEM_PROMPT_MARKER);
    expect(firstLine).toContain(CLASSIFIER_EFFORT_DIMENSION_MARKER);
    expect(firstLine).not.toContain(CLASSIFIER_MODEL_DIMENSION_MARKER);
    expect(prompt.toLowerCase()).toContain('low, medium, or high');
    expect(prompt).not.toContain('Available models:');
  });

  it('renders both dimensions in one prompt with a two-line output instruction', () => {
    const prompt = buildClassifierSystemPrompt({ eligibleModels: MODELS, classifyEffort: true });
    const firstLine = prompt.split('\n')[0] ?? '';
    expect(firstLine).toContain(CLASSIFIER_MODEL_DIMENSION_MARKER);
    expect(firstLine).toContain(CLASSIFIER_EFFORT_DIMENSION_MARKER);
    expect(prompt).toContain('Available models:');
    expect(prompt.toLowerCase()).toContain('low, medium, or high');
    expect(prompt.toLowerCase()).toMatch(/two lines/);
  });

  it('keeps the base marker as the prompt prefix in every composition (mock detection contract)', () => {
    const compositions = [
      { eligibleModels: MODELS },
      { classifyEffort: true as const },
      { eligibleModels: MODELS, classifyEffort: true as const },
    ];
    for (const input of compositions) {
      expect(buildClassifierSystemPrompt(input).startsWith(CLASSIFIER_SYSTEM_PROMPT_MARKER)).toBe(
        true
      );
    }
  });
});

describe('computeClassifierPromptOverhead', () => {
  it('returns a positive integer for a non-empty model list', () => {
    const overhead = computeClassifierPromptOverhead(MODELS);
    expect(overhead).toBeGreaterThan(0);
    expect(Number.isInteger(overhead)).toBe(true);
  });

  it('is an upper bound on every single-dimension prompt render', () => {
    const overhead = computeClassifierPromptOverhead(MODELS);
    const modelOnly = buildClassifierSystemPrompt({ eligibleModels: MODELS });
    const effortOnly = buildClassifierSystemPrompt({ classifyEffort: true });
    for (const prompt of [modelOnly, effortOnly]) {
      expect(overhead).toBeGreaterThanOrEqual(prompt.length);
    }
  });

  it('grows with the number of eligible models', () => {
    const small = computeClassifierPromptOverhead(MODELS.slice(0, 1));
    const large = computeClassifierPromptOverhead([
      ...MODELS,
      { id: 'extra/m', description: 'Another model.' },
      { id: 'extra/n', description: 'Yet another.' },
    ]);
    expect(large).toBeGreaterThan(small);
  });

  it('truncates per-model description to the cap when computing overhead', () => {
    const longDescModels = [
      {
        id: 'long/desc',
        description: 'X'.repeat(CLASSIFIER_MAX_DESCRIPTION_CHARS * 5),
      },
    ];
    const shortDescModels = [
      {
        id: 'long/desc',
        description: 'X'.repeat(CLASSIFIER_MAX_DESCRIPTION_CHARS * 5 + 2000),
      },
    ];
    // Both descriptions are well over the per-model cap; the overhead
    // calculation must clamp them, so the two results agree to within a
    // single character of slack.
    const a = computeClassifierPromptOverhead(longDescModels);
    const b = computeClassifierPromptOverhead(shortDescModels);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  });
});
