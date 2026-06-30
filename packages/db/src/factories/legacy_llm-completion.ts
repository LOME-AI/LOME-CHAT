import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { llmCompletions } from '../schema/llm-completions';

type LlmCompletion = typeof llmCompletions.$inferSelect;

const MODELS = [
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3-haiku',
  'google/gemini-pro-1.5',
  'meta-llama/llama-3.1-70b-instruct',
];

const PROVIDERS = ['openai', 'anthropic', 'google', 'meta-llama'];

export const llmCompletionFactory = Factory.define<LlmCompletion>(() => {
  const model = faker.helpers.arrayElement(MODELS);
  const provider = model.split('/')[0] ?? faker.helpers.arrayElement(PROVIDERS);

  return {
    id: crypto.randomUUID(),
    usageRecordId: crypto.randomUUID(),
    model,
    provider,
    inputTokens: faker.number.int({ min: 10, max: 10_000 }),
    outputTokens: faker.number.int({ min: 10, max: 5000 }),
    cachedTokens: faker.helpers.arrayElement([0, 0, 0, faker.number.int({ min: 10, max: 1000 })]),
  };
});
