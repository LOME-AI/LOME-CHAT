import { describe, expect, it } from 'vitest';
import { callerUserId } from './principal.js';
import type { Principal } from '../../../lib/context/index.js';

describe('callerUserId', () => {
  it('returns the userId from a full principal', () => {
    const principal = { kind: 'full', claims: { userId: 'user-1' } } as Principal;
    expect(callerUserId(principal)).toBe('user-1');
  });

  it('throws when the principal is not full (a composition defect)', () => {
    expect(() => callerUserId({ kind: 'none' } as Principal)).toThrow(/full principal/);
  });
});
