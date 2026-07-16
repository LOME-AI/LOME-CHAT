import { describe, expect, it } from 'vitest';

import { PROVIDER_MAP } from './provider-map.js';

describe('PROVIDER_MAP', () => {
  it('maps known model-id prefixes to display names', () => {
    expect(PROVIDER_MAP['openai']).toBe('OpenAI');
    expect(PROVIDER_MAP['anthropic']).toBe('Anthropic');
    expect(PROVIDER_MAP['google']).toBe('Google');
    expect(PROVIDER_MAP['meta-llama']).toBe('Meta');
  });

  it('has a display name for every prefix entry', () => {
    for (const [prefix, displayName] of Object.entries(PROVIDER_MAP)) {
      expect(prefix.length).toBeGreaterThan(0);
      expect(displayName.length).toBeGreaterThan(0);
    }
  });

  it('returns undefined for an unmapped prefix', () => {
    expect(PROVIDER_MAP['unknown-provider']).toBeUndefined();
  });
});
