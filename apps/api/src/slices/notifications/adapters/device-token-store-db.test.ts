import { describe, it, expect } from 'vitest';
import { createDeviceTokenStore } from './device-token-store-db.js';
import type { Database } from '@hushbox/db';

interface Row {
  userId: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
  p256dh: string | null;
  auth: string | null;
}

/** A fake DB whose token lookup returns the given rows verbatim. */
function dbReturning(rows: readonly Row[]): Database {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as Database;
}

describe('createDeviceTokenStore.listTokensForUsers row widening', () => {
  it('maps a native row to a token target', async () => {
    const store = createDeviceTokenStore(
      dbReturning([{ userId: 'u1', token: 'tok', platform: 'ios', p256dh: null, auth: null }])
    );

    const result = await store.listTokensForUsers(['u1']);

    expect(result._unsafeUnwrap()).toEqual([{ platform: 'ios', userId: 'u1', token: 'tok' }]);
  });

  it('maps a well-formed web row to an endpoint-plus-keys target', async () => {
    const store = createDeviceTokenStore(
      dbReturning([
        { userId: 'u1', token: 'https://push/aaa', platform: 'web', p256dh: 'p', auth: 'a' },
      ])
    );

    const result = await store.listTokensForUsers(['u1']);

    expect(result._unsafeUnwrap()).toEqual([
      { platform: 'web', userId: 'u1', endpoint: 'https://push/aaa', p256dh: 'p', auth: 'a' },
    ]);
  });

  it('drops a web row missing its p256dh key rather than shipping a malformed target', async () => {
    const store = createDeviceTokenStore(
      dbReturning([
        { userId: 'u1', token: 'https://push/aaa', platform: 'web', p256dh: null, auth: 'a' },
      ])
    );

    const result = await store.listTokensForUsers(['u1']);

    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('drops a web row missing its auth key', async () => {
    const store = createDeviceTokenStore(
      dbReturning([
        { userId: 'u1', token: 'https://push/aaa', platform: 'web', p256dh: 'p', auth: null },
      ])
    );

    const result = await store.listTokensForUsers(['u1']);

    expect(result._unsafeUnwrap()).toEqual([]);
  });
});
