import { ModelDescriptor } from '@hushbox/shared';
import { describe, expect, it } from 'vitest';
import { snapshotResolver } from './pricing-resolver.js';

function descriptor(id: string): ModelDescriptor {
  return ModelDescriptor.parse({
    id,
    provider: 'openai',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: { contextTokens: 400_000 },
    pricing: { inputPerToken: '500', outputPerToken: '1500' },
    zdrReachable: true,
    fetchedAt: 0,
  });
}

describe('snapshotResolver', () => {
  it('resolves a known model id to its descriptor, pricing carried', () => {
    const gpt = descriptor('openai/gpt-5');
    const resolve = snapshotResolver([gpt]);

    const found = resolve('openai/gpt-5');
    expect(found).toBe(gpt);
    expect(found?.pricing['inputPerToken']).toBe(500n);
  });

  it('returns undefined for an unknown model id (fail-closed by omission)', () => {
    const resolve = snapshotResolver([descriptor('openai/gpt-5')]);

    expect(resolve('anthropic/claude')).toBeUndefined();
  });

  it('resolves over an empty snapshot to undefined for every id', () => {
    const resolve = snapshotResolver([]);

    expect(resolve('openai/gpt-5')).toBeUndefined();
  });
});
