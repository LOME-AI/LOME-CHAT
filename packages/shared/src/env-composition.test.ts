import { describe, expect, it } from 'vitest';
import { envConfig } from './env.config.js';
import { Destination, Mode } from './env-types.js';
import { composeEnvConfig, composedEnvConfig, envConfigAdditions } from './env-composition.js';

describe('composeEnvConfig', () => {
  it('merges additions over the base without touching base entries', () => {
    const addition = {
      EXAMPLE_ADDITION: {
        to: [Destination.Backend],
        [Mode.Development]: 'value',
      },
    };
    const composed = composeEnvConfig(envConfig, addition);
    expect(composed.EXAMPLE_ADDITION).toBe(addition.EXAMPLE_ADDITION);
    expect(composed.DATABASE_URL).toBe(envConfig.DATABASE_URL);
  });

  it('fails fast on a key colliding with the base config', () => {
    const collision = {
      DATABASE_URL: { to: [Destination.Backend], [Mode.Development]: 'clobber' },
    };
    expect(() => composeEnvConfig(envConfig, collision)).toThrow(/DATABASE_URL/);
  });
});

describe('composedEnvConfig', () => {
  it('composes the base env config by reference (never a copy)', () => {
    for (const [key, value] of Object.entries(envConfig)) {
      expect(composedEnvConfig[key as keyof typeof envConfig]).toBe(value);
    }
  });

  it('declares no additions yet (the composition mechanism ships first)', () => {
    expect(Object.keys(envConfigAdditions)).toEqual([]);
    expect(Object.keys(composedEnvConfig)).toEqual(Object.keys(envConfig));
  });
});
