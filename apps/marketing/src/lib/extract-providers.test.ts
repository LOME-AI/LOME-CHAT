import { describe, it, expect } from 'vitest';
import { extractProviders } from './extract-providers';
import type { Model } from '@hushbox/shared';

function makeModel(provider: string): Model {
  return {
    id: `${provider.toLowerCase()}/test`,
    name: 'Test',
    provider,
    modality: 'text' as const,
    contextLength: 128_000,
    pricing: { inputPerToken: '1000', outputPerToken: '2000' },
    capabilities: [],
    description: 'Test',
    supportedParameters: [],
  };
}

describe('extractProviders', () => {
  it('returns empty array for empty model list', () => {
    expect(extractProviders([])).toEqual([]);
  });

  it('extracts unique providers', () => {
    const models = [makeModel('OpenAI'), makeModel('OpenAI'), makeModel('Anthropic')];
    const result = extractProviders(models);
    expect(result).toHaveLength(2);
    expect(result).toContain('OpenAI');
    expect(result).toContain('Anthropic');
  });

  it('puts priority providers first', () => {
    const models = [
      makeModel('Cohere'),
      makeModel('OpenAI'),
      makeModel('Meta'),
      makeModel('Anthropic'),
      makeModel('Google'),
      makeModel('DeepSeek'),
      makeModel('Mistral'),
    ];
    const result = extractProviders(models);
    expect(result[0]).toBe('OpenAI');
    expect(result[1]).toBe('Anthropic');
    expect(result[2]).toBe('Google');
    expect(result[3]).toBe('Meta');
    expect(result[4]).toBe('DeepSeek');
    expect(result[5]).toBe('Mistral');
    expect(result[6]).toBe('Cohere');
  });

  it('sorts non-priority providers alphabetically', () => {
    const models = [makeModel('Zebra'), makeModel('Alpha'), makeModel('Middle')];
    const result = extractProviders(models);
    expect(result).toEqual(['Alpha', 'Middle', 'Zebra']);
  });

  it('handles mix of priority and non-priority providers', () => {
    const models = [makeModel('Zebra'), makeModel('OpenAI'), makeModel('Alpha')];
    const result = extractProviders(models);
    expect(result[0]).toBe('OpenAI');
    expect(result[1]).toBe('Alpha');
    expect(result[2]).toBe('Zebra');
  });

  it('only includes priority providers that exist in the model list', () => {
    const models = [makeModel('Anthropic')];
    const result = extractProviders(models);
    expect(result).toEqual(['Anthropic']);
  });

  it('deduplicates providers that differ only by case', () => {
    const models = [makeModel('OpenAI'), makeModel('openai'), makeModel('OPENAI')];
    const result = extractProviders(models);
    expect(result).toEqual(['OpenAI']);
  });

  it('filters out Unknown provider', () => {
    const models = [makeModel('OpenAI'), makeModel('Unknown'), makeModel('unknown')];
    const result = extractProviders(models);
    expect(result).toEqual(['OpenAI']);
  });
});
