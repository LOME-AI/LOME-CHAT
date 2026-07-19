import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toBase64 } from '@hushbox/shared';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    getApiUrl: () => 'http://localhost:8787',
  };
});

// restoreSession routes /me through the shared query client so it inherits the
// app-wide retry policy. Use a real QueryClient wired to the production retry
// predicate (zero delay to keep tests fast) so retry behavior is exercised for
// real rather than stubbed away.
vi.mock('@/providers/query-provider', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  const { shouldRetry } = await import('@/lib/retry');
  return {
    queryClient: new QueryClient({
      defaultOptions: {
        queries: { retry: shouldRetry, retryDelay: () => 0, staleTime: 0, gcTime: 0 },
      },
    }),
  };
});

import { queryClient } from '@/providers/query-provider';
import {
  persistExportKey,
  restoreSession,
  clearStoredAuth,
  getStoredAuth,
  hasStoredAuth,
  setUnwrapImpl,
  resetUnwrapImpl,
  STORAGE_KEY,
} from './auth-client.js';

const mockUnwrapAccountKey = vi.fn();

// Real in-memory Web Storage (test-setup.ts mocks localStorage with stubs).
function createInMemoryStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      Reflect.deleteProperty(store, key);
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
}

// Minimal in-memory IndexedDB matching the surface device-key-store uses.
// Records are held by reference so a stored CryptoKey survives unchanged.
interface FakeControls {
  failOpen: boolean;
}

