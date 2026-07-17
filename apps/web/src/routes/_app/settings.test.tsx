import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { renderRoute } from '@/test-utils/render';
import { Route } from './settings';

// vi.hoisted values are available inside vi.mock factories (hoisted above imports)
const { mockChangePassword, mockUseAuthStore, useAuthStoreMock, mockAuthStoreState } = vi.hoisted(
  () => {
    const mockChangePasswordFunction = vi.fn();
    const mockUseAuthStoreFunction = vi.fn();

    // Default state returned by useAuthStore.getState() — RecoveryPhraseModal uses this
    const state = {
      user: null as {
        id: string;
        email: string;
        username: string;
        emailVerified: boolean;
        totpEnabled: boolean;
        hasAcknowledgedPhrase: boolean;
      } | null,
      privateKey: new Uint8Array(32),
      customInstructions: null as string | null,
      isLoading: false,
      isAuthenticated: true,
      setUser: vi.fn(),
      setPrivateKey: vi.fn(),
      setCustomInstructions: vi.fn(),
      setLoading: vi.fn(),
      clear: vi.fn(),
    };

    // useAuthStore must support both selector calls and .getState()
    const mock = Object.assign(
      (selector: (s: typeof state) => unknown) => mockUseAuthStoreFunction(selector),
      { getState: () => state }
    );

    return {
      mockChangePassword: mockChangePasswordFunction,
      mockUseAuthStore: mockUseAuthStoreFunction,
      mockAuthStoreState: state,
      useAuthStoreMock: mock,
    };
  }
);

const { mockDisable2FAInit, mockDisable2FAFinish } = vi.hoisted(() => ({
  mockDisable2FAInit: vi.fn(),
  mockDisable2FAFinish: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn().mockImplementation(() => Promise.resolve()),
  changePassword: (...args: unknown[]) => mockChangePassword(...args),
  useAuthStore: useAuthStoreMock,
  useSession: vi.fn(() => ({ data: null, isPending: false })),
  disable2FAInit: (...args: unknown[]) => mockDisable2FAInit(...args),
  disable2FAFinish: (...args: unknown[]) => mockDisable2FAFinish(...args),
}));

vi.mock('@/hooks/billing/billing', () => ({
  useBalance: vi.fn(() => ({ data: undefined, isLoading: false })),
}));

