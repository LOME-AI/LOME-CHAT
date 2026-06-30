import { createEnvUtilities } from '@hushbox/shared';
import { describe, expect, it } from 'vitest';
import { cassetteModeFor } from './mode.js';

describe('cassetteModeFor', () => {
  it('returns replay-only in CI', () => {
    const env = createEnvUtilities({ NODE_ENV: 'test', CI: 'true' });

    expect(cassetteModeFor(env)).toBe('replay-only');
  });

  it('returns record outside CI', () => {
    const env = createEnvUtilities({ NODE_ENV: 'development' });

    expect(cassetteModeFor(env)).toBe('record');
  });
});
