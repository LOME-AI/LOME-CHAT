import { create } from 'zustand';
import { redirect } from '@tanstack/react-router';
import { useShallow } from 'zustand/react/shallow';
import {
  createOpaqueClient,
  startRegistration,
  finishRegistration,
  startLogin,
  finishLogin,
  createAccount,
  unwrapAccountKeyWithPassword,
  rewrapAccountKeyForPasswordChange,
  recoverAccountFromMnemonic,
  decryptTextFromEpoch,
  OPAQUE_SERVER_IDENTIFIER,
} from '@hushbox/crypto';
import {
  normalizeIdentifier,
  normalizeUsername,
  fromBase64,
  toBase64,
  ROUTES,
  friendlyErrorMessage,
} from '@hushbox/shared';

import { queryClient, registerSessionRevocationClearer } from '@/providers/query-provider';
import { client as apiClient } from '@/lib/api-client';
import { clearEpochKeyCache } from '@/lib/epoch-key-cache';
import { clearDecryptedMessageCache } from '@/lib/decrypted-message-cache';
import { useModelStore } from '@/stores/model';
import { useDocumentStore } from '@/stores/document';
import {
  persistExportKey,
  getStoredAuth,
  hasStoredAuth,
  clearStoredAuth,
  restoreSession,
} from './auth-client.js';
import { meQueryOptions } from './auth-queries.js';
import { getLinkGuestAuth } from './link-guest-auth.js';

function extractErrorCode(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'code' in body) {
    const code = (body as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function parseErrorMessage(body: unknown): string {
  const code = extractErrorCode(body);
  if (code) return friendlyErrorMessage(code);
  return friendlyErrorMessage('INTERNAL');
}

async function handleErrorResponse(response: Response): Promise<{ success: false; error: string }> {
  const body: unknown = await response.json();
  return { success: false, error: parseErrorMessage(body) };
}

export interface UserData {
  id: string;
  email: string;
  username: string;
  emailVerified: boolean;
  totpEnabled: boolean;
  hasAcknowledgedPhrase: boolean;
}

interface AuthState {
  user: UserData | null;
  privateKey: Uint8Array | null;
  customInstructions: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  setUser: (user: UserData | null) => void;
  setPrivateKey: (key: Uint8Array) => void;
  setCustomInstructions: (instructions: string | null) => void;
  setLoading: (isLoading: boolean) => void;
  clear: () => void;
}

interface SignInEmailResult {
  error?: { message: string; code?: string };
  requires2FA?: boolean;
  verifyTOTP?: (code: string) => Promise<{ success: boolean; error?: string }>;
}

interface SignUpEmailResult {
  error?: { message: string };
}

interface VerifyEmailResult {
  error?: { message: string };
}

// SECURITY: No persist middleware. Private key must only exist in memory.
// Persisting would leak encryption keys to localStorage/sessionStorage.
export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  privateKey: null,
  customInstructions: null,
  isLoading: true,
  isAuthenticated: false,
  setUser: (user) => {
    set({ user, isAuthenticated: !!user });
  },
  setPrivateKey: (key) => {
    set({ privateKey: key });
  },
  setCustomInstructions: (instructions) => {
    set({ customInstructions: instructions });
  },
  setLoading: (isLoading) => {
    set({ isLoading });
  },
  clear: () => {
    const { privateKey } = get();
    if (privateKey) privateKey.fill(0);
    set({
      user: null,
      privateKey: null,
      customInstructions: null,
      isAuthenticated: false,
      isLoading: false,
    });
  },
}));

interface SessionHookResult {
  data: { user: UserData; session: { id: string } } | null;
  isPending: boolean;
}

export function useSession(): SessionHookResult {
  const { user, isLoading } = useAuthStore(
    useShallow((s) => ({ user: s.user, isLoading: s.isLoading }))
  );

  // When viewing a shared conversation via link guest auth, mask the session
  // so the user appears as an unauthenticated guest. This prevents balance
  // queries (which fail with credentials: 'omit') and ensures the share page
  // shows read-only notification instead of trial notice.
  if (getLinkGuestAuth()) {
    return { data: null, isPending: false };
  }

  return {
    data: user ? { user, session: { id: user.id } } : null,
    isPending: isLoading,
  };
}

