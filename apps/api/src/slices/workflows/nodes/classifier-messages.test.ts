import { buildClassifierSystemPrompt } from '@hushbox/shared';
import { describe, expect, it } from 'vitest';

import { buildClassifierMessages } from './classifier-messages.js';

const MODELS = [
  {
    id: 'anthropic/claude-opus-4.6',
    description: 'Most capable model for complex reasoning and coding.',
  },
  { id: 'openai/gpt-5-nano', description: 'Cheap and fast.' },
];

describe('buildClassifierMessages', () => {
  it('returns exactly two messages, system before user', () => {
    const messages = buildClassifierMessages({
      truncatedContext: 'x',
      eligibleModels: MODELS,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });

  it('puts the truncated conversation context in the user message', () => {
    const ctx = '[USER START]: write a python script\n\n[USER END]: that sorts a list';
    const messages = buildClassifierMessages({ truncatedContext: ctx, eligibleModels: MODELS });
    expect(messages.find((m) => m.role === 'user')?.content).toBe(ctx);
  });

  it('renders the shared template verbatim as the system message', () => {
    // The template has one implementation; this pins that the assembly does not
    // acquire a second one, which is what the classifier reserve is priced on.
    const dimensions = { eligibleModels: MODELS, classifyEffort: true };
    const messages = buildClassifierMessages({ truncatedContext: 'hello', ...dimensions });
    expect(messages[0]?.content).toBe(buildClassifierSystemPrompt(dimensions));
  });

  it('carries the effort dimension through to the template', () => {
    const messages = buildClassifierMessages({ truncatedContext: '', classifyEffort: true });
    expect(messages[0]?.content).toBe(buildClassifierSystemPrompt({ classifyEffort: true }));
  });
});
