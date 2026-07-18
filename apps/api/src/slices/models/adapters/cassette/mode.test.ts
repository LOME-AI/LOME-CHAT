import { createEnvUtilities } from '@hushbox/shared';
import { describe, expect, it } from 'vitest';
import { cassetteModeFor } from './mode.js';

describe('cassetteModeFor', () => {
  it('returns record in CI', () => {
    const env = createEnvUtilities({ NODE_ENV: 'test', CI: 'true' });

    expect(cassetteModeFor(env)).toBe('record');
  });

  it('returns record outside CI', () => {
    const env = createEnvUtilities({ NODE_ENV: 'development' });

    expect(cassetteModeFor(env)).toBe('record');
  });
});
