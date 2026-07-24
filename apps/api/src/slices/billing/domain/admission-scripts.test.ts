import { describe, expect, it } from 'vitest';
import { ACTIVE_HOLDS_LUA, ADMISSION_SCRIPT, HOLDS_READ_SCRIPT } from './admission-scripts.js';

/**
 * The hold format/expiry rule ("{amount}:{expiresAtMs}", lazy prune) must have
 * exactly one implementation. These pins prove both scripts embed the one
 * shared fragment verbatim — a divergent copy in either script fails here.
 */
describe('activeHolds Lua fragment sharing', () => {
  it('is embedded verbatim in the admission script', () => {
    expect(ADMISSION_SCRIPT).toContain(ACTIVE_HOLDS_LUA);
  });

  it('is embedded verbatim in the holds read script', () => {
    expect(HOLDS_READ_SCRIPT).toContain(ACTIVE_HOLDS_LUA);
  });

  it('defines the activeHolds function over an arbitrary hold hash key', () => {
    expect(ACTIVE_HOLDS_LUA).toContain('local function activeHolds(key, now)');
  });
});
