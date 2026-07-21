import { describe, expect, it } from 'vitest';
import { resolveDoName } from './do-identity.js';
import type { DoIdentityStore } from './do-identity.js';

const OPTIONS = {
  storageKey: 'roomName',
  missingMessage: 'no identity persisted',
};

class FakeStore implements DoIdentityStore {
  stored: string | undefined;

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(key === OPTIONS.storageKey ? this.stored : undefined);
  }

  put(key: string, value: string): Promise<void> {
    if (key === OPTIONS.storageKey) this.stored = value;
    return Promise.resolve();
  }
}

describe('resolveDoName', () => {
  it('returns the live id name and persists it under the storage key', async () => {
    const store = new FakeStore();
    const name = await resolveDoName('room-1', store, OPTIONS);
    expect(name).toBe('room-1');
    expect(store.stored).toBe('room-1');
  });

  it('falls back to the persisted name when the id carries none', async () => {
    const store = new FakeStore();
    store.stored = 'room-2';
    const name = await resolveDoName(undefined, store, OPTIONS);
    expect(name).toBe('room-2');
  });

  it('throws the caller-supplied message when no name exists anywhere', async () => {
    const store = new FakeStore();
    await expect(resolveDoName(undefined, store, OPTIONS)).rejects.toThrow('no identity persisted');
  });
});