async function finalizeLoginWithKey(
  exportKey: Uint8Array,
  wrappedPrivateKey: Uint8Array,
  userId: string,
  keepSignedIn: boolean
): Promise<void> {
  const accountPrivateKey = unwrapAccountKeyWithPassword(exportKey, wrappedPrivateKey);
  await persistExportKey(exportKey, userId, keepSignedIn);
  useAuthStore.getState().setPrivateKey(accountPrivateKey);

  // Routed through the query client so /me inherits the app-wide retry policy.
  // Throws on any non-2xx /me response once retries are exhausted. The caller
  // treats that as a failed login rather than synthesizing account flags: a
  // transient /me failure must never downgrade a verified user's
  // emailVerified/totpEnabled/hasAcknowledgedPhrase to false.
  const meData = await queryClient.fetchQuery(meQueryOptions());
  useAuthStore.getState().setUser(meData.user);
  useAuthStore
    .getState()
    .setCustomInstructions(
      decryptCustomInstructions(accountPrivateKey, meData.customInstructionsEncrypted)
    );
}

function createTOTPVerifier(
  exportKey: Uint8Array,
  keepSignedIn: boolean
): (code: string) => Promise<{ success: boolean; error?: string }> {
  return async (code: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const response = await apiClient.auth.login['2fa'].verify.$post({ json: { code } });

      if (!response.ok) {
        const body: unknown = await response.json();
        return { success: false, error: parseErrorMessage(body) };
      }

      const verifyResponse = (await response.json()) as {
        success: true;
        userId: string;
        passwordWrappedPrivateKey: string;
      };

      await finalizeLoginWithKey(
        exportKey,
        fromBase64(verifyResponse.passwordWrappedPrivateKey),
        verifyResponse.userId,
        keepSignedIn
      );

      return { success: true };
    } catch {
      return { success: false, error: friendlyErrorMessage('TWO_FACTOR_VERIFICATION_FAILED') };
    }
  };
}

function buildLoginError(body: unknown): { error: { message: string; code?: string } } {
  const code = extractErrorCode(body);
  return { error: { message: parseErrorMessage(body), ...(code && { code }) } };
}

async function signInEmail(options: {
  identifier: string;
  password: string;
  keepSignedIn?: boolean;
}): Promise<SignInEmailResult> {
  const { identifier: rawIdentifier, password, keepSignedIn = false } = options;
  const identifier = normalizeIdentifier(rawIdentifier);

  try {
    const client = createOpaqueClient();
    const { ke1 } = await startLogin(client, password);

    const initResponse = await apiClient.auth.login.init.$post({ json: { identifier, ke1 } });

    if (!initResponse.ok) {
      return buildLoginError(await initResponse.json());
    }

    const { ke2, loginSessionId } = (await initResponse.json()) as {
      ke2: number[];
      loginSessionId: string;
    };

    const loginResult = await finishLogin(client, ke2, OPAQUE_SERVER_IDENTIFIER);
    const exportKey = new Uint8Array(loginResult.exportKey);

    const finishResponse = await apiClient.auth.login.finish.$post({
      json: { identifier, ke3: loginResult.ke3, loginSessionId },
    });

    if (!finishResponse.ok) {
      return buildLoginError(await finishResponse.json());
    }

    const finishData = (await finishResponse.json()) as {
      success?: true;
      requires2FA?: true;
      userId: string;
      email?: string;
      passwordWrappedPrivateKey?: string;
    };

    if (finishData.requires2FA) {
      return {
        requires2FA: true,
        verifyTOTP: createTOTPVerifier(exportKey, keepSignedIn),
      };
    }

    if (!finishData.passwordWrappedPrivateKey) {
      return { error: { message: friendlyErrorMessage('ENCRYPTION_NOT_SETUP') } };
    }

    await finalizeLoginWithKey(
      exportKey,
      fromBase64(finishData.passwordWrappedPrivateKey),
      finishData.userId,
      keepSignedIn
    );

    return {};
  } catch {
    return { error: { message: friendlyErrorMessage('LOGIN_FAILED') } };
  }
}

export const signIn = {
  email: signInEmail,
};

