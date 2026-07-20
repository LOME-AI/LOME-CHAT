import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  storeExportKeyProtected,
  loadExportKeyProtected,
  clearDeviceKeyStore,
} from './device-key-store.e2e.js';

// The apps/web global localStorage mock (src/test-setup.ts) is a no-op whose
// getItem always returns null. This module is the storageState-capturable
// variant, so its tests need a real, stateful Storage. Install a Map-backed
// fake in beforeEach and restore the no-op mock in afterEach.
const STORAGE_KEY = 'hushbox_e2e_device_key';

function installStatefulLocalStorage(): void {
  const map = new Map<string, string>();
  const fake: Storage = {
    getItem: (key: string): string | null => (map.has(key) ? (map.get(key) ?? null) : null),
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
    clear: (): void => {
      map.clear();
    },
    key: (index: number): string | null => [...map.keys()][index] ?? null,
    get length(): number {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, writable: true });
}

describe('device-key-store.e2e', () => {
  const originalLocalStorage = globalThis.localStorage;

  const exportKey = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    27, 28, 29, 30, 31, 32,
  ]);
  const userId = 'user-abc';

  beforeEach(() => {
    installStatefulLocalStorage();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      writable: true,
    });
  });

  it('round-trips the export key and userId through localStorage', async () => {
    await storeExportKeyProtected(exportKey, userId);

    const loaded = await loadExportKeyProtected();

    expect(loaded).not.toBeNull();
    expect(loaded?.exportKey).toEqual(exportKey);
    expect(loaded?.userId).toBe(userId);
  });

  it('persists a non-null base64 string under the namespaced localStorage key', async () => {
    await storeExportKeyProtected(exportKey, userId);

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    // The base64 of the key bytes must be present in the stored string — this is
    // the property Playwright storageState captures out of localStorage.
    const { toBase64 } = await import('@hushbox/shared');
    expect(raw).toContain(toBase64(exportKey));
  });

  it('overwrites the previous entry on a second store', async () => {
    await storeExportKeyProtected(exportKey, userId);
    const otherKey = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    await storeExportKeyProtected(otherKey, 'user-xyz');

    const loaded = await loadExportKeyProtected();

    expect(loaded?.exportKey).toEqual(otherKey);
    expect(loaded?.userId).toBe('user-xyz');
  });

  it('returns null when nothing is stored', async () => {
    const loaded = await loadExportKeyProtected();

    expect(loaded).toBeNull();
  });

  it('clears the stored entry so a subsequent load returns null', async () => {
    await storeExportKeyProtected(exportKey, userId);

    await clearDeviceKeyStore();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(await loadExportKeyProtected()).toBeNull();
  });

  it('returns null when the stored value is not valid JSON', async () => {
    localStorage.setItem(STORAGE_KEY, 'not-json{');

    expect(await loadExportKeyProtected()).toBeNull();
  });

  it('returns null when the stored JSON is missing required fields', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'only-user' }));

    expect(await loadExportKeyProtected()).toBeNull();
  });
});
