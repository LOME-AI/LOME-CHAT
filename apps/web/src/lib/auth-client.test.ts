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
// predicate (with a zero delay to keep tests fast) so retry behavior is
// exercised for real rather than stubbed away.
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

// Create a real in-memory storage implementation (test-setup.ts mocks localStorage with stubs)
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

  beforeEach(() => {
    vi.clearAllMocks();
    // Override the global localStorage mock from test-setup.ts with a working implementation
    vi.stubGlobal('localStorage', createInMemoryStorage());
    vi.stubGlobal('sessionStorage', createInMemoryStorage());
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
    it('stores export key in sessionStorage when keepSignedIn is false', () => {
      persistExportKey(testExportKey, testUserId, false);

      expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('stores export key in localStorage when keepSignedIn is true', () => {
      persistExportKey(testExportKey, testUserId, true);

      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('stores export key as base64 with userId', () => {
      persistExportKey(testExportKey, testUserId, false);

      const stored = sessionStorage.getItem(STORAGE_KEY);
      expect(stored).not.toBeNull();
      if (!stored) throw new Error('Expected stored value');

      const parsed = JSON.parse(stored) as { kek: string; userId: string };
      expect(parsed.userId).toBe(testUserId);
      expect(parsed.kek).toBe(toBase64(testExportKey));
    });

    it('overwrites existing data in the same storage', () => {
      persistExportKey(testExportKey, 'first-user', false);
      persistExportKey(testExportKey, 'second-user', false);

      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (!stored) throw new Error('Expected stored value');
      const parsed = JSON.parse(stored) as { userId: string };
      expect(parsed.userId).toBe('second-user');
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
  });

  describe('getStoredAuth', () => {
    it('returns null when no auth is stored', () => {
      const result = getStoredAuth();

      expect(result).toBeNull();
    });

    it('returns data from localStorage if present', () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const result = getStoredAuth();

      expect(result).not.toBeNull();
      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe(testUserId);
    });

    it('returns data from sessionStorage if localStorage is empty', () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const result = getStoredAuth();

      expect(result).not.toBeNull();
      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe(testUserId);
    });

    it('prefers localStorage over sessionStorage when both exist', () => {
      const localData = { kek: toBase64(testExportKey), userId: 'local-user' };
      const sessionData = { kek: toBase64(testExportKey), userId: 'session-user' };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(localData));
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(sessionData));

      const result = getStoredAuth();

      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe('local-user');
    });

    it('returns export key as Uint8Array', () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const result = getStoredAuth();

      if (!result) throw new Error('Expected result');
      expect(result.kek).toBeInstanceOf(Uint8Array);
      expect(result.kek).toEqual(testExportKey);
    });

    it('returns null when stored auth is malformed JSON', () => {
      localStorage.setItem(STORAGE_KEY, 'not-valid-json');

      const result = getStoredAuth();

      expect(result).toBeNull();
    });

    it('clears the corrupt blob from storage when stored auth is malformed', () => {
      localStorage.setItem(STORAGE_KEY, 'not-valid-json');

      getStoredAuth();

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('restoreSession', () => {
    it('returns null when no auth is stored', async () => {
      const result = await restoreSession();

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetches wrapped key from server', async () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({
          user: {
            id: testUserId,
            email: 'test@example.com',
            username: 'test',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: true,
          },
          passwordWrappedPrivateKey: toBase64(testPrivateKey),
          publicKey: toBase64(new Uint8Array([1, 2, 3])),
        }),
      };
      mockFetch.mockResolvedValue(mockResponse as unknown as Response);
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
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({
          user: {
            id: testUserId,
            email: 'test@example.com',
            username: 'test',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: true,
          },
          passwordWrappedPrivateKey: toBase64(testPrivateKey),
          publicKey: toBase64(new Uint8Array([1, 2, 3])),
        }),
      };
      mockFetch.mockResolvedValue(mockResponse as unknown as Response);
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
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({
          user: {
            id: testUserId,
            email: 'test@example.com',
            username: 'test',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: true,
          },
          passwordWrappedPrivateKey: toBase64(testPrivateKey),
          publicKey: toBase64(new Uint8Array([1, 2, 3])),
        }),
      };
      mockFetch.mockResolvedValue(mockResponse as unknown as Response);
      mockUnwrapAccountKey.mockReturnValue(testPrivateKey);

      const result = await restoreSession();

      expect(result).not.toBeNull();
      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe(testUserId);
      expect(result.privateKey).toEqual(testPrivateKey);
    });

    it('calls unwrapAccountKeyWithPassword with export key and wrapped private key', async () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const wrappedKey = new Uint8Array([100, 101, 102]);
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({
          user: {
            id: testUserId,
            email: 'test@example.com',
            username: 'test',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: true,
          },
          passwordWrappedPrivateKey: toBase64(wrappedKey),
          publicKey: toBase64(new Uint8Array([1, 2, 3])),
        }),
      };
      mockFetch.mockResolvedValue(mockResponse as unknown as Response);
      mockUnwrapAccountKey.mockReturnValue(testPrivateKey);

      await restoreSession();

      expect(mockUnwrapAccountKey).toHaveBeenCalledWith(testExportKey, wrappedKey);
    });

    it('clears storage and returns null on 401 auth rejection', async () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const mockResponse = {
        ok: false,
        status: 401,
        headers: new Headers(),
      };
      mockFetch.mockResolvedValue(mockResponse as unknown as Response);

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clears storage and returns null on 403 forbidden', async () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const mockResponse = {
        ok: false,
        status: 403,
        headers: new Headers(),
      };
      mockFetch.mockResolvedValue(mockResponse as unknown as Response);

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('preserves storage on 500 server error', async () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const mockResponse = {
        ok: false,
        status: 500,
        headers: new Headers(),
      };
      mockFetch.mockResolvedValue(mockResponse as unknown as Response);

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('preserves storage on 503 service unavailable', async () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const mockResponse = {
        ok: false,
        status: 503,
        headers: new Headers(),
      };
      mockFetch.mockResolvedValue(mockResponse as unknown as Response);

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('retries a transient /me failure and restores the session', async () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const successResponse = {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({
          user: {
            id: testUserId,
            email: 'test@example.com',
            username: 'test',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: true,
          },
          passwordWrappedPrivateKey: toBase64(testPrivateKey),
          publicKey: toBase64(new Uint8Array([1, 2, 3])),
        }),
      };
      // First /me is dropped (navigation/network blip surfaces as a TypeError);
      // the app-wide retry policy re-attempts and the second call succeeds.
      mockFetch
        .mockRejectedValueOnce(new TypeError('Load failed'))
        .mockResolvedValueOnce(successResponse as unknown as Response);
      mockUnwrapAccountKey.mockReturnValue(testPrivateKey);

      const result = await restoreSession();

      expect(result).not.toBeNull();
      expect(result?.userId).toBe(testUserId);
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('clears storage and returns null when unwrap fails', async () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({
          user: {
            id: testUserId,
            email: 'test@example.com',
            username: 'test',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: true,
          },
          passwordWrappedPrivateKey: toBase64(testPrivateKey),
          publicKey: toBase64(new Uint8Array([1, 2, 3])),
        }),
      };
      mockFetch.mockResolvedValue(mockResponse as unknown as Response);
      mockUnwrapAccountKey.mockImplementation(() => {
        throw new Error('Unwrap failed');
      });

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('returns null but preserves storage when fetch throws', async () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('returns customInstructionsEncrypted from server response', async () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({
          user: {
            id: testUserId,
            email: 'test@example.com',
            username: 'test',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: true,
          },
          passwordWrappedPrivateKey: toBase64(testPrivateKey),
          publicKey: toBase64(new Uint8Array([1, 2, 3])),
          customInstructionsEncrypted: 'encrypted-blob-base64',
        }),
      };
      mockFetch.mockResolvedValue(mockResponse as unknown as Response);
      mockUnwrapAccountKey.mockReturnValue(testPrivateKey);

      const result = await restoreSession();

      expect(result).not.toBeNull();
      if (!result) throw new Error('Expected result');
      expect(result.customInstructionsEncrypted).toBe('encrypted-blob-base64');
    });

    it('returns null customInstructionsEncrypted when not set on server', async () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({
          user: {
            id: testUserId,
            email: 'test@example.com',
            username: 'test',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: true,
          },
          passwordWrappedPrivateKey: toBase64(testPrivateKey),
          publicKey: toBase64(new Uint8Array([1, 2, 3])),
          customInstructionsEncrypted: null,
        }),
      };
      mockFetch.mockResolvedValue(mockResponse as unknown as Response);
      mockUnwrapAccountKey.mockReturnValue(testPrivateKey);

      const result = await restoreSession();

      expect(result).not.toBeNull();
      if (!result) throw new Error('Expected result');
      expect(result.customInstructionsEncrypted).toBeNull();
    });

    it('clears storage and returns null when passwordWrappedPrivateKey is missing', async () => {
      const data = { kek: toBase64(testExportKey), userId: testUserId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({
          user: {
            id: testUserId,
            email: 'test@example.com',
            username: 'test',
            emailVerified: true,
            totpEnabled: false,
            hasAcknowledgedPhrase: true,
          },
          // No passwordWrappedPrivateKey
        }),
      };
      mockFetch.mockResolvedValue(mockResponse as unknown as Response);

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
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

  it('returns true when stored auth exists in localStorage', () => {
    const kek = new Uint8Array(32).fill(1);
    persistExportKey(kek, 'user-1', true);
    expect(hasStoredAuth()).toBe(true);
  });

  it('returns true when stored auth exists in sessionStorage', () => {
    const kek = new Uint8Array(32).fill(1);
    persistExportKey(kek, 'user-1', false);
    expect(hasStoredAuth()).toBe(true);
  });

  it('returns false when no stored auth exists', () => {
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
