import { describe, it, expect, beforeEach } from 'vitest';
import {
  getVersionOverride,
  setVersionOverride,
  clearVersionOverride,
} from './version-override.js';

describe('version-override', () => {
  beforeEach(() => {
    clearVersionOverride();
  });

  it('returns null when no override is set', () => {
    expect(getVersionOverride()).toBeNull();
  });

  it('returns the override after setting it', () => {
    setVersionOverride('dev-update-12345');

    expect(getVersionOverride()).toBe('dev-update-12345');
  });

  it('overwrites previous override', () => {
    setVersionOverride('v1');
    setVersionOverride('v2');

    expect(getVersionOverride()).toBe('v2');
  });

  it('returns null after clearing', () => {
    setVersionOverride('some-version');
    clearVersionOverride();

    expect(getVersionOverride()).toBeNull();
  });
});
