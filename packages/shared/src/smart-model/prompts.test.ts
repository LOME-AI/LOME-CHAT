import { describe, expect, it } from 'vitest';

import {
  buildClassifierMessages,
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

describe('buildClassifierMessages', () => {
  it('returns a system message containing the classifier marker', () => {
    const messages = buildClassifierMessages({
      truncatedContext: '[USER START]: hello',
      eligibleModels: MODELS,
    });
    const system = messages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system?.content).toContain(CLASSIFIER_SYSTEM_PROMPT_MARKER);
  });

  it('lists every eligible model in the system prompt', () => {
    const messages = buildClassifierMessages({
      truncatedContext: '[USER START]: hi',
      eligibleModels: MODELS,
    });
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('anthropic/claude-opus-4.6');
    expect(system?.content).toContain('Most capable model for complex reasoning and coding.');
    expect(system?.content).toContain('openai/gpt-5-nano');
    expect(system?.content).toContain('Cheap and fast.');
  });

  it('truncates very long descriptions', () => {
    const longDesc = 'A'.repeat(CLASSIFIER_MAX_DESCRIPTION_CHARS * 2);
    const messages = buildClassifierMessages({
      truncatedContext: '',
      eligibleModels: [{ id: 'foo/bar', description: longDesc }],
    });
    const system = messages.find((m) => m.role === 'system');
    // Description rendered no longer than the cap.
    const renderedSegment = system?.content.split('foo/bar')[1] ?? '';
    expect(renderedSegment.length).toBeLessThanOrEqual(CLASSIFIER_MAX_DESCRIPTION_CHARS + 16);
  });

  it('puts the truncated conversation context in the user message', () => {
    const ctx = '[USER START]: write a python script\n\n[USER END]: that sorts a list';
    const messages = buildClassifierMessages({
      truncatedContext: ctx,
      eligibleModels: MODELS,
    });
    const user = messages.find((m) => m.role === 'user');
    expect(user).toBeDefined();
    expect(user?.content).toContain(ctx);
  });

  it('instructs the model to reply with only the model id', () => {
    const messages = buildClassifierMessages({
      truncatedContext: '',
      eligibleModels: MODELS,
    });
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content.toLowerCase()).toMatch(/(reply|respond|output).*model id/);
  });

  it('handles an empty eligible list without crashing', () => {
    const messages = buildClassifierMessages({
      truncatedContext: '',
      eligibleModels: [],
    });
    expect(messages.length).toBeGreaterThan(0);
  });

  it('returns exactly two messages (system + user)', () => {
    const messages = buildClassifierMessages({
      truncatedContext: 'x',
      eligibleModels: MODELS,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });
});

describe('buildClassifierMessages — dimension composition', () => {
  it('tags the model dimension with its marker on the marker line', () => {
    const messages = buildClassifierMessages({
      truncatedContext: '',
      eligibleModels: MODELS,
    });
    const firstLine = messages[0]?.content.split('\n')[0] ?? '';
    expect(firstLine).toContain(CLASSIFIER_SYSTEM_PROMPT_MARKER);
    expect(firstLine).toContain(CLASSIFIER_MODEL_DIMENSION_MARKER);
    expect(firstLine).not.toContain(CLASSIFIER_EFFORT_DIMENSION_MARKER);
  });

  it('renders an effort-only prompt: marker + effort instruction, no model list', () => {
    const messages = buildClassifierMessages({
      truncatedContext: '[USER START]: prove a theorem',
      classifyEffort: true,
    });
    expect(messages).toHaveLength(2);
    const system = messages[0]?.content ?? '';
    const firstLine = system.split('\n')[0] ?? '';
    expect(firstLine).toContain(CLASSIFIER_SYSTEM_PROMPT_MARKER);
    expect(firstLine).toContain(CLASSIFIER_EFFORT_DIMENSION_MARKER);
    expect(firstLine).not.toContain(CLASSIFIER_MODEL_DIMENSION_MARKER);
    expect(system.toLowerCase()).toContain('low, medium, or high');
    expect(system).not.toContain('Available models:');
    expect(messages[1]?.content).toContain('prove a theorem');
  });

  it('renders both dimensions in one prompt with a two-line output instruction', () => {
    const messages = buildClassifierMessages({
      truncatedContext: '',
      eligibleModels: MODELS,
      classifyEffort: true,
    });
    const system = messages[0]?.content ?? '';
    const firstLine = system.split('\n')[0] ?? '';
    expect(firstLine).toContain(CLASSIFIER_MODEL_DIMENSION_MARKER);
    expect(firstLine).toContain(CLASSIFIER_EFFORT_DIMENSION_MARKER);
    expect(system).toContain('Available models:');
    expect(system.toLowerCase()).toContain('low, medium, or high');
    expect(system.toLowerCase()).toMatch(/two lines/);
  });

  it('keeps the base marker as the prompt prefix in every composition (mock detection contract)', () => {
    const compositions = [
      { truncatedContext: '', eligibleModels: MODELS },
      { truncatedContext: '', classifyEffort: true as const },
      { truncatedContext: '', eligibleModels: MODELS, classifyEffort: true as const },
    ];
    for (const input of compositions) {
      const system = buildClassifierMessages(input)[0]?.content ?? '';
      expect(system.startsWith(CLASSIFIER_SYSTEM_PROMPT_MARKER)).toBe(true);
    }
  });
});

describe('computeClassifierPromptOverhead', () => {
  it('returns a positive integer for a non-empty model list', () => {
    const overhead = computeClassifierPromptOverhead(MODELS);
    expect(overhead).toBeGreaterThan(0);
    expect(Number.isInteger(overhead)).toBe(true);
  });

  it('matches the rendered BOTH-dimensions prompt for empty truncated context (worst case over compositions)', () => {
    const messages = buildClassifierMessages({
      truncatedContext: '',
      eligibleModels: MODELS,
      classifyEffort: true,
    });
    const total = messages.reduce((accumulator, m) => accumulator + m.content.length, 0);
    expect(computeClassifierPromptOverhead(MODELS)).toBe(total);
  });

  it('is an upper bound on every single-dimension prompt render', () => {
    const overhead = computeClassifierPromptOverhead(MODELS);
    const modelOnly = buildClassifierMessages({ truncatedContext: '', eligibleModels: MODELS });
    const effortOnly = buildClassifierMessages({ truncatedContext: '', classifyEffort: true });
    for (const messages of [modelOnly, effortOnly]) {
      const total = messages.reduce((accumulator, m) => accumulator + m.content.length, 0);
      expect(overhead).toBeGreaterThanOrEqual(total);
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

  it('returns the same value as length(buildClassifierMessages.system) + length(user wrapping with empty body)', () => {
    // Stable invariant: as long as the overhead helper and the prompt builder
    // share the same template, the overhead should equal the rendered prompt
    // chars when the truncated context is empty. Used so the helper can NOT
    // drift away from the actual prompt as the template evolves.
    const overhead = computeClassifierPromptOverhead(MODELS);
    const messages = buildClassifierMessages({
      truncatedContext: '',
      eligibleModels: MODELS,
      classifyEffort: true,
    });
    const concat = messages.map((m) => m.content).join('');
    expect(overhead).toBe(concat.length);
  });
});
