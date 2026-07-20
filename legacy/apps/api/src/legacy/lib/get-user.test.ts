import { describe, it, expect } from 'vitest';
import { getUser } from './get-user';

describe('getUser', () => {
  it('returns user when present on context', () => {
    const user = {
      id: 'user-1',
      email: 'test@example.com',
      username: 'testuser',
      emailVerified: true,
      totpEnabled: false,
      hasAcknowledgedPhrase: true,
      publicKey: new Uint8Array([1, 2, 3]),
    };
    const c = { get: () => user };

    expect(getUser(c)).toBe(user);
  });

  it('throws when user is null', () => {
    const c = { get: () => null };

    expect(() => getUser(c)).toThrow('requireAuth middleware missing');
  });
});
