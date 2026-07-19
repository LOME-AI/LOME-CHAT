import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  storeExportKeyProtected,
  loadExportKeyProtected,
  clearDeviceKeyStore,
} from './device-key-store.js';

// Minimal in-memory IndexedDB faithful to the exact surface device-key-store
// uses (open → onupgradeneeded/onsuccess/onerror; transaction → objectStore →
// get/put/delete requests). Records are kept by reference, so a stored
// CryptoKey survives the round-trip unchanged — the same non-extractable
// guarantee a browser's structured clone provides.
interface FakeControls {
  failOpen: boolean;
  failRequest: boolean;
}

function installFakeIndexedDB(): {
  data: Map<unknown, unknown>;
  controls: FakeControls;
} {
  const data = new Map<unknown, unknown>();
  const controls: FakeControls = { failOpen: false, failRequest: false };

  const makeRequest = (getResult: () => unknown) => {
    const listeners: { error?: () => void } = {};
    const request: {
      onsuccess: (() => void) | null;
      addEventListener: (type: string, callback: () => void) => void;
      result: unknown;
      error: Error | null;
    } = {
      onsuccess: null,
      addEventListener: (type, callback) => {
        if (type === 'error') listeners.error = callback;
      },
      result: undefined,
      error: null,
    };
    queueMicrotask(() => {
      if (controls.failRequest) {
        request.error = new Error('fake idb request failure');
        listeners.error?.();
        return;
      }
      request.result = getResult();
      request.onsuccess?.();
    });
    return request;
  };

  const store = {
    put: (value: unknown, key: unknown) =>
      makeRequest(() => {
        data.set(key, value);
      }),
    get: (key: unknown) => makeRequest(() => data.get(key)),
    delete: (key: unknown) =>
      makeRequest(() => {
        data.delete(key);
      }),
  };

  const db = {
    transaction: () => ({ objectStore: () => store }),
    createObjectStore: () => store,
    close: () => {},
  };

  const fakeIndexedDB = {
    open: () => {
      const listeners: { error?: () => void } = {};
      const request: {
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        addEventListener: (type: string, callback: () => void) => void;
        result: unknown;
        error: Error | null;
      } = {
        onupgradeneeded: null,
        onsuccess: null,
        addEventListener: (type, callback) => {
          if (type === 'error') listeners.error = callback;
        },
        result: db,
        error: null,
      };
      queueMicrotask(() => {
        if (controls.failOpen) {
          request.error = new Error('fake idb open failure');
          listeners.error?.();
          return;
        }
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };

  vi.stubGlobal('indexedDB', fakeIndexedDB);
  return { data, controls };
}

describe('device-key-store', () => {
  const exportKey = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    27, 28, 29, 30, 31, 32,
  ]);
  const userId = 'user-abc';

  let fake: { data: Map<unknown, unknown>; controls: FakeControls };

  beforeEach(() => {
    fake = installFakeIndexedDB();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips the export key through the device key', async () => {
    await storeExportKeyProtected(exportKey, userId);

    const loaded = await loadExportKeyProtected();

    expect(loaded).not.toBeNull();
    expect(loaded?.exportKey).toEqual(exportKey);
    expect(loaded?.userId).toBe(userId);
  });

  it('never persists the export key as raw bytes', async () => {
    await storeExportKeyProtected(exportKey, userId);

    const record = [...fake.data.values()][0] as { ciphertext: Uint8Array; iv: Uint8Array };
    // The persisted ciphertext must not equal the plaintext export key.
    expect([...record.ciphertext]).not.toEqual([...exportKey]);
    expect(record.iv).toHaveLength(12);
  });

  it('stores the device key as a non-extractable CryptoKey', async () => {
    await storeExportKeyProtected(exportKey, userId);

    const record = [...fake.data.values()][0] as { deviceKey: CryptoKey };
    expect(record.deviceKey).toBeInstanceOf(CryptoKey);
    expect(record.deviceKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', record.deviceKey)).rejects.toThrow();
  });

  it('returns null when no device key is stored', async () => {
    const loaded = await loadExportKeyProtected();

    expect(loaded).toBeNull();
  });

  it('clears the stored device key and ciphertext', async () => {
    await storeExportKeyProtected(exportKey, userId);

    await clearDeviceKeyStore();

    expect(fake.data.size).toBe(0);
    expect(await loadExportKeyProtected()).toBeNull();
  });

  it('rejects when the database cannot be opened', async () => {
    fake.controls.failOpen = true;

    await expect(storeExportKeyProtected(exportKey, userId)).rejects.toThrow();
  });

  it('rejects when the read request fails', async () => {
    await storeExportKeyProtected(exportKey, userId);
    fake.controls.failRequest = true;

    await expect(loadExportKeyProtected()).rejects.toThrow();
  });
});
