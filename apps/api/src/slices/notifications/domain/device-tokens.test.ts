import { describe, it, expect } from 'vitest';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import {
  registerDeviceToken,
  registerDeviceTokenSchema,
  unregisterDeviceToken,
} from './device-tokens.js';
import type { DeviceTokenRegistration, DeviceTokenStore } from '../ports/index.js';

function storeWith(overrides: Partial<DeviceTokenStore>): DeviceTokenStore {
  return {
    upsert: () => okAsync(),
    deleteByToken: () => okAsync(null),
    listTokensForUsers: () => okAsync([]),
    ...overrides,
  };
}

describe('registerDeviceTokenSchema', () => {
  it('accepts a token with a known platform', () => {
    const parsed = registerDeviceTokenSchema.parse({ token: 'tok-1', platform: 'ios' });

    expect(parsed).toEqual({ token: 'tok-1', platform: 'ios' });
  });

  it('rejects an empty token', () => {
    expect(registerDeviceTokenSchema.safeParse({ token: '', platform: 'ios' }).success).toBe(false);
  });

  it('rejects an unknown platform', () => {
    expect(
      registerDeviceTokenSchema.safeParse({ token: 'tok-1', platform: 'windows' }).success
    ).toBe(false);
  });
});

describe('registerDeviceToken', () => {
  it('upserts the registration for the owning user', async () => {
    const seen: DeviceTokenRegistration[] = [];
    const store = storeWith({
      upsert: (registration) => {
        seen.push(registration);
        return okAsync();
      },
    });

    const result = await registerDeviceToken(store, 'user-1', {
      token: 'tok-1',
      platform: 'android',
    });

    expect(result.isOk()).toBe(true);
    expect(seen).toEqual([{ userId: 'user-1', token: 'tok-1', platform: 'android' }]);
  });

  it('propagates a store failure', async () => {
    const store = storeWith({ upsert: () => errAsync(unavailableError('insert failed')) });

    const result = await registerDeviceToken(store, 'user-1', {
      token: 'tok-1',
      platform: 'ios',
    });

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('unregisterDeviceToken', () => {
  it('transitions to true when the store deletes a row', async () => {
    const store = storeWith({ deleteByToken: () => okAsync(true) });

    const result = await unregisterDeviceToken(store, 'user-1', 'tok-1').transition();

    expect(result._unsafeUnwrap()).toBe(true);
  });

  it('transitions to null when the token is already absent', async () => {
    const store = storeWith({ deleteByToken: () => okAsync(null) });

    const result = await unregisterDeviceToken(store, 'user-1', 'tok-1').transition();

    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('disambiguates zero rows as an already-deleted no-op', async () => {
    const result = await unregisterDeviceToken(storeWith({}), 'user-1', 'tok-1').onZeroRows();

    expect(result._unsafeUnwrap()).toBe(false);
  });
});