async function signUpEmail(options: {
  username: string;
  email: string;
  password: string;
}): Promise<SignUpEmailResult> {
  const { username, email, password } = options;
  const normalizedUsername = normalizeUsername(username);

  try {
    const client = createOpaqueClient();
    const { serialized } = await startRegistration(client, password);

    const initResponse = await apiClient.auth.register.init.$post({
      json: {
        email,
        username: normalizedUsername,
        registrationRequest: serialized,
      },
    });

    if (!initResponse.ok) {
      const body: unknown = await initResponse.json();
      return { error: { message: parseErrorMessage(body) } };
    }

    const { registrationResponse, registerSessionId } = (await initResponse.json()) as {
      registrationResponse: number[];
      registerSessionId: string;
    };

    const { record, exportKey } = await finishRegistration(
      client,
      registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );

    const opaqueExportKey = new Uint8Array(exportKey);
    const accountResult = await createAccount(opaqueExportKey);

    const finishResponse = await apiClient.auth.register.finish.$post({
      json: {
        email,
        registrationRecord: record,
        accountPublicKey: toBase64(accountResult.publicKey),
        passwordWrappedPrivateKey: toBase64(accountResult.passwordWrappedPrivateKey),
        recoveryWrappedPrivateKey: toBase64(accountResult.recoveryWrappedPrivateKey),
        registerSessionId,
      },
    });

    if (!finishResponse.ok) {
      const body: unknown = await finishResponse.json();
      return { error: { message: parseErrorMessage(body) } };
    }

    return {};
  } catch {
    return { error: { message: friendlyErrorMessage('REGISTRATION_FAILED') } };
  }
}

export const signUp = {
  email: signUpEmail,
};

interface ChangePasswordResult {
  success: boolean;
  error?: string;
}

