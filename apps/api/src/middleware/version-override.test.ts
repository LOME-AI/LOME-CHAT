import { afterEach, describe, expect, it } from 'vitest';
import {
  clearVersionOverride,
  getVersionOverride,
  setVersionOverride,
} from './version-override.js';

afterEach(() => {
  clearVersionOverride();
});

describe('version override', () => {
  it('is null until set', () => {
    expect(getVersionOverride()).toBeNull();
  });

  it('returns the value set', () => {
    setVersionOverride('9.9.9');
    expect(getVersionOverride()).toBe('9.9.9');
  });

  it('clears back to null', () => {
    setVersionOverride('9.9.9');
    clearVersionOverride();
    expect(getVersionOverride()).toBeNull();
  });
});