function installFakeIndexedDB(): { data: Map<unknown, unknown>; controls: FakeControls } {
  const data = new Map<unknown, unknown>();
  const controls: FakeControls = { failOpen: false };
  const makeRequest = (getResult: () => unknown) => {
    const request: {
      onsuccess: (() => void) | null;
      addEventListener: (type: string, callback: () => void) => void;
      result: unknown;
      error: Error | null;
    } = { onsuccess: null, addEventListener: () => {}, result: undefined, error: null };
    queueMicrotask(() => {
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

interface MeResponseInit {
  passwordWrappedPrivateKey?: Uint8Array;
  customInstructionsEncrypted?: string | null;
  pending2FA?: true;
  totpEnabled?: boolean;
}

function meOkResponse(init: MeResponseInit = {}): Response {
  const { passwordWrappedPrivateKey, customInstructionsEncrypted, pending2FA, totpEnabled } = init;
  const body: Record<string, unknown> = {
    user: {
      id: 'user-123',
      email: 'test@example.com',
      username: 'test',
      emailVerified: true,
      totpEnabled: totpEnabled ?? false,
      hasAcknowledgedPhrase: true,
    },
  };
  if (pending2FA) body['pending2FA'] = true;
  if (passwordWrappedPrivateKey) {
    body['passwordWrappedPrivateKey'] = toBase64(passwordWrappedPrivateKey);
    body['publicKey'] = toBase64(new Uint8Array([1, 2, 3]));
  }
  if (customInstructionsEncrypted !== undefined) {
    body['customInstructionsEncrypted'] = customInstructionsEncrypted;
  }
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('auth-client', () => {
  const testExportKey = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    27, 28, 29, 30, 31, 32,
  ]);
  const testUserId = 'user-123';
  const testPrivateKey = new Uint8Array([
    32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9,
    8, 7, 6, 5, 4, 3, 2, 1,
  ]);

  let mockFetch: ReturnType<typeof vi.fn>;
  let idbData: Map<unknown, unknown>;
  let idbControls: FakeControls;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', createInMemoryStorage());
    vi.stubGlobal('sessionStorage', createInMemoryStorage());
    ({ data: idbData, controls: idbControls } = installFakeIndexedDB());
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    setUnwrapImpl(mockUnwrapAccountKey);
    queryClient.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetUnwrapImpl();
  });

  describe('STORAGE_KEY', () => {
    it('is hushbox_auth_kek', () => {
      expect(STORAGE_KEY).toBe('hushbox_auth_kek');
    });
  });

  describe('persistExportKey', () => {
    it('stores the marker in sessionStorage when keepSignedIn is false', async () => {
      await persistExportKey(testExportKey, testUserId, false);

      expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('stores the marker in localStorage when keepSignedIn is true', async () => {
      await persistExportKey(testExportKey, testUserId, true);

      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('stores only the userId in the marker, never key bytes', async () => {
      await persistExportKey(testExportKey, testUserId, false);

      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (!stored) throw new Error('Expected stored value');
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      expect(parsed['userId']).toBe(testUserId);
      expect(parsed['kek']).toBeUndefined();
      expect(stored).not.toContain(toBase64(testExportKey));
    });

    it('never persists the raw export key in Web Storage or IndexedDB', async () => {
      await persistExportKey(testExportKey, testUserId, true);

      const rawBase64 = toBase64(testExportKey);
      expect(localStorage.getItem(STORAGE_KEY) ?? '').not.toContain(rawBase64);
      expect(sessionStorage.getItem(STORAGE_KEY) ?? '').not.toContain(rawBase64);

      const record = [...idbData.values()][0] as {
        iv: Uint8Array;
        ciphertext: Uint8Array;
        userId: string;
        deviceKey: CryptoKey;
      };
      expect(Object.keys(record).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'ciphertext',
        'deviceKey',
        'iv',
        'userId',
      ]);
      expect([...record.ciphertext]).not.toEqual([...testExportKey]);
      expect(record.userId).toBe(testUserId);
      expect(record.deviceKey.extractable).toBe(false);
    });

    it('overwrites the marker userId on repeat', async () => {
      await persistExportKey(testExportKey, 'first-user', false);
      await persistExportKey(testExportKey, 'second-user', false);

      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (!stored) throw new Error('Expected stored value');
      expect((JSON.parse(stored) as { userId: string }).userId).toBe('second-user');
    });
  });

  describe('clearStoredAuth', () => {
    it('clears localStorage', () => {
      localStorage.setItem(STORAGE_KEY, 'test');

      clearStoredAuth();

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clears sessionStorage', () => {
      sessionStorage.setItem(STORAGE_KEY, 'test');

      clearStoredAuth();

      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clears both storages at once', () => {
      localStorage.setItem(STORAGE_KEY, 'test-local');
      sessionStorage.setItem(STORAGE_KEY, 'test-session');

      clearStoredAuth();

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('purges the device key from IndexedDB', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      expect(idbData.size).toBe(1);

      clearStoredAuth();
      // The IndexedDB delete runs async (fire-and-forget); let it settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(idbData.size).toBe(0);
    });

    it('ignores an IndexedDB failure while purging the device key', async () => {
      localStorage.setItem(STORAGE_KEY, 'marker');
      idbControls.failOpen = true;

      // Must not throw despite the async device-key purge rejecting.
      expect(() => {
        clearStoredAuth();
      }).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('getStoredAuth', () => {
    it('returns null when no marker is stored', () => {
      expect(getStoredAuth()).toBeNull();
    });

    it('returns userId with keepSignedIn true from localStorage', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: testUserId }));

      const result = getStoredAuth();

      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe(testUserId);
      expect(result.keepSignedIn).toBe(true);
    });

    it('returns userId with keepSignedIn false from sessionStorage', () => {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: testUserId }));

      const result = getStoredAuth();

      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe(testUserId);
      expect(result.keepSignedIn).toBe(false);
    });

    it('prefers localStorage over sessionStorage when both exist', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'local-user' }));
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'session-user' }));

      const result = getStoredAuth();

      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe('local-user');
      expect(result.keepSignedIn).toBe(true);
    });

    it('returns null when the marker is malformed JSON', () => {
      localStorage.setItem(STORAGE_KEY, 'not-valid-json');

      expect(getStoredAuth()).toBeNull();
    });

    it('returns null when the marker is missing a userId', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ notUserId: 'x' }));

      expect(getStoredAuth()).toBeNull();
    });

    it('clears the corrupt marker from storage', () => {
      localStorage.setItem(STORAGE_KEY, 'not-valid-json');

      getStoredAuth();

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('restoreSession', () => {
    it('returns null when no marker is stored', async () => {
      const result = await restoreSession();

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetches the wrapped key from the server', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(meOkResponse({ passwordWrappedPrivateKey: testPrivateKey }));
      mockUnwrapAccountKey.mockReturnValue(testPrivateKey);

      await restoreSession();

      const meCall = mockFetch.mock.calls.find(([input]) =>
        String(typeof input === 'object' && input ? (input as Request).url : input).includes(
          '/auth/me'
        )
      );
      expect(meCall).toBeDefined();
    });

    it('routes the /me request through the typed client (sends platform header)', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(meOkResponse({ passwordWrappedPrivateKey: testPrivateKey }));
      mockUnwrapAccountKey.mockReturnValue(testPrivateKey);

      await restoreSession();

      const meCall = mockFetch.mock.calls.find(([input]) =>
        String(typeof input === 'object' && input ? (input as Request).url : input).includes(
          '/auth/me'
        )
      );
      if (!meCall) throw new Error('Expected /me request');
      const headers = new Headers(meCall[1]?.headers);
      expect(headers.get('X-HushBox-Platform')).not.toBeNull();
    });

    it('returns privateKey and userId on success', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(meOkResponse({ passwordWrappedPrivateKey: testPrivateKey }));
      mockUnwrapAccountKey.mockReturnValue(testPrivateKey);

      const result = await restoreSession();

      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe(testUserId);
      expect(result.privateKey).toEqual(testPrivateKey);
    });

    it('unwraps with the export key decrypted from IndexedDB and the wrapped key', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      const wrappedKey = new Uint8Array([100, 101, 102]);
      mockFetch.mockResolvedValue(meOkResponse({ passwordWrappedPrivateKey: wrappedKey }));
      mockUnwrapAccountKey.mockReturnValue(testPrivateKey);

      await restoreSession();

      expect(mockUnwrapAccountKey).toHaveBeenCalledWith(testExportKey, wrappedKey);
    });

    it('clears storage and returns null on 401 auth rejection', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue({ ok: false, status: 401, headers: new Headers() } as Response);

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clears storage and returns null on 403 forbidden', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue({ ok: false, status: 403, headers: new Headers() } as Response);

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('preserves storage on 500 server error', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue({ ok: false, status: 500, headers: new Headers() } as Response);

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('preserves storage on 503 service unavailable', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue({ ok: false, status: 503, headers: new Headers() } as Response);

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('retries a transient /me failure and restores the session', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      // First /me is dropped (navigation/network blip surfaces as a TypeError);
      // the app-wide retry policy re-attempts and the second call succeeds.
      mockFetch
        .mockRejectedValueOnce(new TypeError('Load failed'))
        .mockResolvedValueOnce(meOkResponse({ passwordWrappedPrivateKey: testPrivateKey }));
      mockUnwrapAccountKey.mockReturnValue(testPrivateKey);

      const result = await restoreSession();

      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe(testUserId);
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('clears storage and returns null when unwrap fails', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(meOkResponse({ passwordWrappedPrivateKey: testPrivateKey }));
      mockUnwrapAccountKey.mockImplementation(() => {
        throw new Error('Unwrap failed');
      });

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clears storage and returns null when the device key cannot be loaded', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: testUserId }));
      mockFetch.mockResolvedValue(meOkResponse({ passwordWrappedPrivateKey: testPrivateKey }));
      // The device-key read fails (IndexedDB error, not a missing record).
      idbControls.failOpen = true;

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clears storage and returns null when the device key is missing from IndexedDB', async () => {
      // Marker present but no IndexedDB record — e.g. a stale marker.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: testUserId }));
      mockFetch.mockResolvedValue(meOkResponse({ passwordWrappedPrivateKey: testPrivateKey }));

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('returns null but preserves storage when fetch throws', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('returns customInstructionsEncrypted from the server response', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(
        meOkResponse({
          passwordWrappedPrivateKey: testPrivateKey,
          customInstructionsEncrypted: 'encrypted-blob-base64',
        })
      );
      mockUnwrapAccountKey.mockReturnValue(testPrivateKey);

      const result = await restoreSession();

      if (!result) throw new Error('Expected result');
      expect(result.customInstructionsEncrypted).toBe('encrypted-blob-base64');
    });

    it('returns null customInstructionsEncrypted when not set on the server', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(
        meOkResponse({
          passwordWrappedPrivateKey: testPrivateKey,
          customInstructionsEncrypted: null,
        })
      );
      mockUnwrapAccountKey.mockReturnValue(testPrivateKey);

      const result = await restoreSession();

      if (!result) throw new Error('Expected result');
      expect(result.customInstructionsEncrypted).toBeNull();
    });

    it('clears storage and returns null when the session is mid-2FA (pending2FA)', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(meOkResponse({ pending2FA: true, totpEnabled: true }));

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clears storage and returns null when passwordWrappedPrivateKey is missing', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(meOkResponse());

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('session lifetime', () => {
    it('keep-signed-in survives a browser-close simulation', async () => {
      await persistExportKey(testExportKey, testUserId, true);

      // Browser close: the tab-scoped sessionStorage is wiped, but localStorage
      // and IndexedDB persist.
      vi.stubGlobal('sessionStorage', createInMemoryStorage());
      mockFetch.mockResolvedValue(meOkResponse({ passwordWrappedPrivateKey: testPrivateKey }));
      mockUnwrapAccountKey.mockReturnValue(testPrivateKey);

      const result = await restoreSession();

      if (!result) throw new Error('Expected session to survive');
      expect(result.userId).toBe(testUserId);
    });

    it('session mode is cleared on tab close', async () => {
      await persistExportKey(testExportKey, testUserId, false);
      expect(getStoredAuth()).not.toBeNull();

      // Tab close: sessionStorage is wiped by the browser.
      vi.stubGlobal('sessionStorage', createInMemoryStorage());

      expect(getStoredAuth()).toBeNull();
    });
  });
});

describe('hasStoredAuth', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createInMemoryStorage());
    vi.stubGlobal('sessionStorage', createInMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when a marker exists in localStorage', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'user-1' }));
    expect(hasStoredAuth()).toBe(true);
  });

  it('returns true when a marker exists in sessionStorage', () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'user-1' }));
    expect(hasStoredAuth()).toBe(true);
  });

  it('returns false when no marker exists', () => {
    expect(hasStoredAuth()).toBe(false);
  });

  it('returns false when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    });
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    });
    expect(hasStoredAuth()).toBe(false);
  });
});