interface ResetPasswordViaRecoveryResult {
  success: boolean;
  error?: string;
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<ChangePasswordResult> {
  try {
    const loginClient = createOpaqueClient();
    const { ke1 } = await startLogin(loginClient, currentPassword);

    const regClient = createOpaqueClient();
    const { serialized: newRegistrationRequest } = await startRegistration(regClient, newPassword);

    const initResponse = await apiClient.auth['change-password'].init.$post({
      json: { ke1, newRegistrationRequest },
    });

    if (!initResponse.ok) {
      return await handleErrorResponse(initResponse);
    }

    const { ke2, newRegistrationResponse, changePasswordSessionId } =
      (await initResponse.json()) as {
        ke2: number[];
        newRegistrationResponse: number[];
        changePasswordSessionId: string;
      };

    const loginResult = await finishLogin(loginClient, ke2, OPAQUE_SERVER_IDENTIFIER);

    const newRegResult = await finishRegistration(
      regClient,
      newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );

    const { privateKey: accountPrivateKey } = useAuthStore.getState();
    if (!accountPrivateKey) {
      return { success: false, error: friendlyErrorMessage('ACCOUNT_KEY_NOT_AVAILABLE') };
    }

    const newExportKey = new Uint8Array(newRegResult.exportKey);
    const newPasswordWrappedPrivateKey = rewrapAccountKeyForPasswordChange(
      accountPrivateKey,
      newExportKey
    );

    const finishResponse = await apiClient.auth['change-password'].finish.$post({
      json: {
        ke3: loginResult.ke3,
        newRegistrationRecord: newRegResult.record,
        newPasswordWrappedPrivateKey: toBase64(newPasswordWrappedPrivateKey),
        changePasswordSessionId,
      },
    });

    if (!finishResponse.ok) {
      return await handleErrorResponse(finishResponse);
    }

    const storedAuth = getStoredAuth();
    if (storedAuth) {
      await persistExportKey(newExportKey, storedAuth.userId, storedAuth.keepSignedIn);
    }

    return { success: true };
  } catch {
    return { success: false, error: friendlyErrorMessage('CREDENTIAL_UPDATE_FAILED') };
  }
}

export async function resetPasswordViaRecovery(
  rawIdentifier: string,
  recoveryPhrase: string,
  newPassword: string
): Promise<ResetPasswordViaRecoveryResult> {
  const identifier = normalizeIdentifier(rawIdentifier);
  let accountPrivateKey: Uint8Array | null = null;

  try {
    const getKeyResponse = await apiClient.auth.recovery['get-wrapped-key'].$post({
      json: { identifier },
    });

    if (!getKeyResponse.ok) {
      return await handleErrorResponse(getKeyResponse);
    }

    const { recoveryWrappedPrivateKey } = (await getKeyResponse.json()) as {
      recoveryWrappedPrivateKey: string;
    };

    accountPrivateKey = await recoverAccountFromMnemonic(
      recoveryPhrase,
      fromBase64(recoveryWrappedPrivateKey)
    );

    const client = createOpaqueClient();
    const { serialized: newRegistrationRequest } = await startRegistration(client, newPassword);

    const initResponse = await apiClient.auth.recovery.reset.init.$post({
      json: { identifier, newRegistrationRequest },
    });

    if (!initResponse.ok) {
      return await handleErrorResponse(initResponse);
    }

    const { newRegistrationResponse, recoverySessionId } = (await initResponse.json()) as {
      newRegistrationResponse: number[];
      recoverySessionId: string;
    };

    const { record, exportKey } = await finishRegistration(
      client,
      newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );

    const newExportKey = new Uint8Array(exportKey);
    const newPasswordWrappedPrivateKey = rewrapAccountKeyForPasswordChange(
      accountPrivateKey,
      newExportKey
    );

    const finishResponse = await apiClient.auth.recovery.reset.finish.$post({
      json: {
        identifier,
        newRegistrationRecord: record,
        newPasswordWrappedPrivateKey: toBase64(newPasswordWrappedPrivateKey),
        recoverySessionId,
      },
    });

    if (!finishResponse.ok) {
      return await handleErrorResponse(finishResponse);
    }

    return { success: true };
  } catch {
    return {
      success: false,
      error: friendlyErrorMessage('CREDENTIAL_UPDATE_FAILED'),
    };
  } finally {
    // Recovered account private key is real key material this buffer is the
    // only handle to; zero it after use so it can't linger in memory.
    if (accountPrivateKey) accountPrivateKey.fill(0);
  }
}

export async function disable2FAInit(
  password: string
): Promise<
  { success: true; ke3: number[]; disable2FASessionId: string } | { success: false; error: string }
> {
  try {
    const client = createOpaqueClient();
    const { ke1 } = await startLogin(client, password);

    const initResponse = await apiClient.auth['2fa'].disable.init.$post({ json: { ke1 } });
    if (!initResponse.ok) {
      const body: unknown = await initResponse.json();
      return { success: false, error: parseErrorMessage(body) };
    }
    const { ke2, disable2FASessionId } = (await initResponse.json()) as {
      ke2: number[];
      disable2FASessionId: string;
    };

    const loginResult = await finishLogin(client, ke2, OPAQUE_SERVER_IDENTIFIER);
    return { success: true, ke3: loginResult.ke3, disable2FASessionId };
  } catch {
    return { success: false, error: friendlyErrorMessage('DISABLE_2FA_INIT_FAILED') };
  }
}

export async function disable2FAFinish(
  ke3: number[],
  code: string,
  disable2FASessionId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await apiClient.auth['2fa'].disable.finish.$post({
      json: { ke3, code, disable2FASessionId },
    });
    if (!response.ok) {
      const body: unknown = await response.json();
      return { success: false, error: parseErrorMessage(body) };
    }
    return { success: true };
  } catch {
    return { success: false, error: friendlyErrorMessage('TWO_FACTOR_VERIFICATION_FAILED') };
  }
}

// Local-only side of sign-out — used after server-side destruction has already
// happened (e.g. account deletion's 204 response).
export function clearLocalAuthState({ reload = true }: { reload?: boolean } = {}): void {
  clearStoredAuth();
  clearEpochKeyCache();
  useAuthStore.getState().clear();
  // Force text modality active so the trial page never lands on a non-text
  // modality (which would disable every icon for trial users).
  useModelStore.getState().resetForUnauthenticated();
  // Drop decrypted document content from memory so it can't outlive the session.
  useDocumentStore.getState().closePanel();
  // Drop every viewed message's decrypted plaintext held at module scope.
  clearDecryptedMessageCache();
  queryClient.clear();
  initPromise = null;
  // A full reload is the only way to GUARANTEE no decrypted plaintext lingers
  // in module-level memory after sign-out. Logout is rare enough to afford it.
  // The switch-user flows (dev persona picker) opt out via `reload: false`:
  // they re-authenticate as another principal in the same context, and a
  // reload would tear the JS context down before their login runs.
  if (reload) globalThis.location.reload();
}

export async function signOutAndClearCache({
  reload = true,
}: { reload?: boolean } = {}): Promise<void> {
  await apiClient.auth.logout.$post();
  clearLocalAuthState({ reload });
}

