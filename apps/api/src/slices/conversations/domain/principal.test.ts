import { describe, expect, it } from 'vitest';
import { callerUserId } from './principal.js';
import type { Principal } from '../../../lib/context/index.js';

describe('callerUserId', () => {
  it('reads the user id off a full principal', () => {
    const principal = {
      kind: 'full',
      claims: { userId: 'u1', sessionId: 's1', createdAt: 0 },
    } as unknown as Principal;
    expect(callerUserId(principal)).toBe('u1');
  });

  it('treats any non-full principal as a composition defect', () => {
    expect(() => callerUserId({ kind: 'none' } as Principal)).toThrow(/full principal/);
  });
});
