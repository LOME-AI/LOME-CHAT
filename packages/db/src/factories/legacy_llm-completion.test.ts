import { describe, it, expect } from 'vitest';

import { llmCompletionFactory } from './legacy_llm-completion';

describe('llmCompletionFactory', () => {
  it('builds a complete llm completion object', () => {
    const completion = llmCompletionFactory.build();

    expect(completion.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(completion.usageRecordId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(completion.model).toBeTruthy();
    expect(completion.provider).toBeTruthy();
    expect(typeof completion.inputTokens).toBe('number');
    expect(typeof completion.outputTokens).toBe('number');
    expect(typeof completion.cachedTokens).toBe('number');
  });

  it('generates positive token counts', () => {
    const completion = llmCompletionFactory.build();

    expect(completion.inputTokens).toBeGreaterThan(0);
    expect(completion.outputTokens).toBeGreaterThan(0);
    expect(completion.cachedTokens).toBeGreaterThanOrEqual(0);
  });

  it('generates realistic model names', () => {
    const completion = llmCompletionFactory.build();
    expect(completion.model).toContain('/');
  });

  it('allows field overrides', () => {
    const completion = llmCompletionFactory.build({
      model: 'openai/gpt-4',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 200,
    });
    expect(completion.model).toBe('openai/gpt-4');
    expect(completion.provider).toBe('openai');
    expect(completion.inputTokens).toBe(100);
    expect(completion.outputTokens).toBe(200);
  });

  it('builds a list with unique IDs', () => {
    const completionList = llmCompletionFactory.buildList(3);
    expect(completionList).toHaveLength(3);
    const ids = new Set(completionList.map((c) => c.id));
    expect(ids.size).toBe(3);
  });
});