async function runSimpleAuthPost(
  request: Promise<Response>,
  fallbackErrorCode = 'INTERNAL'
): Promise<{ error?: { message: string } }> {
  try {
    const response = await request;
    if (!response.ok) {
      const responseBody: unknown = await response.json();
      return { error: { message: parseErrorMessage(responseBody) } };
    }
    return {};
  } catch {
    return { error: { message: friendlyErrorMessage(fallbackErrorCode) } };
  }
}

export const authClient = {
  getSession: async (): Promise<{ data: { user: UserData } | null }> => {
    await initAuth();
    const { user, isAuthenticated } = useAuthStore.getState();
    if (user && isAuthenticated) {
      return { data: { user } };
    }
    return { data: null };
  },

  tokenLogin: (options: { token: string }): Promise<{ error?: { message: string } }> =>
    runSimpleAuthPost(apiClient.auth['token-login'].$post({ json: { token: options.token } })),

  resendVerification: (options: { email: string }): Promise<{ error?: { message: string } }> =>
    runSimpleAuthPost(
      apiClient.auth['verify-email'].resend.$post({ json: { email: options.email } })
    ),

  verifyEmail: (options: { query: { token: string } }): Promise<VerifyEmailResult> =>
    runSimpleAuthPost(
      apiClient.auth['verify-email'].$post({ json: { token: options.query.token } }),
      'EMAIL_VERIFICATION_FAILED'
    ),
};

function decryptCustomInstructions(
  privateKey: Uint8Array,
  encryptedBase64: string | null | undefined
): string | null {
  if (!encryptedBase64) return null;
  try {
    const blob = fromBase64(encryptedBase64);
    return decryptTextFromEpoch(privateKey, blob);
  } catch {
    return null;
  }
}

let initPromise: Promise<void> | null = null;

export function initAuth(): Promise<void> {
  initPromise ??= doInitAuth();
  return initPromise;
}

async function doInitAuth(): Promise<void> {
  useAuthStore.getState().setLoading(true);

  try {
    // Read storage inside the try so a malformed/legacy blob settles to
    // logged-out instead of bricking boot with a stuck spinner and a poisoned
    // cached initPromise.
    const storedAuth = getStoredAuth();
    if (!storedAuth) {
      // A closed session tab leaves its device key + ciphertext in IndexedDB with
      // no marker — the browser clears only the sessionStorage marker on tab close.
      // This no-marker branch is where session mode actually purges them, on the
      // next app load.
      clearStoredAuth();
      return;
    }

    const restored = await restoreSession();
    if (!restored) {
      // Reset singleton so next initAuth() call retries.
      initPromise = null;
      useAuthStore.getState().setLoading(false);
      return;
    }

    useAuthStore.getState().setPrivateKey(restored.privateKey);
    useAuthStore.getState().setUser(restored.user);
    useAuthStore
      .getState()
      .setCustomInstructions(
        decryptCustomInstructions(restored.privateKey, restored.customInstructionsEncrypted)
      );
  } catch {
    // restoreSession() handles clearing auth for definitive failures (401/403);
    // transient errors should allow retry.
    initPromise = null;
  } finally {
    useAuthStore.getState().setLoading(false);
  }
}

export async function requireAuth(): Promise<{ user: UserData }> {
  const { user, isAuthenticated } = useAuthStore.getState();
  if (user && isAuthenticated) {
    return { user };
  }

  await initAuth();

  const state = useAuthStore.getState();
  if (!state.user || !state.isAuthenticated) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is designed to be thrown
    throw redirect({ to: ROUTES.LOGIN });
  }

  return { user: state.user };
}

export function resetInitPromise(): void {
  initPromise = null;
}

// Wire the global mid-session-revocation handler. The query/mutation caches call
// this on any error; it acts only when a live session exists — an in-memory
// authenticated store or a stored-auth marker (the bootstrap window before the
// store is hydrated). An expected OPAQUE login-challenge 401 fires before any
// session exists, so this reports false and the caller neither clears nor
// redirects. Returns true iff a session was present and has been cleared.
registerSessionRevocationClearer((): boolean => {
  const isSessionLive = useAuthStore.getState().isAuthenticated || hasStoredAuth();
  if (!isSessionLive) {
    return false;
  }
  clearStoredAuth();
  useAuthStore.getState().clear();
  return true;
});
