import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useNavigate } from '@tanstack/react-router';
import { TEST_IDS } from '@hushbox/shared';
import { signIn, resetPasswordViaRecovery } from '@/lib/auth';
import { renderRoute } from '@/test-utils/render';
import { Route } from './login';

// Keep the real router (createFileRoute must run for the route file); mock only
// the navigation/link the page touches.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Link: ({ children, to }: { children: React.ReactNode; to: string }): React.JSX.Element => (
      <a href={to}>{children}</a>
    ),
    useNavigate: vi.fn(() => vi.fn()),
  };
});

vi.mock('@/lib/auth', () => ({
  signIn: {
    email: vi.fn(),
  },
  resetPasswordViaRecovery: vi.fn(),
  authClient: {
    resendVerification: vi.fn(),
  },
}));

vi.mock('@/components/auth/two-factor-input', () => ({
  TwoFactorInput: ({
    open,
    onVerify,
    onSuccess,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
    onVerify: (code: string) => Promise<{ success: boolean; error?: string }>;
  }): React.JSX.Element | null =>
    open ? (
      <div data-testid="two-factor-modal">
        <button
          data-testid="verify-2fa-btn"
          onClick={() => {
            void (async () => {
              const result = await onVerify('123456');
              if (result.success) onSuccess();
            })();
          }}
        >
          Verify
        </button>
      </div>
    ) : null,
}));

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders login form with identifier and password fields', () => {
    renderRoute(Route);

    expect(screen.getByLabelText(/email or username/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
  });

  it('renders signup link', () => {
    renderRoute(Route);

    expect(screen.getByRole('link', { name: /sign up/i })).toHaveAttribute('href', '/signup');
  });

  it('marks the brand tagline as a reading surface so it renders in the serif', () => {
    renderRoute(Route);

    expect(screen.getByText('One interface. Every feature. Private.')).toHaveAttribute(
      'data-reading'
    );
  });

  it('validates identifier format on submit', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    // Hyphens invalid in both email and username
    await user.type(screen.getByLabelText(/email or username/i), 'invalid-input');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).not.toHaveBeenCalled();
  });

  it('validates required fields on submit', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).not.toHaveBeenCalled();
  });

  it('calls signIn.email with valid credentials', async () => {
    vi.mocked(signIn.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).toHaveBeenCalledWith({
      identifier: 'test@example.com',
      password: 'password123',
      keepSignedIn: false,
    });
  });

  it('calls signIn.email with valid username', async () => {
    vi.mocked(signIn.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'alice');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).toHaveBeenCalledWith({
      identifier: 'alice',
      password: 'password123',
      keepSignedIn: false,
    });
  });

  it('shows inline error on authentication failure', async () => {
    vi.mocked(signIn.email).mockResolvedValue({
      error: { message: 'Invalid credentials' },
    });
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    const errorAlert = screen
      .getAllByRole('alert')
      .find((el) => el.textContent === 'Invalid credentials');
    expect(errorAlert).toBeInTheDocument();
  });

  it('shows fallback error message when error has no message', async () => {
    vi.mocked(signIn.email).mockResolvedValue({
      error: { message: 'Authentication failed' },
    });
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    const errorAlert = screen
      .getAllByRole('alert')
      .find((el) => el.textContent === 'Authentication failed');
    expect(errorAlert).toBeInTheDocument();
  });

  it('shows success message when identifier is valid as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');

    expect(screen.getByText('Valid')).toBeInTheDocument();
  });

  it('shows error message when identifier is invalid as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'a');

    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a valid email or username');
  });

  it('shows 2FA modal when requires2FA is true', async () => {
    const mockVerifyTOTP = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(signIn.email).mockResolvedValue({
      requires2FA: true,
      verifyTOTP: mockVerifyTOTP,
    });
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(screen.getByTestId('two-factor-modal')).toBeInTheDocument();
  });

  it('navigates to chat after successful 2FA verification', async () => {
    const mockNavigate = vi.fn();
    vi.mocked(useNavigate).mockReturnValue(mockNavigate);

    const mockVerifyTOTP = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(signIn.email).mockResolvedValue({
      requires2FA: true,
      verifyTOTP: mockVerifyTOTP,
    });
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));
    await user.click(screen.getByTestId('verify-2fa-btn'));

    expect(mockVerifyTOTP).toHaveBeenCalledWith('123456');
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
  });

  it('does not show 2FA modal for normal login', async () => {
    vi.mocked(signIn.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(screen.queryByTestId('two-factor-modal')).not.toBeInTheDocument();
  });

  it('shows "Keep me signed in" checkbox unchecked by default', () => {
    renderRoute(Route);

    const checkbox = screen.getByLabelText(/keep me signed in/i);
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });

  it('passes keepSignedIn=false to signIn.email when checkbox is unchecked', async () => {
    vi.mocked(signIn.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).toHaveBeenCalledWith({
      identifier: 'test@example.com',
      password: 'password123',
      keepSignedIn: false,
    });
  });

  it('passes keepSignedIn=true to signIn.email when checkbox is checked', async () => {
    vi.mocked(signIn.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByLabelText(/keep me signed in/i));
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).toHaveBeenCalledWith({
      identifier: 'test@example.com',
      password: 'password123',
      keepSignedIn: true,
    });
  });

  describe('Enter key navigation', () => {
    it('Enter on identifier field focuses password field', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      const identifier = screen.getByLabelText(/email or username/i);
      await user.click(identifier);
      await user.keyboard('{Enter}');

      expect(screen.getByLabelText('Password')).toHaveFocus();
    });

    it('Enter on password field submits the login form', async () => {
      vi.mocked(signIn.email).mockResolvedValue({});
      const user = userEvent.setup();
      renderRoute(Route);

      await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
      await user.type(screen.getByLabelText('Password'), 'password123');
      await user.keyboard('{Enter}');

      expect(signIn.email).toHaveBeenCalledWith({
        identifier: 'test@example.com',
        password: 'password123',
        keepSignedIn: false,
      });
    });
  });

  describe('Password Recovery Flow', () => {
    it('shows "Forgot password?" link on login page', () => {
      renderRoute(Route);

      expect(screen.getByRole('button', { name: /forgot password/i })).toBeInTheDocument();
    });

    it('clicking "Forgot password?" shows recovery phrase form', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i)
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
    });

    it('does not mark the functional reset-password subtitle as a reading surface', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      // Only the brand tagline is editorial; functional subtitles stay on the sans chrome default.
      expect(
        screen.getByText('Enter your email or username and 12-word recovery phrase')
      ).not.toHaveAttribute('data-reading');
    });

    it('"Back to login" link returns to login form', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      expect(screen.getByText(/reset password/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /back to login/i }));

      expect(screen.getByText(/welcome back/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
    });

    it('pre-fills email from login form when switching to recovery mode', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      expect(screen.getByLabelText(/email/i)).toHaveValue('test@example.com');
    });

    it('submitting recovery phrase shows new password form', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reset password/i })).toBeInTheDocument();
    });

    it('shows success message after successful password reset', async () => {
      vi.mocked(resetPasswordViaRecovery).mockResolvedValue({ success: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      expect(resetPasswordViaRecovery).toHaveBeenCalledWith(
        'test@example.com',
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
        'newpassword123'
      );
      expect(screen.getByText(/password reset successful/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /return to login/i })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /return to login/i }));
      expect(screen.getByText(/welcome back/i)).toBeInTheDocument();
    });

    it('shows error message on failed recovery', async () => {
      vi.mocked(resetPasswordViaRecovery).mockResolvedValue({
        success: false,
        error: 'Invalid recovery phrase',
      });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'wrong phrase but it has twelve words total for the validation check'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      const errorAlert = screen
        .getAllByRole('alert')
        .find((el) => el.textContent === 'Invalid recovery phrase');
      expect(errorAlert).toBeInTheDocument();
    });

    it('does not submit when password is too short', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'short');
      await user.type(screen.getByLabelText(/confirm password/i), 'short');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      expect(resetPasswordViaRecovery).not.toHaveBeenCalled();
      const errorAlert = screen
        .getAllByRole('alert')
        .find((el) => el.textContent === 'Password must be at least 8 characters');
      expect(errorAlert).toBeInTheDocument();
    });

    it('does not submit when passwords do not match', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'password123');
      await user.type(screen.getByLabelText(/confirm password/i), 'different456');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      expect(resetPasswordViaRecovery).not.toHaveBeenCalled();
      const errorAlert = screen
        .getAllByRole('alert')
        .find((el) => el.textContent === 'Passwords do not match');
      expect(errorAlert).toBeInTheDocument();
    });

    it('shows strength indicator on new password field', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      expect(screen.getByTestId(TEST_IDS.strengthIndicator)).toBeInTheDocument();
    });

    it('"Back to recovery" link on Create New Password returns to recovery phrase form', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      expect(screen.getByText(/create new password/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /back to recovery/i }));

      expect(screen.getByText(/reset password/i)).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i)
      ).toBeInTheDocument();
    });

    it('"Back to login" button on recovery phrase form has pointer cursor', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      const backButton = screen.getByRole('button', { name: /back to login/i });
      expect(backButton.className).toContain('cursor-pointer');
    });

    describe('Recovery Phrase Form Validation', () => {
      it('blocks Next when email is empty', async () => {
        const user = userEvent.setup();
        renderRoute(Route);

        await user.click(screen.getByRole('button', { name: /forgot password/i }));
        await user.type(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
          'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
        );
        await user.click(screen.getByRole('button', { name: /next/i }));

        // Should still be on recovery phrase form, not new password form
        expect(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i)
        ).toBeInTheDocument();
        expect(screen.queryByLabelText(/^new password$/i)).not.toBeInTheDocument();
      });

      it('shows recovery phrase validation error when clicking Next with invalid phrase', async () => {
        const user = userEvent.setup();
        renderRoute(Route);

        await user.click(screen.getByRole('button', { name: /forgot password/i }));
        await user.type(screen.getByLabelText(/email/i), 'test@example.com');
        await user.type(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
          'only three words'
        );
        await user.click(screen.getByRole('button', { name: /next/i }));

        expect(screen.getByText('Recovery phrase must be exactly 12 words')).toBeInTheDocument();
        // Should still be on recovery phrase form
        expect(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i)
        ).toBeInTheDocument();
        expect(screen.queryByLabelText(/^new password$/i)).not.toBeInTheDocument();
      });

      it('proceeds to new password form with valid email and valid 12-word phrase', async () => {
        const user = userEvent.setup();
        renderRoute(Route);

        await user.click(screen.getByRole('button', { name: /forgot password/i }));
        await user.type(screen.getByLabelText(/email/i), 'test@example.com');
        await user.type(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
          'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
        );
        await user.click(screen.getByRole('button', { name: /next/i }));

        expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
      });

      it('shows success message when valid 12-word phrase is entered', async () => {
        const user = userEvent.setup();
        renderRoute(Route);

        await user.click(screen.getByRole('button', { name: /forgot password/i }));
        await user.type(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
          'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
        );

        expect(screen.getByText('12 words entered')).toBeInTheDocument();
      });
    });

    it('Enter on new password field focuses confirm password field', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      const newPassword = screen.getByLabelText(/^new password$/i);
      await user.click(newPassword);
      await user.keyboard('{Enter}');

      expect(screen.getByLabelText(/confirm password/i)).toHaveFocus();
    });

    it('Enter on confirm password submits recovery password reset', async () => {
      vi.mocked(resetPasswordViaRecovery).mockResolvedValue({ success: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.keyboard('{Enter}');

      expect(resetPasswordViaRecovery).toHaveBeenCalledWith(
        'test@example.com',
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
        'newpassword123'
      );
    });

    it('Enter on email field in recovery phrase form advances to new password step', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );

      // Focus email and press Enter — should trigger handleNext via requestSubmit
      await user.click(screen.getByLabelText(/email/i));
      await user.keyboard('{Enter}');

      expect(screen.getByText(/create new password/i)).toBeInTheDocument();
    });

    it('shows error message when resetPasswordViaRecovery throws', async () => {
      vi.mocked(resetPasswordViaRecovery).mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      const errorAlert = screen
        .getAllByRole('alert')
        .find((el) => el.textContent === 'Password reset failed. Please try again.');
      expect(errorAlert).toBeInTheDocument();
    });

    it('falls back to a default message when recovery reset fails without an error', async () => {
      // result.success === false but result.error is absent, so the handler
      // uses its `?? 'Password reset failed'` fallback message.
      vi.mocked(resetPasswordViaRecovery).mockResolvedValue({ success: false });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      const errorAlert = screen
        .getAllByRole('alert')
        .find((el) => el.textContent === 'Password reset failed');
      expect(errorAlert).toBeInTheDocument();
    });
  });

  describe('unverified email', () => {
    it('shows the check-your-email view when sign-in reports an unverified email', async () => {
      vi.mocked(signIn.email).mockResolvedValue({
        error: { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' },
      });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.type(screen.getByLabelText(/email or username/i), 'unverified@example.com');
      await user.type(screen.getByLabelText('Password'), 'password123');
      await user.click(screen.getByRole('button', { name: /log in/i }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /check your email/i })).toBeInTheDocument();
      });
      expect(screen.getByText('unverified@example.com')).toBeInTheDocument();
    });
  });

  it('renders password field with current-password autocomplete hint', () => {
    renderRoute(Route);

    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });
});
