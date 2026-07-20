import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { redirect } from '@tanstack/react-router';
import { SMART_MODEL_ID } from '@hushbox/shared';
import {
  createOpaqueClient,
  startLogin,
  finishLogin,
  startRegistration,
  finishRegistration,
  createAccount,
  unwrapAccountKeyWithPassword,
  rewrapAccountKeyForPasswordChange,
  recoverAccountFromMnemonic,
  decryptTextFromEpoch,
} from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import {
  useAuthStore,
  useSession,
  signIn,
  signUp,
  changePassword,
  resetPasswordViaRecovery,
  disable2FAInit,
  disable2FAFinish,
  signOutAndClearCache,
  clearLocalAuthState,
  authClient,
  initAuth,
  requireAuth,
  resetInitPromise,
  parseErrorMessage,
  type UserData,
} from './auth';
import { urlFromFetchInput } from '@/test-utils/fetch-mock';
import { decryptedCache } from '@/lib/decrypted-message-cache';

function defined<T>(value: T | null | undefined, label = 'value'): NonNullable<T> {
  if (value == null) throw new Error(`Expected ${label} to be defined`);
  return value;
}

const testUser: UserData = {
  id: 'user-123',
  email: 'test@example.com',
  username: 'test_user',
  emailVerified: true,
  totpEnabled: false,
  hasAcknowledgedPhrase: true,
};

const testUser2FA: UserData = {
  ...testUser,
  totpEnabled: true,
};

vi.mock('@tanstack/react-router', () => ({
  redirect: vi.fn((options) => options),
}));

vi.mock('zustand/react/shallow', async () => {
  const actual =
    await vi.importActual<typeof import('zustand/react/shallow')>('zustand/react/shallow');
  return actual;
});

const { mockQueryClientClear, mockQueryClientFetchQuery } = vi.hoisted(() => ({
  mockQueryClientClear: vi.fn(),
  // Delegate to the queryFn so /me still hits the (mocked) fetch; retry behavior
  // itself is covered in auth-client.test.ts against a real QueryClient.
  mockQueryClientFetchQuery: vi.fn((options: { queryFn: () => unknown }) => options.queryFn()),
}));
vi.mock('@/providers/query-provider', () => ({
  queryClient: {
    clear: mockQueryClientClear,
    fetchQuery: mockQueryClientFetchQuery,
  },
  registerSessionRevocationClearer: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    getApiUrl: () => 'http://localhost:8787',
  };
});

vi.mock('./auth-client.js', () => ({
  STORAGE_KEY: 'hushbox_auth_kek',
  persistExportKey: vi.fn(),
  getStoredAuth: vi.fn(),
  hasStoredAuth: vi.fn(),
  clearStoredAuth: vi.fn(),
  restoreSession: vi.fn(),
}));

vi.mock('./link-guest-auth.js', () => ({
  getLinkGuestAuth: vi.fn(() => null),
}));

vi.mock('@hushbox/crypto', () => ({
  OPAQUE_SERVER_IDENTIFIER: 'opaque-server-v1',
  createOpaqueClient: vi.fn(() => ({ client: 'mock' })),
  startLogin: vi.fn(() => Promise.resolve({ ke1: [1, 2, 3] })),
  finishLogin: vi.fn(() =>
    Promise.resolve({
      ke3: [4, 5, 6],
      sessionKey: [7, 8, 9],
      exportKey: [16, 17, 18],
    })
  ),
  startRegistration: vi.fn(() => Promise.resolve({ serialized: [10, 11, 12] })),
  finishRegistration: vi.fn(() =>
    Promise.resolve({
      record: [13, 14, 15],
      exportKey: [16, 17, 18],
    })
  ),
  createAccount: vi.fn(() =>
    Promise.resolve({
      publicKey: new Uint8Array([43, 44, 45]),
      passwordWrappedPrivateKey: new Uint8Array([50, 51, 52]),
      recoveryWrappedPrivateKey: new Uint8Array([53, 54, 55]),
      recoveryPhrase: 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
    })
  ),
  unwrapAccountKeyWithPassword: vi.fn(() => new Uint8Array([60, 61, 62])),
  rewrapAccountKeyForPasswordChange: vi.fn(() => new Uint8Array([70, 71, 72])),
  recoverAccountFromMnemonic: vi.fn(() => Promise.resolve(new Uint8Array([80, 81, 82]))),
  decryptTextFromEpoch: vi.fn(() => 'decrypted instructions'),
  getPublicKeyFromPrivate: vi.fn(() => new Uint8Array([90, 91, 92])),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: vi.fn((_string: string) => new Uint8Array([31, 32, 33])),
    toBase64: vi.fn(() => 'base64string'),
  };
});

import {
  persistExportKey,
  getStoredAuth,
  hasStoredAuth,
  clearStoredAuth,
  restoreSession,
} from './auth-client.js';
import { registerSessionRevocationClearer } from '@/providers/query-provider';
import { getLinkGuestAuth } from './link-guest-auth.js';

const mockedGetLinkGuestAuth = vi.mocked(getLinkGuestAuth);

// Captured at module-eval time (before any beforeEach `clearAllMocks`): auth.ts
// registers its revocation clearer once, as an import side effect.
const registeredRevocationClearer = vi.mocked(registerSessionRevocationClearer).mock.calls[0]?.[0];

const originalLocation = globalThis.location;

