// E2E-only fallback for the OPAQUE export-key store.
//
// Production persists the export key as ciphertext under a non-extractable
// AES-GCM CryptoKey in IndexedDB (see device-key-store.ts). Playwright
// storageState captures cookies and Web Storage only — never IndexedDB — so an
// authenticated E2E context would restore a session cookie but no device key
// and be logged straight back out. This variant persists the key in
// localStorage instead, which storageState does capture. It is deliberately
// weaker (plaintext key bytes) and is reachable only through the env.isE2E
// dynamic-import gate in device-key-store.ts; an arch rule forbids any
// production module from statically importing it.

import { toBase64, fromBase64 } from '@hushbox/shared';

import type { ProtectedExportKey } from './device-key-store.js';

const STORAGE_KEY = 'hushbox_e2e_device_key';

interface StoredEntry {
  userId: string;
  exportKey: string;
}

export function storeExportKeyProtected(exportKey: Uint8Array, userId: string): Promise<void> {
  const entry: StoredEntry = { userId, exportKey: toBase64(exportKey) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  return Promise.resolve();
}

export function loadExportKeyProtected(): Promise<ProtectedExportKey | null> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return Promise.resolve(null);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as StoredEntry).userId !== 'string' ||
      typeof (parsed as StoredEntry).exportKey !== 'string'
    ) {
      return Promise.resolve(null);
    }
    const entry = parsed as StoredEntry;
    return Promise.resolve({ exportKey: fromBase64(entry.exportKey), userId: entry.userId });
  } catch {
    // Tolerant on corruption: unparseable storage behaves as "no key stored".
    return Promise.resolve(null);
  }
}

export function clearDeviceKeyStore(): Promise<void> {
  localStorage.removeItem(STORAGE_KEY);
  return Promise.resolve();
}
