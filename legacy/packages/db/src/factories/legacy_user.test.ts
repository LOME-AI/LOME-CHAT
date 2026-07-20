import { describe, it, expect } from 'vitest';

import { userFactory } from './legacy_user';

describe('userFactory', () => {
  it('builds a complete user object', () => {
    const user = userFactory.build();

    expect(user.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(user.email).toContain('@');
    expect(user.username).toBeTruthy();
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it('generates default boolean and null fields', () => {
    const user = userFactory.build();

    expect(user.emailVerified).toBe(false);
    expect(user.emailVerifyToken).toBeNull();
    expect(user.emailVerifyExpires).toBeNull();
    expect(user.totpSecretEncrypted).toBeNull();
    expect(user.totpEnabled).toBe(false);
    expect(user.hasAcknowledgedPhrase).toBe(false);
  });

  it('generates bytea fields as Uint8Array', () => {
    const user = userFactory.build();

    expect(user.opaqueRegistration).toBeInstanceOf(Uint8Array);
    expect(user.publicKey).toBeInstanceOf(Uint8Array);
    expect(user.passwordWrappedPrivateKey).toBeInstanceOf(Uint8Array);
    expect(user.recoveryWrappedPrivateKey).toBeInstanceOf(Uint8Array);
  });

  it('generates bytea fields with realistic sizes', () => {
    const user = userFactory.build();

    expect(user.opaqueRegistration.length).toBeGreaterThan(0);
    expect(user.publicKey.length).toBe(32);
    expect(user.passwordWrappedPrivateKey.length).toBeGreaterThan(0);
    expect(user.recoveryWrappedPrivateKey.length).toBeGreaterThan(0);
  });

  it('allows field overrides', () => {
    const user = userFactory.build({ username: 'custom_name' });
    expect(user.username).toBe('custom_name');
  });

  it('builds a list with unique IDs', () => {
    const userList = userFactory.buildList(3);
    expect(userList).toHaveLength(3);
    const ids = new Set(userList.map((u) => u.id));
    expect(ids.size).toBe(3);
  });
});
