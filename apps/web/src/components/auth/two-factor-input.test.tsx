import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { TwoFactorInput } from './two-factor-input';

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: vi.fn(() => false),
  };
});

// Mock document.elementFromPoint (used by input-otp, not available in jsdom)
document.elementFromPoint = vi.fn(() => null);

describe('TwoFactorInput', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSuccess: vi.fn(),
    onVerify: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    defaultProps.onVerify.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe('rendering', () => {
    it('renders modal with title when open', () => {
      render(<TwoFactorInput {...defaultProps} />);

      expect(screen.getByText('Two-Factor Authentication')).toBeInTheDocument();
      expect(screen.getByText(/enter the 6-digit code/i)).toBeInTheDocument();
    });

    it('does not render when open is false', () => {
      render(<TwoFactorInput {...defaultProps} open={false} />);

      expect(screen.queryByText('Two-Factor Authentication')).not.toBeInTheDocument();
    });

    it('shows OTP input for 6 digits', () => {
      render(<TwoFactorInput {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.otpInput)).toBeInTheDocument();
    });

    it('shows verify button', () => {
      render(<TwoFactorInput {...defaultProps} />);

      expect(screen.getByRole('button', { name: /verify/i })).toBeInTheDocument();
    });
  });

  describe('verification', () => {
    it('disables verify button when code is incomplete', () => {
      render(<TwoFactorInput {...defaultProps} />);

      expect(screen.getByRole('button', { name: /verify/i })).toBeDisabled();
    });

    it('enables verify button when 6 digits are entered', async () => {
      const user = userEvent.setup();
      render(<TwoFactorInput {...defaultProps} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      expect(screen.getByRole('button', { name: /verify/i })).not.toBeDisabled();
    });

    it('calls onVerify with the code when verify button is clicked', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: true });
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onVerify).toHaveBeenCalledWith('123456');
      });
    });

    it('calls onSuccess when verification succeeds', async () => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();
      const onVerify = vi.fn().mockResolvedValue({ success: true });
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} onSuccess={onSuccess} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it('shows error when verification fails', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: false, error: 'Invalid code' });
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText(/invalid code/i)).toBeInTheDocument();
      });
    });

    it('shows loading state during verification', async () => {
      const user = userEvent.setup();
      let resolveVerify: (value: { success: boolean }) => void = () => {};
      const onVerify = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveVerify = resolve;
          })
      );
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByText(/verifying/i)).toBeInTheDocument();
      });

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- assigned in async mock callback
      if (!resolveVerify) throw new Error('Expected resolveVerify');
      resolveVerify({ success: true });
      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalled();
      });
    });
  });

  describe('auto-submit', () => {
    it('auto-submits when all 6 digits are entered', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: true });
      const onSuccess = vi.fn();
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} onSuccess={onSuccess} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onVerify).toHaveBeenCalledWith('123456');
      });
      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });

    it('clears input on verification failure', async () => {
      const user = userEvent.setup();
      const onVerify = vi.fn().mockResolvedValue({ success: false, error: 'INVALID_TOTP_CODE' });
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /verify/i })).toBeDisabled();
      });
    });

    it('prevents double submission while verifying', async () => {
      const user = userEvent.setup();
      let resolveVerify: (value: { success: boolean }) => void = () => {};
      const onVerify = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveVerify = resolve;
          })
      );
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onVerify).toHaveBeenCalledTimes(1);
      });

      await user.click(screen.getByRole('button', { name: /verifying/i }));

      expect(onVerify).toHaveBeenCalledTimes(1);

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- assigned in async mock callback
      if (!resolveVerify) throw new Error('Expected resolveVerify');
      resolveVerify({ success: true });
      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalled();
      });
    });
  });

  describe('recovery code option', () => {
    it('shows link to use recovery code when showRecoveryOption is true', () => {
      render(<TwoFactorInput {...defaultProps} showRecoveryOption={true} />);

      expect(screen.getByRole('button', { name: /use recovery code/i })).toBeInTheDocument();
    });

    it('does not show recovery option by default', () => {
      render(<TwoFactorInput {...defaultProps} />);

      expect(screen.queryByRole('button', { name: /use recovery code/i })).not.toBeInTheDocument();
    });

    it('re-runs verification when the enabled Verify button is clicked', async () => {
      const user = userEvent.setup();
      // On success the OTP value is not cleared, so the Verify button stays
      // enabled after the auto-submit — clicking it exercises its onClick.
      const onVerify = vi.fn().mockResolvedValue({ success: true });
      render(<TwoFactorInput {...defaultProps} onVerify={onVerify} />);

      const otpInput = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(otpInput);
      await user.keyboard('123456');

      await waitFor(() => {
        expect(onVerify).toHaveBeenCalledTimes(1);
      });

      const verifyButton = screen.getByRole('button', { name: /^verify$/i });
      await waitFor(() => {
        expect(verifyButton).not.toBeDisabled();
      });
      await user.click(verifyButton);

      await waitFor(() => {
        expect(onVerify).toHaveBeenCalledTimes(2);
      });
    });

    it('calls onRecoveryClick when recovery link is clicked', async () => {
      const user = userEvent.setup();
      const onRecoveryClick = vi.fn();
      render(
        <TwoFactorInput
          {...defaultProps}
          showRecoveryOption={true}
          onRecoveryClick={onRecoveryClick}
        />
      );

      await user.click(screen.getByRole('button', { name: /use recovery code/i }));

      expect(onRecoveryClick).toHaveBeenCalledTimes(1);
    });
  });
});
