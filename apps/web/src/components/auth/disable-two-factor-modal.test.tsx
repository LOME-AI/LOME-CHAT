import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import { DisableTwoFactorModal } from './disable-two-factor-modal';

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: vi.fn(() => false),
  };
});

const { mockDisable2FAInit, mockDisable2FAFinish } = vi.hoisted(() => ({
  mockDisable2FAInit: vi.fn(),
  mockDisable2FAFinish: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  disable2FAInit: (...args: unknown[]) => mockDisable2FAInit(...args),
  disable2FAFinish: (...args: unknown[]) => mockDisable2FAFinish(...args),
}));

document.elementFromPoint = vi.fn(() => null);

describe('DisableTwoFactorModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSuccess: vi.fn(),
  };

  const STUB_DISABLE_2FA_SESSION_ID = '00000000-0000-4000-8000-deadbeefdead';

  beforeEach(() => {
    vi.clearAllMocks();
    mockDisable2FAInit.mockResolvedValue({
      success: true,
      ke3: [4, 5, 6],
      disable2FASessionId: STUB_DISABLE_2FA_SESSION_ID,
    });
    mockDisable2FAFinish.mockResolvedValue({ success: true });
  });

  describe('rendering', () => {
    it('renders modal with title when open', () => {
      render(<DisableTwoFactorModal {...defaultProps} />);

      expect(
        screen.getByRole('heading', { name: 'Disable Two-Factor Authentication' })
      ).toBeInTheDocument();
    });

    it('does not render when open is false', () => {
      render(<DisableTwoFactorModal {...defaultProps} open={false} />);

      expect(screen.queryByText('Disable Two-Factor Authentication')).not.toBeInTheDocument();
    });

    it('shows password step initially', () => {
      render(<DisableTwoFactorModal {...defaultProps} />);

      expect(screen.getByLabelText(/current password/i)).toBeInTheDocument();
    });

    it('shows Continue button disabled initially', () => {
      render(<DisableTwoFactorModal {...defaultProps} />);

      expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    });
  });

  describe('Step 1: Password', () => {
    it('enables Continue button when password is entered', async () => {
      const user = userEvent.setup();
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');

      expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled();
    });

    it('shows loading state during password verification', async () => {
      const user = userEvent.setup();
      mockDisable2FAInit.mockImplementation(() => new Promise(() => {}));
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      expect(screen.getByText(/verifying/i)).toBeInTheDocument();
    });

    it('advances to code step on successful password verification', async () => {
      const user = userEvent.setup();
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });
    });

    it('shows error on failed password verification', async () => {
      const user = userEvent.setup();
      mockDisable2FAInit.mockResolvedValue({
        success: false,
        error: 'Incorrect password.',
      });
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'wrongpassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Incorrect password.')).toBeInTheDocument();
      });
    });

    it('shows error on network failure', async () => {
      const user = userEvent.setup();
      mockDisable2FAInit.mockRejectedValue(new Error('Network error'));
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(
          screen.getByText('Failed to verify password. Please try again.')
        ).toBeInTheDocument();
      });
    });

    it('does not show back button on step 1', () => {
      render(<DisableTwoFactorModal {...defaultProps} />);

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });

    it('Enter on password input triggers password submission', async () => {
      const user = userEvent.setup();
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });
    });
  });

  describe('Step 2: TOTP Code', () => {
    async function goToCodeStep(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = userEvent.setup();
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });

      return user;
    }

    it('shows OTP input and Disable 2FA button', async () => {
      await goToCodeStep();

      expect(screen.getByTestId(TEST_IDS.otpInput)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /disable 2fa/i })).toBeInTheDocument();
    });

    it('disables Disable 2FA button until 6 digits entered', async () => {
      await goToCodeStep();

      expect(screen.getByRole('button', { name: /disable 2fa/i })).toBeDisabled();
    });

    it('shows back button on step 2', async () => {
      await goToCodeStep();

      expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    });

    it('returns to password step when back is clicked', async () => {
      const user = await goToCodeStep();

      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByLabelText(/current password/i)).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: 'Disable Two-Factor Authentication' })
      ).toBeInTheDocument();
    });

    it('shows loading state during disable', async () => {
      mockDisable2FAFinish.mockImplementation(() => new Promise(() => {}));
      const user = await goToCodeStep();

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText(/disabling/i)).toBeInTheDocument();
      });
    });

    it('calls onSuccess on successful disable', async () => {
      const onSuccess = vi.fn();
      const user = userEvent.setup();
      render(<DisableTwoFactorModal {...defaultProps} onSuccess={onSuccess} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it('shows error on invalid TOTP code', async () => {
      mockDisable2FAFinish.mockResolvedValue({
        success: false,
        error: 'Invalid verification code. Please try again.',
      });
      const user = await goToCodeStep();

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(
          screen.getByText('Invalid verification code. Please try again.')
        ).toBeInTheDocument();
      });
    });

    it('auto-submits when all 6 digits are entered', async () => {
      const onSuccess = vi.fn();
      const user = userEvent.setup();
      render(<DisableTwoFactorModal {...defaultProps} onSuccess={onSuccess} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter Verification Code')).toBeInTheDocument();
      });

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(mockDisable2FAFinish).toHaveBeenCalledWith(
          [4, 5, 6],
          '123456',
          STUB_DISABLE_2FA_SESSION_ID
        );
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it('shows loading state on auto-submit', async () => {
      mockDisable2FAFinish.mockImplementation(() => new Promise(() => {}));
      const user = await goToCodeStep();

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText(/disabling/i)).toBeInTheDocument();
      });
    });

    it('shows error on auto-submit failure', async () => {
      mockDisable2FAFinish.mockResolvedValue({
        success: false,
        error: 'Invalid verification code. Please try again.',
      });
      const user = await goToCodeStep();

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(
          screen.getByText('Invalid verification code. Please try again.')
        ).toBeInTheDocument();
      });
    });

    it('shows an internal error when the disable session is missing', async () => {
      // Init succeeds but returns no session id: the verify guard short-circuits
      // to an INTERNAL error before ever calling disable2FAFinish.
      mockDisable2FAInit.mockResolvedValue({
        success: true,
        ke3: [4, 5, 6],
        disable2FASessionId: null,
      });
      const user = await goToCodeStep();

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText(friendlyErrorMessage('INTERNAL'))).toBeInTheDocument();
      });
      expect(mockDisable2FAFinish).not.toHaveBeenCalled();
    });

    it('re-runs verification when the enabled Disable 2FA button is clicked', async () => {
      // On success the OTP value persists, leaving the button enabled — clicking
      // it exercises the destructive button's onClick handler.
      const user = await goToCodeStep();

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(mockDisable2FAFinish).toHaveBeenCalledTimes(1);
      });

      const disableButton = screen.getByRole('button', { name: /disable 2fa/i });
      await waitFor(() => {
        expect(disableButton).not.toBeDisabled();
      });
      await user.click(disableButton);

      await waitFor(() => {
        expect(mockDisable2FAFinish).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('password error clearing', () => {
    it('clears the password error when the field is edited', async () => {
      mockDisable2FAInit.mockResolvedValue({ success: false, error: 'Wrong password' });
      const user = userEvent.setup();
      render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText('Wrong password')).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/current password/i), 'x');

      await waitFor(() => {
        expect(screen.queryByText('Wrong password')).not.toBeInTheDocument();
      });
    });
  });

  describe('state reset', () => {
    it('resets all state when modal reopens', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<DisableTwoFactorModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'mypassword');

      rerender(<DisableTwoFactorModal {...defaultProps} open={false} />);

      rerender(<DisableTwoFactorModal {...defaultProps} open={true} />);

      expect(screen.getByLabelText(/current password/i)).toHaveValue('');
      expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    });
  });
});