vi.mock('@/hooks/auth/use-delete-account', () => ({
  useDeleteAccountInit: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDeleteAccountFinish: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock('@/hooks/auth/auth-mutations', () => ({
  useChangePassword: vi.fn(() => ({
    mutateAsync: async (variables: {
      currentPassword: string;
      newPassword: string;
    }): Promise<{ success: boolean; error?: string }> => {
      const result = (await mockChangePassword(
        variables.currentPassword,
        variables.newPassword
      )) as { success: boolean; error?: string };
      if (!result.success) throw new Error(result.error ?? 'CHANGE_PASSWORD_FAILED');
      return result;
    },
    isPending: false,
  })),
}));

// RecoveryPhraseModal imports getApiUrl from @/lib/api
vi.mock('@/lib/api', () => ({
  getApiUrl: vi.fn(() => 'http://localhost:8787'),
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: vi.fn(() => false),
  };
});

vi.mock('@/components/settings/custom-instructions-modal', () => ({
  CustomInstructionsModal: ({
    open,
    onSuccess,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
  }) =>
    open ? (
      <div data-testid="custom-instructions-modal">
        <button onClick={onSuccess}>Mock Save</button>
      </div>
    ) : null,
}));

const { mockChangePasswordSubmitResult } = vi.hoisted(() => ({
  mockChangePasswordSubmitResult: vi.fn(),
}));

// Stub the change-password modal so the page's onSuccess/onSubmit callbacks are
// reachable from clicks. It still renders "Change Password" text so the
// modal-opens assertion (getAllByText('Change Password')[1]) keeps working.
vi.mock('@/components/auth/change-password-modal', () => ({
  ChangePasswordModal: ({
    open,
    onSuccess,
    onSubmit,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
    onSubmit: (data: {
      currentPassword: string;
      newPassword: string;
    }) => Promise<{ success: boolean; error?: string }>;
  }) =>
    open ? (
      <div data-testid="change-password-modal-stub">
        <span>Change Password</span>
        <button data-testid="cp-onsuccess" onClick={onSuccess}>
          success
        </button>
        <button
          data-testid="cp-onsubmit"
          onClick={() => {
            void (async () => {
              const result = await onSubmit({ currentPassword: 'cur', newPassword: 'new' });
              mockChangePasswordSubmitResult(result);
            })();
          }}
        >
          submit
        </button>
      </div>
    ) : null,
}));

vi.mock('@/components/settings/delete-account-modal', () => ({
  DeleteAccountModal: ({ open }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? <div data-testid="delete-account-modal-stub">Delete account flow</div> : null,
}));

vi.mock('@hushbox/crypto', () => ({
  regenerateRecoveryPhrase: vi.fn(() =>
    Promise.resolve({
      recoveryPhrase: 'apple brave candy delta eagle frost globe happy ivory joker kite lemon',
      recoveryWrappedPrivateKey: new Uint8Array(64),
    })
  ),
  toBase64: vi.fn(() => 'base64-encoded-key'),
}));

const mockOpenExternalPage = vi.fn();
vi.mock('@/capacitor', () => ({
  openExternalPage: (...args: unknown[]) => mockOpenExternalPage(...args),
}));

document.elementFromPoint = vi.fn(() => null);

const mockClipboardWrite = vi.fn().mockImplementation(() => Promise.resolve());
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: mockClipboardWrite },
  writable: true,
  configurable: true,
});

vi.mock('react-qrcode-logo', () => ({
  QRCode: ({ value }: { value: string }) => (
    <div data-testid="qr-code" data-value={value}>
      QR Code Mock
    </div>
  ),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function setMockUser(
  overrides: {
    email?: string;
    emailVerified?: boolean;
    totpEnabled?: boolean;
    hasAcknowledgedPhrase?: boolean;
  } = {}
): void {
  const defaultUser = {
    id: 'user-1',
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
  };
  const user = { ...defaultUser, ...overrides };
  // Update both selector mock and getState().user for direct access
  mockAuthStoreState.user = user;
  mockUseAuthStore.mockImplementation(
    (selector: (state: { user: typeof user; customInstructions: string | null }) => unknown) =>
      selector({ user, customInstructions: mockAuthStoreState.customInstructions })
  );
}

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDisable2FAInit.mockResolvedValue({
      success: true,
      ke3: [4, 5, 6],
      disable2FASessionId: '00000000-0000-4000-8000-deadbeefdead',
    });
    mockDisable2FAFinish.mockResolvedValue({ success: true });
    setMockUser();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          secret: 'JBSWY3DPEHPK3PXP',
          totpUri: 'otpauth://totp/test',
        }),
    });
  });

  describe('rendering', () => {
    it('renders page with Settings title', () => {
      renderRoute(Route);

      expect(screen.getByTestId('page-header-title')).toHaveTextContent('Settings');
    });

    it('shows security section with manage authentication description', () => {
      renderRoute(Route);

      expect(screen.getByText('Security')).toBeInTheDocument();
      expect(screen.getByText('Manage authentication')).toBeInTheDocument();
    });

    it('shows change password option', () => {
      renderRoute(Route);

      expect(screen.getByText('Change Password')).toBeInTheDocument();
    });

    it('shows two-factor authentication option', () => {
      renderRoute(Route);

      expect(screen.getByText('Two-Factor Authentication')).toBeInTheDocument();
    });

    it('shows recovery phrase option with description', () => {
      renderRoute(Route);

      expect(screen.getByText('Recovery Phrase')).toBeInTheDocument();
      expect(screen.getByText('Protect from forgetting your password')).toBeInTheDocument();
    });

    it('shows "Add an extra layer of security" when 2FA is disabled', () => {
      setMockUser({ totpEnabled: false });
      renderRoute(Route);

      expect(screen.getByText('Add an extra layer of security')).toBeInTheDocument();
    });

    it('shows "Manage your authentication security" when 2FA is enabled', () => {
      setMockUser({ totpEnabled: true });
      renderRoute(Route);

      expect(screen.getByText('Manage your authentication security')).toBeInTheDocument();
    });
  });

  describe('legal card', () => {
    it('renders legal card with title and description', () => {
      renderRoute(Route);

      expect(screen.getByText('Legal')).toBeInTheDocument();
      expect(screen.getByText('Terms and policies')).toBeInTheDocument();
    });

    it('renders Terms of Service button that opens external page', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      const termsButton = screen.getByRole('button', { name: /terms of service/i });
      await user.click(termsButton);

      expect(mockOpenExternalPage).toHaveBeenCalledWith('/terms');
    });

    it('renders Privacy Policy button that opens external page', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      const privacyButton = screen.getByRole('button', { name: /privacy policy/i });
      await user.click(privacyButton);

      expect(mockOpenExternalPage).toHaveBeenCalledWith('/privacy');
    });

    it('renders effective date', () => {
      renderRoute(Route);

      expect(screen.getByText(/Effective:/)).toBeInTheDocument();
    });
  });

  describe('account card', () => {
    it('renders account card with brand-colored title', () => {
      renderRoute(Route);

      expect(screen.getByText('Account')).toBeInTheDocument();
      expect(screen.getByText('Your account information')).toBeInTheDocument();
    });

    it('displays user email', () => {
      setMockUser({ email: 'user@hushbox.ai' });
      renderRoute(Route);

      expect(screen.getByText('user@hushbox.ai')).toBeInTheDocument();
    });

    it('shows Verified badge when email is verified', () => {
      setMockUser({ emailVerified: true });
      renderRoute(Route);

      expect(screen.getByText('Verified')).toBeInTheDocument();
    });

    it('shows Not verified badge when email is not verified', () => {
      setMockUser({ emailVerified: false });
      renderRoute(Route);

      expect(screen.getByText('Not verified')).toBeInTheDocument();
    });
  });

  describe('status badges', () => {
    it('shows Enabled badge when 2FA is enabled', () => {
      setMockUser({ totpEnabled: true });
      renderRoute(Route);

      const badges = screen.getAllByText('Enabled');
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });

    it('shows Disabled badge when 2FA is disabled', () => {
      setMockUser({ totpEnabled: false });
      renderRoute(Route);

      const badges = screen.getAllByText('Disabled');
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });

    it('shows Enabled badge for recovery phrase when acknowledged', () => {
      setMockUser({ hasAcknowledgedPhrase: true });
      renderRoute(Route);

      const badges = screen.getAllByText('Enabled');
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });

    it('shows Disabled badge for recovery phrase when not acknowledged', () => {
      setMockUser({ hasAcknowledgedPhrase: false });
      renderRoute(Route);

      const badges = screen.getAllByText('Disabled');
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('change password modal', () => {
    it('opens change password modal when button is clicked', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /change password.*update/i }));

      await waitFor(() => {
        expect(screen.getAllByText('Change Password')[1]).toBeInTheDocument();
      });
    });
  });

  describe('two-factor authentication modal', () => {
    it('opens 2FA setup modal when button is clicked', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /two-factor authentication.*extra/i }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.twoFactorSetupModal)).toBeInTheDocument();
      });
    });

    it('updates user state with totpEnabled after 2FA success', async () => {
      // Setup: first call returns TOTP data, second call is verify success
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              secret: 'JBSWY3DPEHPK3PXP',
              totpUri: 'otpauth://totp/test',
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /two-factor authentication.*extra/i }));

      // Click "Get Started" to trigger TOTP fetch and transition to scan step
      await user.click(await screen.findByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(screen.getByText('Scan QR Code')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /continue/i }));

      // Enter code (auto-submits on complete)
      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /done/i }));

      await waitFor(() => {
        expect(useAuthStoreMock.getState().setUser).toHaveBeenCalledWith(
          expect.objectContaining({ totpEnabled: true })
        );
      });
    }, 15_000);

    it('opens 2FA disable modal when button is clicked and 2FA is enabled', async () => {
      setMockUser({ totpEnabled: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /two-factor authentication.*manage/i }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.disableTwoFactorModal)).toBeInTheDocument();
      });
    });

    it('updates user state with totpEnabled false after 2FA disable success', async () => {
      setMockUser({ totpEnabled: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /two-factor authentication.*manage/i }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.disableTwoFactorModal)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });

      // Enter OTP (auto-submits on 6 digits)
      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(useAuthStoreMock.getState().setUser).toHaveBeenCalledWith(
          expect.objectContaining({ totpEnabled: false })
        );
      });
    }, 15_000);
  });

  describe('preferences card', () => {
    it('renders Preferences card with title and description', () => {
      renderRoute(Route);

      expect(screen.getByText('Preferences')).toBeInTheDocument();
      expect(screen.getByText('Customize how AI responds to you')).toBeInTheDocument();
    });

    it('renders Custom Instructions setting item', () => {
      renderRoute(Route);

      expect(screen.getByText('Custom Instructions')).toBeInTheDocument();
      expect(
        screen.getByText("Tell the AI about yourself and how you'd like it to respond")
      ).toBeInTheDocument();
    });

    it('shows Active badge when custom instructions are set', () => {
      mockUseAuthStore.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          user: mockAuthStoreState.user,
          customInstructions: 'Be concise',
        })
      );

      renderRoute(Route);

      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('shows Not set badge when custom instructions are null', () => {
      mockUseAuthStore.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          user: mockAuthStoreState.user,
          customInstructions: null,
        })
      );

      renderRoute(Route);

      expect(screen.getByText('Not set')).toBeInTheDocument();
    });

    it('opens custom instructions modal when clicked', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /custom instructions.*tell the ai/i }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.customInstructionsModal)).toBeInTheDocument();
      });
    });
  });

  describe('danger zone', () => {
    it('renders the Danger zone card with destructive styling', () => {
      renderRoute(Route);
      expect(screen.getByText('Danger zone')).toBeInTheDocument();
      expect(
        screen.getByText(/permanently delete your account and all associated data/i)
      ).toBeInTheDocument();
    });

    it('renders a Delete account button under the Danger zone card', () => {
      renderRoute(Route);
      expect(screen.getByTestId(TEST_IDS.deleteAccountTrigger)).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.deleteAccountTrigger)).toHaveTextContent(
        /^Delete Account$/
      );
    });

    it('opens the DeleteAccountModal when the Delete account button is clicked', async () => {
      const user = userEvent.setup();
      renderRoute(Route);
      expect(screen.queryByTestId('delete-account-modal-stub')).not.toBeInTheDocument();

      await user.click(screen.getByTestId(TEST_IDS.deleteAccountTrigger));

      await waitFor(() => {
        expect(screen.getByTestId('delete-account-modal-stub')).toBeInTheDocument();
      });
    });
  });

  describe('recovery phrase flow', () => {
    it('opens recovery phrase modal directly when user has no phrase', async () => {
      setMockUser({ hasAcknowledgedPhrase: false });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /recovery phrase.*protect/i }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.recoveryPhraseModal)).toBeInTheDocument();
      });
    });

    it('shows confirmation modal when user already has a phrase', async () => {
      setMockUser({ hasAcknowledgedPhrase: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /recovery phrase.*protect/i }));

      await waitFor(() => {
        expect(screen.getByText('Regenerate Recovery Phrase?')).toBeInTheDocument();
        expect(
          screen.getByText(
            'You already have a recovery phrase. If you generate a new one, your previous phrase will no longer work.'
          )
        ).toBeInTheDocument();
      });
    });

    it('closes confirmation modal when Cancel is clicked', async () => {
      setMockUser({ hasAcknowledgedPhrase: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /recovery phrase.*protect/i }));

      await waitFor(() => {
        expect(screen.getByText('Regenerate Recovery Phrase?')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByText('Regenerate Recovery Phrase?')).not.toBeInTheDocument();
      });
    });

    it('updates user state with hasAcknowledgedPhrase after recovery phrase success', async () => {
      // Mock crypto.getRandomValues for deterministic verification indices (0, 1, 2)
      let callCount = 0;
      vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
        <T extends ArrayBufferView>(array: T): T => {
          if (array instanceof Uint8Array && array.length === 1) {
            array[0] = callCount++;
          }
          return array;
        }
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      setMockUser({ hasAcknowledgedPhrase: false });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /recovery phrase.*protect/i }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.wordGrid)).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /i've saved it/i }));

      await waitFor(() => {
        expect(screen.getByText('Verify Your Phrase')).toBeInTheDocument();
      });

      // Enter the 3 verification words (indices 0, 1, 2 = apple, brave, candy)
      const inputs = screen.getAllByRole('textbox');
      await user.type(inputs[0]!, 'apple');
      await user.type(inputs[1]!, 'brave');
      await user.type(inputs[2]!, 'candy');

      await user.click(screen.getByRole('button', { name: /verify/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /done/i }));

      await waitFor(() => {
        expect(useAuthStoreMock.getState().setUser).toHaveBeenCalledWith(
          expect.objectContaining({ hasAcknowledgedPhrase: true })
        );
      });
    }, 15_000);

    it('opens recovery phrase modal when Generate New is clicked', async () => {
      setMockUser({ hasAcknowledgedPhrase: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /recovery phrase.*protect/i }));

      await waitFor(() => {
        expect(screen.getByText('Regenerate Recovery Phrase?')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /generate new/i }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.recoveryPhraseModal)).toBeInTheDocument();
      });
    });
  });

  describe('route guard', () => {
    it('gates the route on authentication in beforeLoad', async () => {
      const { requireAuth } = await import('@/lib/auth');
      const beforeLoad = Route.options.beforeLoad as (() => Promise<void>) | undefined;
      expect(beforeLoad).toBeDefined();

      await beforeLoad!();

      expect(requireAuth).toHaveBeenCalledTimes(1);
    });
  });

  describe('custom instructions success', () => {
    it('closes the custom instructions modal on success', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /custom instructions.*tell the ai/i }));
      expect(screen.getByTestId(TEST_IDS.customInstructionsModal)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /mock save/i }));

      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.customInstructionsModal)).not.toBeInTheDocument();
      });
    });
  });

  describe('change password', () => {
    async function openChangePassword(): Promise<void> {
      const user = userEvent.setup();
      renderRoute(Route);
      await user.click(screen.getByRole('button', { name: /change password.*update/i }));
      await waitFor(() => {
        expect(screen.getByTestId('change-password-modal-stub')).toBeInTheDocument();
      });
    }

    it('closes the modal on success', async () => {
      const user = userEvent.setup();
      await openChangePassword();

      await user.click(screen.getByTestId('cp-onsuccess'));

      await waitFor(() => {
        expect(screen.queryByTestId('change-password-modal-stub')).not.toBeInTheDocument();
      });
    });

    it('returns success when the change-password mutation resolves', async () => {
      mockChangePassword.mockResolvedValue({ success: true });
      const user = userEvent.setup();
      await openChangePassword();

      await user.click(screen.getByTestId('cp-onsubmit'));

      await waitFor(() => {
        expect(mockChangePasswordSubmitResult).toHaveBeenCalledWith({ success: true });
      });
      expect(mockChangePassword).toHaveBeenCalledWith('cur', 'new');
    });

    it('returns the error message when the mutation throws an Error', async () => {
      mockChangePassword.mockResolvedValue({ success: false, error: 'Wrong password' });
      const user = userEvent.setup();
      await openChangePassword();

      await user.click(screen.getByTestId('cp-onsubmit'));

      await waitFor(() => {
        expect(mockChangePasswordSubmitResult).toHaveBeenCalledWith({
          success: false,
          error: 'Wrong password',
        });
      });
    });

    it('returns a bare failure when the mutation rejects with a non-Error', async () => {
      mockChangePassword.mockRejectedValue('boom');
      const user = userEvent.setup();
      await openChangePassword();

      await user.click(screen.getByTestId('cp-onsubmit'));

      await waitFor(() => {
        expect(mockChangePasswordSubmitResult).toHaveBeenCalledWith({ success: false });
      });
    });
  });

  describe('auth-state races on modal success', () => {
    // The three success handlers read useAuthStore.getState().user at completion
    // and only call setUser when it is present. Nulling the store user right
    // before completion (e.g. a concurrent logout) exercises the guarded
    // no-op arm without the store user ever being written.
    it('skips the 2FA-enable user update when the store user vanished', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ secret: 'JBSWY3DPEHPK3PXP', totpUri: 'otpauth://totp/test' }),
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });

      setMockUser({ totpEnabled: false });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /two-factor authentication.*extra/i }));
      await user.click(await screen.findByRole('button', { name: /get started/i }));

      await waitFor(() => {
        expect(screen.getByText('Scan QR Code')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /continue/i }));

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
      });

      // Concurrent logout: the store user is gone by the time success fires.
      mockAuthStoreState.user = null;
      await user.click(screen.getByRole('button', { name: /done/i }));

      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.twoFactorSetupModal)).not.toBeInTheDocument();
      });
      expect(useAuthStoreMock.getState().setUser).not.toHaveBeenCalled();
    }, 15_000);

    it('skips the 2FA-disable user update when the store user vanished', async () => {
      setMockUser({ totpEnabled: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /two-factor authentication.*manage/i }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.disableTwoFactorModal)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });

      mockAuthStoreState.user = null;
      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(mockDisable2FAFinish).toHaveBeenCalled();
      });
      expect(useAuthStoreMock.getState().setUser).not.toHaveBeenCalled();
    }, 15_000);

    it('skips the recovery-phrase user update when the store user vanished', async () => {
      let callCount = 0;
      vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
        <T extends ArrayBufferView>(array: T): T => {
          if (array instanceof Uint8Array && array.length === 1) {
            array[0] = callCount++;
          }
          return array;
        }
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      setMockUser({ hasAcknowledgedPhrase: false });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /recovery phrase.*protect/i }));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.wordGrid)).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /i've saved it/i }));

      await waitFor(() => {
        expect(screen.getByText('Verify Your Phrase')).toBeInTheDocument();
      });

      const inputs = screen.getAllByRole('textbox');
      await user.type(inputs[0]!, 'apple');
      await user.type(inputs[1]!, 'brave');
      await user.type(inputs[2]!, 'candy');

      await user.click(screen.getByRole('button', { name: /verify/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
      });

      mockAuthStoreState.user = null;
      await user.click(screen.getByRole('button', { name: /done/i }));

      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.recoveryPhraseModal)).not.toBeInTheDocument();
      });
      expect(useAuthStoreMock.getState().setUser).not.toHaveBeenCalled();
    }, 15_000);
  });

  describe('signed-out shell', () => {
    it('renders defensively when no user is present', () => {
      mockAuthStoreState.user = null;
      mockUseAuthStore.mockImplementation(
        (selector: (state: { user: null; customInstructions: string | null }) => unknown) =>
          selector({ user: null, customInstructions: null })
      );

      renderRoute(Route);

      // user?.emailVerified is undefined -> "Not verified"; user?.totpEnabled
      // ?? false -> Disabled; both exercise the null-user optional chains.
      expect(screen.getByText('Not verified')).toBeInTheDocument();
      expect(screen.getByText('Add an extra layer of security')).toBeInTheDocument();
    });
  });
});