describe('auth', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: null,
      privateKey: null,
      isLoading: true,
      isAuthenticated: false,
    });
    resetInitPromise();
    decryptedCache.clear();
    vi.clearAllMocks();

    globalThis.fetch = vi.fn();
    // clearLocalAuthState forces a hard reload; getApiUrl is mocked so nothing
    // else reads location. Stub reload so the reload does not throw under jsdom.
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: { href: 'http://localhost/', origin: 'http://localhost', reload: vi.fn() },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  describe('parseErrorMessage', () => {
    it('returns friendly message when code field is present', () => {
      expect(parseErrorMessage({ code: 'AUTH_FAILED' })).toBe(
        'Incorrect username, email, or password. Please try again.'
      );
    });

    it('returns friendly message for known code', () => {
      expect(parseErrorMessage({ code: 'NOT_FOUND' })).toBe(
        "The item you're looking for doesn't exist."
      );
    });

    it('returns generic fallback for unknown code', () => {
      expect(parseErrorMessage({ code: 'TOTALLY_UNKNOWN' })).toBe(
        'Something went wrong. Please try again.'
      );
    });

    it('returns generic fallback when code field is missing', () => {
      expect(parseErrorMessage({ success: false })).toBe(
        'Something went wrong. Please try again later.'
      );
    });

    it('returns generic fallback for non-object body', () => {
      expect(parseErrorMessage(null)).toBe('Something went wrong. Please try again later.');
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
      expect(parseErrorMessage(undefined)).toBe('Something went wrong. Please try again later.');
      expect(parseErrorMessage('some string')).toBe(
        'Something went wrong. Please try again later.'
      );
      expect(parseErrorMessage(42)).toBe('Something went wrong. Please try again later.');
    });
  });

  describe('useAuthStore', () => {
    it('should have correct initial state', () => {
      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.privateKey).toBeNull();
      expect(state.isLoading).toBe(true);
      expect(state.isAuthenticated).toBe(false);
    });

    it('should set user and isAuthenticated to true when user is provided', () => {
      useAuthStore.getState().setUser(testUser);

      const state = useAuthStore.getState();
      expect(state.user).toEqual(testUser);
      expect(state.isAuthenticated).toBe(true);
    });

    it('should clear user and set isAuthenticated to false when user is null', () => {
      useAuthStore.setState({ user: testUser, isAuthenticated: true });

      useAuthStore.getState().setUser(null);

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
    });

    it('should store privateKey when setPrivateKey is called', () => {
      const privateKey = new Uint8Array([5, 6, 7, 8]);
      useAuthStore.getState().setPrivateKey(privateKey);

      const state = useAuthStore.getState();
      expect(state.privateKey).toEqual(privateKey);
    });

    it('should toggle loading state with setLoading', () => {
      useAuthStore.getState().setLoading(false);
      expect(useAuthStore.getState().isLoading).toBe(false);

      useAuthStore.getState().setLoading(true);
      expect(useAuthStore.getState().isLoading).toBe(true);
    });

    it('should zero privateKey buffer and clear all state on clear', () => {
      const privateKey = new Uint8Array([5, 6, 7, 8]);
      useAuthStore.setState({
        user: testUser,
        privateKey,
        isAuthenticated: true,
        isLoading: true,
      });

      useAuthStore.getState().clear();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.privateKey).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(false);
      expect(privateKey[0]).toBe(0);
      expect(privateKey[1]).toBe(0);
      expect(privateKey[2]).toBe(0);
      expect(privateKey[3]).toBe(0);
    });

    it('should handle clear when privateKey is null', () => {
      useAuthStore.setState({
        user: testUser,
        privateKey: null,
        isAuthenticated: true,
      });

      expect(() => {
        useAuthStore.getState().clear();
      }).not.toThrow();
      expect(useAuthStore.getState().user).toBeNull();
    });
  });

  describe('useSession', () => {
    it('should be exported as a function', () => {
      expect(typeof useSession).toBe('function');
    });

    it('returns session data when user is authenticated', () => {
      useAuthStore.setState({ user: testUser, isLoading: false, isAuthenticated: true });

      const { result } = renderHook(() => useSession());

      expect(result.current.data).toEqual({ user: testUser, session: { id: testUser.id } });
      expect(result.current.isPending).toBe(false);
    });

    it('returns null data when no user', () => {
      useAuthStore.setState({ user: null, isLoading: false, isAuthenticated: false });

      const { result } = renderHook(() => useSession());

      expect(result.current.data).toBeNull();
      expect(result.current.isPending).toBe(false);
    });

    it('returns isPending true when loading', () => {
      useAuthStore.setState({ user: null, isLoading: true, isAuthenticated: false });

      const { result } = renderHook(() => useSession());

      expect(result.current.isPending).toBe(true);
    });

    it('masks session when link guest auth is active', () => {
      useAuthStore.setState({ user: testUser, isLoading: false, isAuthenticated: true });
      mockedGetLinkGuestAuth.mockReturnValue('some-link-public-key');

      const { result } = renderHook(() => useSession());

      expect(result.current.data).toBeNull();
      expect(result.current.isPending).toBe(false);
    });

    it('returns normal session when link guest auth is not active', () => {
      useAuthStore.setState({ user: testUser, isLoading: false, isAuthenticated: true });
      mockedGetLinkGuestAuth.mockReturnValue(null);

      const { result } = renderHook(() => useSession());

      expect(result.current.data).toEqual({ user: testUser, session: { id: testUser.id } });
      expect(result.current.isPending).toBe(false);
    });
  });

  describe('signIn.email', () => {
    const loginParams = {
      identifier: 'test@example.com',
      password: 'password123',
    };

    it('routes OPAQUE requests through the header shim, preserving the byte-array body', async () => {
      vi.mocked(fetch).mockImplementation((input) => {
        const url = urlFromFetchInput(input);
        if (url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ke2: [1, 2, 3] }),
          } as Response);
        }
        if (url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                passwordWrappedPrivateKey: 'wrappedKey123',
              }),
          } as Response);
        }
        if (url.includes('/auth/me')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ user: testUser }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await signIn.email(loginParams);

      const initCall = defined(
        vi.mocked(fetch).mock.calls.find((c) => urlFromFetchInput(c[0]).includes('/login/init')),
        'login/init fetch call'
      );
      // The version gate + platform attribution headers ride only the shared
      // header-injecting fetch; a raw fetch would carry neither and could not
      // receive the 426 upgrade gate.
      const headers = new Headers(initCall[1]?.headers);
      expect(headers.get('X-App-Version')).toBeTruthy();
      expect(headers.get('X-HushBox-Platform')).toBeTruthy();
      // The OPAQUE byte-array body (`ke1`) must pass through the shim unchanged.
      const parsed = JSON.parse(initCall[1]?.body as string) as { ke1: number[] };
      expect(parsed.ke1).toEqual([1, 2, 3]);
    });

    it('should successfully login without 2FA', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(unwrapAccountKeyWithPassword).mockReturnValue(mockPrivateKey);

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                email: 'test@example.com',
                passwordWrappedPrivateKey: 'wrappedKey123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/auth/me')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                user: testUser,
                passwordWrappedPrivateKey: 'wrappedKey123',
                publicKey: 'pubKey123',
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);

      expect(result.error).toBeUndefined();
      expect(createOpaqueClient).toHaveBeenCalled();
      expect(startLogin).toHaveBeenCalled();
      expect(finishLogin).toHaveBeenCalled();
      expect(unwrapAccountKeyWithPassword).toHaveBeenCalled();
      expect(persistExportKey).toHaveBeenCalledWith(expect.any(Uint8Array), 'user-123', false);
      expect(useAuthStore.getState().privateKey).toEqual(mockPrivateKey);
      expect(useAuthStore.getState().user).toEqual(testUser);
    });

    it('normalizes username identifier before sending to API', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);
      vi.mocked(unwrapAccountKeyWithPassword).mockReturnValue(mockPrivateKey);

      let capturedInitBody = '';
      let capturedFinishBody = '';

      vi.mocked(fetch).mockImplementation((url, options) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          capturedInitBody = options!.body as string;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ke2: [1, 2, 3] }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          capturedFinishBody = options!.body as string;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                email: 'test@example.com',
                passwordWrappedPrivateKey: 'wrappedKey123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/auth/me')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                user: testUser,
                passwordWrappedPrivateKey: 'wrappedKey123',
                publicKey: 'pubKey123',
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await signIn.email({ identifier: 'John Smith', password: 'password123' });

      expect(capturedInitBody).toContain('john_smith');
      expect(capturedInitBody).not.toContain('John Smith');
      expect(capturedFinishBody).toContain('john_smith');
    });

    it('does not normalize email identifiers', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);
      vi.mocked(unwrapAccountKeyWithPassword).mockReturnValue(mockPrivateKey);

      let capturedInitBody = '';

      vi.mocked(fetch).mockImplementation((url, options) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          capturedInitBody = options!.body as string;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ke2: [1, 2, 3] }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                email: 'User@Example.com',
                passwordWrappedPrivateKey: 'wrappedKey123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/auth/me')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                user: { ...testUser, email: 'User@Example.com' },
                passwordWrappedPrivateKey: 'wrappedKey123',
                publicKey: 'pubKey123',
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await signIn.email({ identifier: 'User@Example.com', password: 'password123' });

      expect(capturedInitBody).toContain('User@Example.com');
    });

    it('should persist export key with keepSignedIn flag', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(unwrapAccountKeyWithPassword).mockReturnValue(mockPrivateKey);

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                email: 'test@example.com',
                passwordWrappedPrivateKey: 'wrappedKey123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/auth/me')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                user: testUser,
                passwordWrappedPrivateKey: 'wrappedKey123',
                publicKey: 'pubKey123',
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await signIn.email({ ...loginParams, keepSignedIn: true });

      expect(persistExportKey).toHaveBeenCalledWith(expect.any(Uint8Array), 'user-123', true);
    });

    it('should return error when login init fails', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'AUTH_FAILED' }),
      } as Response);

      const result = await signIn.email(loginParams);

      expect(result.error).toEqual({
        message: 'Incorrect username, email, or password. Please try again.',
        code: 'AUTH_FAILED',
      });
    });

    it('should return error when login finish fails', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'NO_PENDING_LOGIN' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);

      expect(result.error).toEqual({
        message: 'Your login attempt expired. Please try again.',
        code: 'NO_PENDING_LOGIN',
      });
    });

    it('should handle 2FA requirement and return verifyTOTP callback', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                requires2FA: true,
                userId: 'user-123',
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);

      expect(result.requires2FA).toBe(true);
      expect(result.verifyTOTP).toBeDefined();
      expect(typeof result.verifyTOTP).toBe('function');
    });

    it('should successfully verify 2FA code', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(unwrapAccountKeyWithPassword).mockReturnValue(mockPrivateKey);

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                requires2FA: true,
                userId: 'user-123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/2fa/verify')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                passwordWrappedPrivateKey: 'wrappedKey123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/auth/me')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                user: testUser2FA,
                passwordWrappedPrivateKey: 'wrappedKey123',
                publicKey: 'pubKey123',
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);
      expect(result.verifyTOTP).toBeDefined();

      if (!result.verifyTOTP) throw new Error('Expected verifyTOTP callback');
      const verifyResult = await result.verifyTOTP('123456');

      expect(verifyResult.success).toBe(true);
      expect(unwrapAccountKeyWithPassword).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        expect.any(Uint8Array)
      );
      expect(persistExportKey).toHaveBeenCalledWith(expect.any(Uint8Array), 'user-123', false);
      expect(useAuthStore.getState().privateKey).toEqual(mockPrivateKey);
      expect(useAuthStore.getState().user).toEqual(testUser2FA);
    });

    it('should return error when 2FA verification fails', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                requires2FA: true,
                userId: 'user-123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/2fa/verify')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'INVALID_TOTP_CODE' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);
      if (!result.verifyTOTP) throw new Error('Expected verifyTOTP callback');
      const verifyResult = await result.verifyTOTP('000000');

      expect(verifyResult.success).toBe(false);
      expect(verifyResult.error).toBe('That code is incorrect or has expired. Please try again.');
    });

    it('should handle 2FA verification network error', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                requires2FA: true,
                userId: 'user-123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/2fa/verify')) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);
      if (!result.verifyTOTP) throw new Error('Expected verifyTOTP callback');
      const verifyResult = await result.verifyTOTP('123456');

      expect(verifyResult.success).toBe(false);
      expect(verifyResult.error).toBe('Two-factor verification failed. Please try again.');
    });

    it('should return error when passwordWrappedPrivateKey is missing', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                email: 'test@example.com',
                // Missing passwordWrappedPrivateKey
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);

      expect(result.error).toEqual({
        message: 'Your account encryption is not configured. Please contact support.',
      });
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await signIn.email(loginParams);

      expect(result.error).toEqual({
        message: 'Login failed. Please check your credentials and try again.',
      });
    });

    it('fails the login and never fabricates account flags when /me fails', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(unwrapAccountKeyWithPassword).mockReturnValue(mockPrivateKey);

      vi.mocked(fetch).mockImplementation((input) => {
        const url = urlFromFetchInput(input);
        if (url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                email: 'test@example.com',
                passwordWrappedPrivateKey: 'wrappedKey123',
              }),
          } as Response);
        }
        if (url.includes('/auth/me')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            headers: new Headers(),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);

      // A transient /me failure must error the login, not silently downgrade
      // real account flags to a fabricated emailVerified/totpEnabled/
      // hasAcknowledgedPhrase = false.
      expect(result.error).toBeDefined();
      expect(useAuthStore.getState().user).toBeNull();
    });

    it('should return LOGIN_FAILED on network error', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await signIn.email(loginParams);

      expect(result.error?.message).toBe(
        'Login failed. Please check your credentials and try again.'
      );
    });
  });

  describe('signUp.email', () => {
    const signupParams = {
      username: 'test_user',
      email: 'test@example.com',
      password: 'password123',
    };

    it('should successfully register a new user', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/register/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                registrationResponse: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/register/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signUp.email(signupParams);

      expect(result.error).toBeUndefined();
      expect(createOpaqueClient).toHaveBeenCalled();
      expect(startRegistration).toHaveBeenCalled();
      expect(finishRegistration).toHaveBeenCalled();
      expect(createAccount).toHaveBeenCalled();
    });

    it('should return error when registration init fails', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'CONFLICT' }),
      } as Response);

      const result = await signUp.email(signupParams);

      expect(result.error).toEqual({
        message: 'This action conflicts with the current state. Please refresh and try again.',
      });
    });

    it('should return error when registration finish fails', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/register/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                registrationResponse: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/register/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'REGISTRATION_FAILED' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signUp.email(signupParams);

      expect(result.error).toEqual({ message: 'Registration failed. Please try again.' });
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await signUp.email(signupParams);

      expect(result.error).toEqual({ message: 'Registration failed. Please try again.' });
    });

    it('should send correct crypto fields to register/finish endpoint', async () => {
      let capturedBody: string | null = null;

      vi.mocked(fetch).mockImplementation((url, init) => {
        if (typeof url === 'string' && url.includes('/register/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                registrationResponse: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/register/finish')) {
          if (!init) throw new Error('Expected init');
          capturedBody = init.body as string;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await signUp.email(signupParams);

      const parsed = JSON.parse(defined(capturedBody));
      expect(parsed).toHaveProperty('email', signupParams.email);
      expect(parsed).not.toHaveProperty('username');
      expect(parsed).toHaveProperty('registrationRecord');
      expect(parsed).toHaveProperty('accountPublicKey');
      expect(parsed).toHaveProperty('passwordWrappedPrivateKey');
      expect(parsed).toHaveProperty('recoveryWrappedPrivateKey');
      expect(parsed).not.toHaveProperty('passwordSalt');
      expect(parsed).not.toHaveProperty('encryptedDekPassword');
      expect(parsed).not.toHaveProperty('privateKeyWrapped');

      expect(createAccount).toHaveBeenCalled();
      expect(toBase64).toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    const currentPassword = 'oldPassword123';
    const newPassword = 'newPassword456';

    beforeEach(() => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);
      useAuthStore.setState({ privateKey: mockPrivateKey });
    });

    it('should successfully change password', async () => {
      const mockNewWrappedKey = new Uint8Array([70, 71, 72]);

      vi.mocked(rewrapAccountKeyForPasswordChange).mockReturnValue(mockNewWrappedKey);
      vi.mocked(getStoredAuth).mockReturnValue({
        userId: 'user-123',
        keepSignedIn: false,
      });

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/change-password/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
                newRegistrationResponse: [4, 5, 6],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/change-password/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(true);
      expect(createOpaqueClient).toHaveBeenCalledTimes(2);
      expect(startLogin).toHaveBeenCalled();
      expect(startRegistration).toHaveBeenCalled();
      expect(finishLogin).toHaveBeenCalled();
      expect(finishRegistration).toHaveBeenCalled();
      expect(rewrapAccountKeyForPasswordChange).toHaveBeenCalled();
      expect(persistExportKey).toHaveBeenCalledWith(expect.any(Uint8Array), 'user-123', false);
    });

    it('should persist export key with the keepSignedIn flag from the stored marker', async () => {
      const mockNewWrappedKey = new Uint8Array([70, 71, 72]);

      vi.mocked(rewrapAccountKeyForPasswordChange).mockReturnValue(mockNewWrappedKey);
      vi.mocked(getStoredAuth).mockReturnValue({
        userId: 'user-123',
        keepSignedIn: true,
      });

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/change-password/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
                newRegistrationResponse: [4, 5, 6],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/change-password/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await changePassword(currentPassword, newPassword);

      expect(persistExportKey).toHaveBeenCalledWith(expect.any(Uint8Array), 'user-123', true);
    });

    it('should return error when change-password init fails', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'AUTH_FAILED' }),
      } as Response);

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Incorrect username, email, or password. Please try again.');
    });

    it('should return error when change-password finish fails', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/change-password/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
                newRegistrationResponse: [4, 5, 6],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/change-password/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'NO_PENDING_STEP_UP' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Your confirmation expired. Please try again.');
    });

    it('should return error when privateKey is not available', async () => {
      useAuthStore.setState({ privateKey: null });

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/change-password/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
                newRegistrationResponse: [4, 5, 6],
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Your encryption key is unavailable. Please log out and log back in.'
      );
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Password change failed. Please try again.');
    });

    it('should return error when rewrapAccountKeyForPasswordChange throws', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/change-password/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
                newRegistrationResponse: [4, 5, 6],
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      vi.mocked(rewrapAccountKeyForPasswordChange).mockImplementation(() => {
        throw new Error('Rewrap failed');
      });

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Password change failed. Please try again.');
    });

    it('should not persist export key when no stored auth exists', async () => {
      const mockNewWrappedKey = new Uint8Array([70, 71, 72]);

      vi.mocked(rewrapAccountKeyForPasswordChange).mockReturnValue(mockNewWrappedKey);
      vi.mocked(getStoredAuth).mockReturnValue(null);

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/change-password/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
                newRegistrationResponse: [4, 5, 6],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/change-password/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(true);
      expect(persistExportKey).not.toHaveBeenCalled();
    });
  });

  describe('signOutAndClearCache', () => {
    it('should logout, clear auth, clear store, and clear query cache', async () => {
      const mockPrivateKey = new Uint8Array([1, 2, 3, 4]);
      useAuthStore.setState({
        user: testUser,
        privateKey: mockPrivateKey,
        isAuthenticated: true,
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
      } as Response);

      await signOutAndClearCache();

      const call = vi
        .mocked(fetch)
        .mock.calls.find((c) => urlFromFetchInput(c[0]).endsWith('/auth/logout'));
      expect(call).toBeDefined();
      const init = call![1]!;
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      expect(clearStoredAuth).toHaveBeenCalled();
      expect(mockQueryClientClear).toHaveBeenCalled();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.privateKey).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(mockPrivateKey[0]).toBe(0);
    });

    it('should throw if logout request fails', async () => {
      useAuthStore.setState({
        user: testUser,
        privateKey: new Uint8Array([1, 2, 3, 4]),
        isAuthenticated: true,
      });

      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      await expect(signOutAndClearCache()).rejects.toThrow('Network error');
    });

    it('should reset model selections on sign out', async () => {
      const { useModelStore } = await import('@/stores/model');

      useModelStore.setState({
        selections: {
          text: [
            { id: 'model-a', name: 'Model A' },
            { id: 'model-b', name: 'Model B' },
            { id: 'model-c', name: 'Model C' },
          ],
          image: [{ id: 'imagen', name: 'Imagen' }],
          audio: [],
          video: [{ id: 'veo', name: 'Veo' }],
        },
      });

      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      await signOutAndClearCache();

      const { selections } = useModelStore.getState();
      expect(selections.text).toHaveLength(1);
      expect(selections.text[0]?.id).toBe(SMART_MODEL_ID);
      expect(selections.image).toEqual([]);
      expect(selections.video).toEqual([]);
    });

    it('drops the decrypted active document on sign out', async () => {
      const { useDocumentStore } = await import('@/stores/document');
      useDocumentStore.getState().setActiveDocument({
        id: 'doc-1',
        type: 'code',
        title: 'Secret',
        content: 'decrypted secret content',
        lineCount: 1,
      });

      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      await signOutAndClearCache();

      const documentState = useDocumentStore.getState();
      expect(documentState.activeDocument).toBeNull();
      expect(documentState.activeDocumentId).toBeNull();
      expect(documentState.isPanelOpen).toBe(false);
    });
  });

  describe('clearLocalAuthState', () => {
    it('clears auth, query, and model state without calling the logout endpoint', async () => {
      const mockPrivateKey = new Uint8Array([1, 2, 3, 4]);
      useAuthStore.setState({
        user: testUser,
        privateKey: mockPrivateKey,
        isAuthenticated: true,
      });
      const { useModelStore } = await import('@/stores/model');
      useModelStore.setState({
        selections: {
          text: [{ id: 'model-a', name: 'Model A' }],
          image: [{ id: 'imagen', name: 'Imagen' }],
          audio: [],
          video: [],
        },
      });

      clearLocalAuthState();

      expect(fetch).not.toHaveBeenCalled();
      expect(clearStoredAuth).toHaveBeenCalled();
      expect(mockQueryClientClear).toHaveBeenCalled();
      const auth = useAuthStore.getState();
      expect(auth.user).toBeNull();
      expect(auth.privateKey).toBeNull();
      expect(auth.isAuthenticated).toBe(false);
      expect(mockPrivateKey[0]).toBe(0);
      const { selections } = useModelStore.getState();
      expect(selections.text[0]?.id).toBe(SMART_MODEL_ID);
      expect(selections.image).toEqual([]);
    });

    it('drops the decrypted active document', async () => {
      const { useDocumentStore } = await import('@/stores/document');
      useDocumentStore.getState().setActiveDocument({
        id: 'doc-2',
        type: 'code',
        title: 'Secret',
        content: 'decrypted secret content',
        lineCount: 1,
      });

      clearLocalAuthState();

      const documentState = useDocumentStore.getState();
      expect(documentState.activeDocument).toBeNull();
      expect(documentState.activeDocumentId).toBeNull();
      expect(documentState.isPanelOpen).toBe(false);
    });

    it('empties the module decrypted-message plaintext cache', () => {
      decryptedCache.set('conv-1:msg-1', { epochNumber: 0, content: 'secret plaintext' });

      clearLocalAuthState();

      expect(decryptedCache.size).toBe(0);
    });

    it('forces a hard page reload so module plaintext is dropped from memory', () => {
      clearLocalAuthState();

      expect(globalThis.location.reload).toHaveBeenCalledOnce();
    });
  });

  describe('initAuth', () => {
    it('should implement singleton pattern and only run once', async () => {
      vi.mocked(getStoredAuth).mockReturnValue(null);

      const promise1 = initAuth();
      const promise2 = initAuth();
      const promise3 = initAuth();

      expect(promise1).toBe(promise2);
      expect(promise2).toBe(promise3);

      await promise1;

      expect(getStoredAuth).toHaveBeenCalledTimes(1);
    });

    it('should set isLoading to false when no stored auth exists', async () => {
      vi.mocked(getStoredAuth).mockReturnValue(null);

      await initAuth();

      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('should purge the device key via clearStoredAuth on the no-marker init path', async () => {
      vi.mocked(getStoredAuth).mockReturnValue(null);

      await initAuth();

      // Session mode leaves the device key + ciphertext in IndexedDB with no
      // marker; the no-marker branch purges them (clearStoredAuth →
      // clearDeviceKeyStore) on this next load.
      expect(clearStoredAuth).toHaveBeenCalled();
      expect(restoreSession).not.toHaveBeenCalled();
    });

    it('should restore session when stored auth exists', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', keepSignedIn: true });
      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
        customInstructionsEncrypted: null,
      });

      await initAuth();

      expect(restoreSession).toHaveBeenCalled();
      expect(useAuthStore.getState().privateKey).toEqual(mockPrivateKey);
      expect(useAuthStore.getState().user).toEqual(testUser);
      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('should set isLoading to false when restoreSession returns null', async () => {
      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', keepSignedIn: true });
      vi.mocked(restoreSession).mockResolvedValue(null);

      await initAuth();

      expect(useAuthStore.getState().isLoading).toBe(false);
      expect(useAuthStore.getState().user).toBeNull();
    });

    it('should not clear stored auth when restoreSession throws error', async () => {
      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', keepSignedIn: true });
      vi.mocked(restoreSession).mockRejectedValue(new Error('Restore failed'));

      await initAuth();

      expect(clearStoredAuth).not.toHaveBeenCalled();
      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('should always set isLoading to false even on error', async () => {
      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', keepSignedIn: true });
      vi.mocked(restoreSession).mockRejectedValue(new Error('Restore failed'));

      await initAuth();

      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('should retry on next call when previous attempt failed to restore session', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', keepSignedIn: true });

      vi.mocked(restoreSession).mockResolvedValue(null);
      await initAuth();
      expect(useAuthStore.getState().user).toBeNull();

      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
        customInstructionsEncrypted: null,
      });
      await initAuth();

      expect(restoreSession).toHaveBeenCalledTimes(2);
      expect(useAuthStore.getState().user).toEqual(testUser);
      expect(useAuthStore.getState().privateKey).toEqual(mockPrivateKey);
    });

    it('should retry on next call when previous attempt threw an error', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', keepSignedIn: true });

      vi.mocked(restoreSession).mockRejectedValue(new Error('Network error'));
      await initAuth();
      expect(useAuthStore.getState().user).toBeNull();

      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
        customInstructionsEncrypted: null,
      });
      await initAuth();

      expect(restoreSession).toHaveBeenCalledTimes(2);
      expect(useAuthStore.getState().user).toEqual(testUser);
    });

    it('should not retry when previous attempt succeeded', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', keepSignedIn: true });
      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
        customInstructionsEncrypted: null,
      });

      await initAuth();
      expect(useAuthStore.getState().user).toEqual(testUser);

      await initAuth();

      expect(restoreSession).toHaveBeenCalledTimes(1);
    });

    it('should decrypt custom instructions on restore', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', keepSignedIn: true });
      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
        customInstructionsEncrypted: 'encrypted-blob-base64',
      });
      vi.mocked(decryptTextFromEpoch).mockReturnValue('Be concise and direct');

      await initAuth();

      expect(decryptTextFromEpoch).toHaveBeenCalled();
      expect(useAuthStore.getState().customInstructions).toBe('Be concise and direct');
    });

    it('should set customInstructions to null when not set on server', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', keepSignedIn: true });
      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
        customInstructionsEncrypted: null,
      });

      await initAuth();

      expect(decryptTextFromEpoch).not.toHaveBeenCalled();
      expect(useAuthStore.getState().customInstructions).toBeNull();
    });

    it('should set customInstructions to null when decryption fails', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', keepSignedIn: true });
      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
        customInstructionsEncrypted: 'corrupted-data',
      });
      vi.mocked(decryptTextFromEpoch).mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      await initAuth();

      expect(useAuthStore.getState().customInstructions).toBeNull();
    });

    it('should resolve to logged-out when reading stored auth throws', async () => {
      vi.mocked(getStoredAuth).mockImplementation(() => {
        throw new Error('Malformed stored auth');
      });

      await expect(initAuth()).resolves.toBeUndefined();

      expect(useAuthStore.getState().isLoading).toBe(false);
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it('should not cache a rejected promise when reading stored auth throws', async () => {
      vi.mocked(getStoredAuth).mockImplementationOnce(() => {
        throw new Error('Malformed stored auth');
      });
      await initAuth();

      vi.mocked(getStoredAuth).mockReturnValue(null);
      await expect(initAuth()).resolves.toBeUndefined();
    });
  });

  describe('requireAuth', () => {
    it('should return user when already authenticated', async () => {
      useAuthStore.setState({ user: testUser, isAuthenticated: true });

      const result = await requireAuth();

      expect(result).toEqual({ user: testUser });
      expect(getStoredAuth).not.toHaveBeenCalled();
    });

    it('should restore session and return user when not authenticated', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      useAuthStore.setState({ user: null, isAuthenticated: false });
      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', keepSignedIn: true });
      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
        customInstructionsEncrypted: null,
      });

      const result = await requireAuth();

      expect(result).toEqual({ user: testUser });
      expect(restoreSession).toHaveBeenCalled();
    });

    it('should throw redirect when no session can be restored', async () => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
      vi.mocked(getStoredAuth).mockReturnValue(null);

      await expect(requireAuth()).rejects.toEqual({ to: '/login' });
      expect(redirect).toHaveBeenCalledWith({ to: '/login' });
    });

    it('should throw redirect when restoreSession fails', async () => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', keepSignedIn: true });
      vi.mocked(restoreSession).mockRejectedValue(new Error('Restore failed'));

      await expect(requireAuth()).rejects.toEqual({ to: '/login' });
    });
  });

  describe('authClient.getSession', () => {
    it('should return user when authenticated', async () => {
      vi.mocked(getStoredAuth).mockReturnValue(null);
      useAuthStore.setState({ user: testUser, isAuthenticated: true, isLoading: false });

      const result = await authClient.getSession();

      expect(result).toEqual({ data: { user: testUser } });
    });

    it('should return null when not authenticated', async () => {
      vi.mocked(getStoredAuth).mockReturnValue(null);
      useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });

      const result = await authClient.getSession();

      expect(result).toEqual({ data: null });
    });

    it('should restore session before checking authentication', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      resetInitPromise();
      useAuthStore.setState({ user: null, isAuthenticated: false });
      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', keepSignedIn: true });
      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
        customInstructionsEncrypted: null,
      });

      const result = await authClient.getSession();

      expect(result).toEqual({ data: { user: testUser } });
      expect(restoreSession).toHaveBeenCalled();
    });
  });

  describe('resetPasswordViaRecovery', () => {
    const email = 'test@example.com';
    const recoveryPhrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const newPassword = 'newSecurePassword123';

    it('should return success on valid recovery phrase and new password', async () => {
      vi.mocked(recoverAccountFromMnemonic).mockResolvedValue(new Uint8Array([80, 81, 82]));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/recovery/get-wrapped-key')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ recoveryWrappedPrivateKey: 'recoveryWrappedBase64' }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset/init')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ newRegistrationResponse: [1, 2, 3] }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await resetPasswordViaRecovery(email, recoveryPhrase, newPassword);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(recoverAccountFromMnemonic).toHaveBeenCalled();
    });

    it('should return error when get-wrapped-key fails', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'NOT_FOUND' }),
      } as Response);

      const result = await resetPasswordViaRecovery(email, recoveryPhrase, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe("The item you're looking for doesn't exist.");
    });

    it('should return error when recoverAccountFromMnemonic fails', async () => {
      vi.mocked(recoverAccountFromMnemonic).mockRejectedValue(new Error('INVALID_RECOVERY_PHRASE'));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/recovery/get-wrapped-key')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ recoveryWrappedPrivateKey: 'recoveryWrappedBase64' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await resetPasswordViaRecovery(email, recoveryPhrase, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Password change failed. Please try again.');
    });

    it('should return error when reset-password/init fails', async () => {
      vi.mocked(recoverAccountFromMnemonic).mockResolvedValue(new Uint8Array([80, 81, 82]));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/recovery/get-wrapped-key')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ recoveryWrappedPrivateKey: 'recoveryWrappedBase64' }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset/init')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'REGISTRATION_FAILED' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await resetPasswordViaRecovery(email, recoveryPhrase, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Registration failed. Please try again.');
    });

    it('should return error when reset-password/finish fails', async () => {
      vi.mocked(recoverAccountFromMnemonic).mockResolvedValue(new Uint8Array([80, 81, 82]));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/recovery/get-wrapped-key')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ recoveryWrappedPrivateKey: 'recoveryWrappedBase64' }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset/init')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ newRegistrationResponse: [1, 2, 3] }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'NO_PENDING_RECOVERY' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await resetPasswordViaRecovery(email, recoveryPhrase, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Your recovery attempt expired. Please try again.');
    });

    it('should send identifier field with email when @ is present', async () => {
      vi.mocked(recoverAccountFromMnemonic).mockResolvedValue(new Uint8Array([80, 81, 82]));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/recovery/get-wrapped-key')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ recoveryWrappedPrivateKey: 'recoveryWrappedBase64' }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset/init')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ newRegistrationResponse: [1, 2, 3] }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await resetPasswordViaRecovery('user@example.com', recoveryPhrase, newPassword);

      const getKeyCall = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url]) => typeof url === 'string' && url.includes('/recovery/get-wrapped-key')
        );
      expect(getKeyCall).toBeDefined();
      const getKeyBody = JSON.parse(getKeyCall![1]!.body as string) as { identifier: string };
      expect(getKeyBody.identifier).toBe('user@example.com');
    });

    it('should normalize username via normalizeIdentifier when no @ present', async () => {
      vi.mocked(recoverAccountFromMnemonic).mockResolvedValue(new Uint8Array([80, 81, 82]));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/recovery/get-wrapped-key')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ recoveryWrappedPrivateKey: 'recoveryWrappedBase64' }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset/init')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ newRegistrationResponse: [1, 2, 3] }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await resetPasswordViaRecovery('Test User', recoveryPhrase, newPassword);

      const getKeyCall = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url]) => typeof url === 'string' && url.includes('/recovery/get-wrapped-key')
        );
      expect(getKeyCall).toBeDefined();
      const getKeyBody = JSON.parse(getKeyCall![1]!.body as string) as { identifier: string };
      expect(getKeyBody.identifier).toBe('test_user');
    });
  });

  describe('authClient.tokenLogin', () => {
    it('should return success on valid token', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      const result = await authClient.tokenLogin({ token: 'valid-token' });

      expect(result.error).toBeUndefined();
      const call = vi
        .mocked(fetch)
        .mock.calls.find((c) => urlFromFetchInput(c[0]).endsWith('/auth/token-login'));
      expect(call).toBeDefined();
      const init = call![1]!;
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
      expect(JSON.parse(init.body as string)).toEqual({ token: 'valid-token' });
    });

    it('should return error on failed token login', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'LOGIN_TOKEN_INVALID' }),
      } as Response);

      const result = await authClient.tokenLogin({ token: 'bad-token' });

      expect(result.error).toEqual({
        message: 'This login link has expired or already been used.',
      });
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await authClient.tokenLogin({ token: 'some-token' });

      expect(result.error).toEqual({
        message: 'Something went wrong. Please try again later.',
      });
    });
  });

  describe('authClient.resendVerification', () => {
    it('should return success on valid email', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      const result = await authClient.resendVerification({ email: 'test@example.com' });

      expect(result.error).toBeUndefined();
      const call = vi
        .mocked(fetch)
        .mock.calls.find((c) => urlFromFetchInput(c[0]).endsWith('/auth/verify-email/resend'));
      expect(call).toBeDefined();
      const init = call![1]!;
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
      expect(JSON.parse(init.body as string)).toEqual({ email: 'test@example.com' });
    });

    it('should return error on failed resend', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'RATE_LIMITED' }),
      } as Response);

      const result = await authClient.resendVerification({ email: 'test@example.com' });

      expect(result.error).toEqual({
        message: 'Too many requests. Please wait a moment and try again.',
      });
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await authClient.resendVerification({ email: 'test@example.com' });

      expect(result.error).toEqual({
        message: 'Something went wrong. Please try again later.',
      });
    });
  });

  describe('authClient.verifyEmail', () => {
    it('should successfully verify email', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      const result = await authClient.verifyEmail({ query: { token: 'valid-token' } });

      expect(result.error).toBeUndefined();
      const call = vi
        .mocked(fetch)
        .mock.calls.find((c) => urlFromFetchInput(c[0]).endsWith('/auth/verify-email'));
      expect(call).toBeDefined();
      const init = call![1]!;
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
      expect(JSON.parse(init.body as string)).toEqual({ token: 'valid-token' });
    });

    it('should return error when verification fails', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'INVALID_VERIFICATION_TOKEN' }),
      } as Response);

      const result = await authClient.verifyEmail({ query: { token: 'invalid-token' } });

      expect(result.error).toEqual({
        message: 'This verification link is invalid or has expired.',
      });
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await authClient.verifyEmail({ query: { token: 'some-token' } });

      expect(result.error).toEqual({
        message: 'Email verification failed. Please try again or request a new link.',
      });
    });
  });

  describe('disable2FAInit', () => {
    const password = 'myPassword123';

    it('should return ke3 on successful password verification', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/init')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ke2: [10, 20, 30] }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await disable2FAInit(password);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.ke3).toEqual([4, 5, 6]);
      }
      expect(createOpaqueClient).toHaveBeenCalled();
      expect(startLogin).toHaveBeenCalledWith({ client: 'mock' }, password);
      expect(finishLogin).toHaveBeenCalled();
    });

    it('should return error on incorrect password', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/init')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'AUTH_FAILED' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await disable2FAInit(password);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Incorrect username, email, or password. Please try again.');
      }
    });

    it('should return error when OPAQUE finishLogin throws', async () => {
      vi.mocked(finishLogin).mockRejectedValueOnce(new Error('OPAQUE failure'));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/init')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ke2: [10, 20, 30] }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await disable2FAInit(password);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Failed to start two-factor disable. Please try again.');
      }
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await disable2FAInit(password);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Failed to start two-factor disable. Please try again.');
      }
    });
  });

  describe('disable2FAFinish', () => {
    const ke3 = [4, 5, 6];
    const code = '123456';
    const disable2FASessionId = '00000000-0000-4000-8000-deadbeefdead';

    it('should return success when finish endpoint returns 200', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await disable2FAFinish(ke3, code, disable2FASessionId);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return error on invalid TOTP code', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'INVALID_TOTP_CODE' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await disable2FAFinish(ke3, code, disable2FASessionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('That code is incorrect or has expired. Please try again.');
    });

    it('should return error on rate limit', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'TOO_MANY_ATTEMPTS' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await disable2FAFinish(ke3, code, disable2FASessionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Too many attempts. Please wait and try again.');
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await disable2FAFinish(ke3, code, disable2FASessionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Two-factor verification failed. Please try again.');
    });

    it('should send correct request body with ke3, code, and disable2FASessionId', async () => {
      let capturedBody: string | null = null;

      vi.mocked(fetch).mockImplementation((url, init) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/finish')) {
          if (!init) throw new Error('Expected init');
          capturedBody = init.body as string;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await disable2FAFinish(ke3, code, disable2FASessionId);

      const parsed = JSON.parse(defined(capturedBody));
      expect(parsed).toEqual({
        ke3: [4, 5, 6],
        code: '123456',
        disable2FASessionId,
      });
    });
  });
});

describe('session-revocation clearer registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: null, privateKey: null, isAuthenticated: false });
  });

  it('registers a revocation clearer with the query provider on import', () => {
    expect(registeredRevocationClearer).toBeTypeOf('function');
  });

  it('clears auth and reports true when an authenticated session exists', () => {
    useAuthStore.setState({ user: testUser, isAuthenticated: true });
    const clearer = defined(registeredRevocationClearer);

    const result = clearer();

    expect(result).toBe(true);
    expect(clearStoredAuth).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('clears auth and reports true when only a stored-auth marker exists (bootstrap window)', () => {
    vi.mocked(hasStoredAuth).mockReturnValue(true);
    const clearer = defined(registeredRevocationClearer);

    expect(clearer()).toBe(true);
    expect(clearStoredAuth).toHaveBeenCalledTimes(1);
  });

  it('reports false and clears nothing when no session exists (expected login-challenge 401)', () => {
    vi.mocked(hasStoredAuth).mockReturnValue(false);
    const clearer = defined(registeredRevocationClearer);

    expect(clearer()).toBe(false);
    expect(clearStoredAuth).not.toHaveBeenCalled();
  });
});
