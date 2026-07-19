import { unwrapAccountKeyWithPassword as cryptoUnwrapAccountKey } from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { ApiError } from '@/lib/api';
import { queryClient } from '@/providers/query-provider';
import {
  storeExportKeyProtected,
  loadExportKeyProtected,
  clearDeviceKeyStore,
} from './device-key-store.js';
import { meQueryOptions } from './auth-queries.js';

// Marker only — never key material. The export key itself lives device-protected
// in IndexedDB (see device-key-store). The marker records which user is signed in
// and, by which Web Storage area holds it, whether the session is persistent
// (localStorage = keep-signed-in) or tab-scoped (sessionStorage, cleared on tab
// close). The historical 'kek' key name is kept so an in-flight session's marker
// slot is stable across the upgrade.
export const STORAGE_KEY = 'hushbox_auth_kek';

type UnwrapFunction = (exportKey: Uint8Array, wrappedKey: Uint8Array) => Uint8Array;
let unwrapImpl: UnwrapFunction = cryptoUnwrapAccountKey;

export function setUnwrapImpl(impl: UnwrapFunction): void {
  unwrapImpl = impl;
}

export function resetUnwrapImpl(): void {
  unwrapImpl = cryptoUnwrapAccountKey;
}

interface StoredMarker {
  userId: string;
}

export interface StoredAuth {
  userId: string;
  keepSignedIn: boolean;
}

export interface RestoredSession {
  privateKey: Uint8Array;
  userId: string;
  user: MeResponse['user'];
  customInstructionsEncrypted: string | null;
}

/**
 * Persists the OPAQUE export key so the account private key can be unwrapped on
 * a later load without re-entering the password.
 *
 * The raw export key is never written to Web Storage. It is encrypted under a
 * per-device, non-extractable AES-GCM CryptoKey held in IndexedDB, and only the
 * ciphertext (with iv + userId) is persisted there. Web Storage holds a marker
 * with no key material:
 *
 * - `keepSignedIn` false (default): marker in sessionStorage — the browser clears
 *   only the marker on tab close; the device key + ciphertext persist until the
 *   next app load, where the no-marker branch (doInitAuth) purges them.
 * - `keepSignedIn` true: marker in localStorage — the persistent device key in
 *   IndexedDB keeps the user signed in across browser restarts until logout.
 */
export async function persistExportKey(
  exportKey: Uint8Array,
  userId: string,
  keepSignedIn: boolean
): Promise<void> {
  // Store the device-protected export key first so a present marker always
  // implies a decryptable key in IndexedDB.
  await storeExportKeyProtected(exportKey, userId);
  const marker = JSON.stringify({ userId } satisfies StoredMarker);
  if (keepSignedIn) {
    localStorage.setItem(STORAGE_KEY, marker);
    sessionStorage.removeItem(STORAGE_KEY);
  } else {
    sessionStorage.setItem(STORAGE_KEY, marker);
    localStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * Reads the sign-in marker from Web Storage.
 *
 * Checks localStorage first (persistent sessions), then sessionStorage.
 * `keepSignedIn` reflects which area held the marker. Returns null when no
 * marker is present. This is a synchronous, key-material-free presence check;
 * the actual export key is loaded asynchronously from IndexedDB in
 * restoreSession().
 *
 * A malformed marker (unparseable JSON, missing userId) is treated as
 * logged-out: the corrupt entry is evicted and null is returned. Throwing here
 * would brick boot, since doInitAuth() calls this before its try/finally.
 */
export function getStoredAuth(): StoredAuth | null {
  const local = localStorage.getItem(STORAGE_KEY);
  const raw = local ?? sessionStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const marker = JSON.parse(raw) as StoredMarker;
    if (typeof marker.userId === 'string') {
      return { userId: marker.userId, keepSignedIn: local !== null };
    }
  } catch {
    // Malformed marker JSON — treated as logged out below.
  }
  clearStoredAuth();
  return null;
}

/**
 * Returns true if a sign-in marker exists (sync Web Storage check).
 * Used to fire optimistic queries (e.g. balance) before initAuth() completes.
 * Returns false if storage is unavailable or throws.
 */
export function hasStoredAuth(): boolean {
  try {
    return getStoredAuth() !== null;
  } catch {
    return false;
  }
}

/**
 * Clears all stored auth: the Web Storage markers and the device-protected
 * export key in IndexedDB.
 *
 * Should be called on:
 * - Explicit logout
 * - Definitive auth failures (server returns 401 or 403)
 */
export function clearStoredAuth(): void {
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_KEY);
  void purgeDeviceKeyQuietly();
}

// Removing the marker in clearStoredAuth already logs the session out. The
// IndexedDB delete runs async with no recovery path, so a failure is
// intentionally ignored rather than left as an unhandled rejection.
async function purgeDeviceKeyQuietly(): Promise<void> {
  try {
    await clearDeviceKeyStore();
  } catch {
    // Best-effort purge; nothing to recover if IndexedDB is unavailable.
  }
}

export interface MeResponse {
  user: {
    id: string;
    email: string;
    username: string;
    emailVerified: boolean;
    totpEnabled: boolean;
    hasAcknowledgedPhrase: boolean;
  };
  pending2FA?: true;
  passwordWrappedPrivateKey?: string;
  publicKey?: string;
  customInstructionsEncrypted?: string | null;
}

// Fetches /me and validates it can drive a session restore. Returns null (after
// clearing definitively-invalid stored auth) when the session can't continue.
async function fetchMeForRestore(): Promise<MeResponse | null> {
  let data: MeResponse;
  try {
    // Routed through the query client so /me inherits the app-wide retry policy
    // (transient network/5xx blips are retried). 401/403 are not retryable, so
    // they fall through to the definitive-failure handling below.
    data = await queryClient.fetchQuery(meQueryOptions());
  } catch (error) {
    // Only clear stored auth on definitive auth failures (session invalid/forbidden).
    // Transient errors (500, 503, network) should NOT destroy the user's stored
    // encryption key — allow retry on next page load.
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      clearStoredAuth();
    }
    return null;
  }

  // Page was refreshed during 2FA — password is gone, can't continue.
  if (data.pending2FA || !data.passwordWrappedPrivateKey) {
    clearStoredAuth();
    return null;
  }

  return data;
}

export async function restoreSession(): Promise<RestoredSession | null> {
  const marker = getStoredAuth();
  if (!marker) {
    return null;
  }

  const data = await fetchMeForRestore();
  if (!data?.passwordWrappedPrivateKey) {
    return null;
  }

  let exportKey: Uint8Array;
  let userId: string;
  try {
    // Decrypt the export key into memory (transient) — never persisted as raw
    // bytes. A missing record means the marker outlived its device key (a closed
    // session tab); treat as logged out.
    const protectedKey = await loadExportKeyProtected();
    if (!protectedKey) {
      clearStoredAuth();
      return null;
    }
    ({ exportKey, userId } = protectedKey);
  } catch {
    clearStoredAuth();
    return null;
  }

  try {
    const wrappedKey = fromBase64(data.passwordWrappedPrivateKey);
    const privateKey = unwrapImpl(exportKey, wrappedKey);

    return {
      privateKey,
      userId,
      user: data.user,
      customInstructionsEncrypted: data.customInstructionsEncrypted ?? null,
    };
  } catch {
    // Stored export key is corrupted or wrong (or the wrapped key is
    // unparseable) — clear it so the next load starts logged-out.
    clearStoredAuth();
    return null;
  }
}
