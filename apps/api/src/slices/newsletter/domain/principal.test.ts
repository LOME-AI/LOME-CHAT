import { describe, expect, it } from 'vitest';
import { callerUserId } from './principal.js';
import type { Principal } from '../../../lib/context/index.js';

describe('callerUserId', () => {
  it('returns the userId from a full principal', () => {
    const principal = {
      kind: 'full',
      claims: { userId: 'user-1', sessionId: 's-1', createdAt: 0 },
    } as unknown as Principal;
    expect(callerUserId(principal)).toBe('user-1');
  });

  it('throws on a non-full principal (composition defect)', () => {
    const principal = { kind: 'anonymous' } as unknown as Principal;
    expect(() => callerUserId(principal)).toThrow('without full principal');
  });
});
