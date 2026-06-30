import { describe, it, expect, afterEach } from 'vitest';

import { requireNumericEnv } from './idle-killer-daemon-entry.js';

describe('requireNumericEnv', () => {
  afterEach(() => {
    delete process.env['HB_IDLE_KILLER_ENTRY_PROBE'];
  });

  it('returns the parsed number when the variable holds a numeric string', () => {
    process.env['HB_IDLE_KILLER_ENTRY_PROBE'] = '8787';

    expect(requireNumericEnv('HB_IDLE_KILLER_ENTRY_PROBE')).toBe(8787);
  });

  it('throws naming the variable when it is unset', () => {
    delete process.env['HB_IDLE_KILLER_ENTRY_PROBE'];

    expect(() => requireNumericEnv('HB_IDLE_KILLER_ENTRY_PROBE')).toThrow(
      'HB_IDLE_KILLER_ENTRY_PROBE'
    );
  });

  it('throws naming the variable when it is empty', () => {
    process.env['HB_IDLE_KILLER_ENTRY_PROBE'] = '';

    expect(() => requireNumericEnv('HB_IDLE_KILLER_ENTRY_PROBE')).toThrow(
      'HB_IDLE_KILLER_ENTRY_PROBE'
    );
  });

  it('throws naming the variable when it is whitespace-only', () => {
    process.env['HB_IDLE_KILLER_ENTRY_PROBE'] = '   ';

    expect(() => requireNumericEnv('HB_IDLE_KILLER_ENTRY_PROBE')).toThrow(
      'HB_IDLE_KILLER_ENTRY_PROBE'
    );
  });

  it('throws naming the variable when it is non-numeric', () => {
    process.env['HB_IDLE_KILLER_ENTRY_PROBE'] = 'not-a-number';

    expect(() => requireNumericEnv('HB_IDLE_KILLER_ENTRY_PROBE')).toThrow(
      'HB_IDLE_KILLER_ENTRY_PROBE'
    );
  });
});
