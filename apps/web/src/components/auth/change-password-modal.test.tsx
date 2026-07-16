import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import { ChangePasswordModal } from './change-password-modal';

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: vi.fn(() => false),
  };
});

describe('ChangePasswordModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSuccess: vi.fn(),
    onSubmit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    defaultProps.onSubmit.mockResolvedValue({ success: true });
  });

  describe('rendering', () => {
    it('renders modal with title when open', () => {
      render(<ChangePasswordModal {...defaultProps} />);

      expect(screen.getByRole('heading', { name: 'Change Password' })).toBeInTheDocument();
    });

    it('does not render when open is false', () => {
      render(<ChangePasswordModal {...defaultProps} open={false} />);

      expect(screen.queryByText('Change Password')).not.toBeInTheDocument();
    });

    it('shows current password input', () => {
      render(<ChangePasswordModal {...defaultProps} />);

      expect(screen.getByLabelText(/current password/i)).toBeInTheDocument();
    });

    it('shows new password input', () => {
      render(<ChangePasswordModal {...defaultProps} />);

      expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
    });

    it('shows confirm password input', () => {
      render(<ChangePasswordModal {...defaultProps} />);

      expect(screen.getByLabelText(/confirm.*password/i)).toBeInTheDocument();
    });

    it('shows submit button', () => {
      render(<ChangePasswordModal {...defaultProps} />);

      expect(screen.getByRole('button', { name: /change password/i })).toBeInTheDocument();
    });

    it('renders show/hide password toggle for each password field', () => {
      render(<ChangePasswordModal {...defaultProps} />);

      const toggleButtons = screen.getAllByRole('button', { name: /show password/i });
      expect(toggleButtons).toHaveLength(3);
    });

    it('marks current password field with current-password autocomplete', () => {
      render(<ChangePasswordModal {...defaultProps} />);

      expect(screen.getByLabelText(/current password/i)).toHaveAttribute(
        'autocomplete',
        'current-password'
      );
    });

    it('marks new password field with new-password autocomplete', () => {
      render(<ChangePasswordModal {...defaultProps} />);

      expect(screen.getByLabelText(/^new password$/i)).toHaveAttribute(
        'autocomplete',
        'new-password'
      );
    });

    it('marks confirm password field with new-password autocomplete', () => {
      render(<ChangePasswordModal {...defaultProps} />);

      expect(screen.getByLabelText(/confirm.*password/i)).toHaveAttribute(
        'autocomplete',
        'new-password'
      );
    });

    it('shows password strength indicator on new password field', async () => {
      const user = userEvent.setup();
      render(<ChangePasswordModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/^new password$/i), 'testpass');

      expect(screen.getByTestId(TEST_IDS.strengthIndicator)).toBeInTheDocument();
    });
  });

  describe('validation', () => {
    it('disables submit button when fields are empty', () => {
      render(<ChangePasswordModal {...defaultProps} />);

      expect(screen.getByRole('button', { name: /change password/i })).toBeDisabled();
    });

    it('shows error when passwords do not match', async () => {
      const user = userEvent.setup();
      render(<ChangePasswordModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'oldpassword');
      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm.*password/i), 'different123');

      expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument();
    });

    it('enables submit when all fields are valid', async () => {
      const user = userEvent.setup();
      render(<ChangePasswordModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'oldpassword');
      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm.*password/i), 'newpassword123');

      expect(screen.getByRole('button', { name: /change password/i })).not.toBeDisabled();
    }, 15_000);

    it('shows error when new password is too short', async () => {
      const user = userEvent.setup();
      render(<ChangePasswordModal {...defaultProps} />);

      await user.type(screen.getByLabelText(/current password/i), 'oldpassword');
      await user.type(screen.getByLabelText(/^new password$/i), 'short');
      await user.type(screen.getByLabelText(/confirm.*password/i), 'short');

      expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();
    });
  });

  describe('submission', () => {
    it('calls onSubmit with current and new password', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue({ success: true });
      render(<ChangePasswordModal {...defaultProps} onSubmit={onSubmit} />);

      await user.type(screen.getByLabelText(/current password/i), 'oldpassword');
      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm.*password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /change password/i }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith({
          currentPassword: 'oldpassword',
          newPassword: 'newpassword123',
        });
      });
    }, 15_000);

    it('shows loading state during submission', async () => {
      const user = userEvent.setup();
      let resolveSubmit: (value: { success: boolean }) => void = () => {};
      const onSubmit = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSubmit = resolve;
          })
      );
      render(<ChangePasswordModal {...defaultProps} onSubmit={onSubmit} />);

      await user.type(screen.getByLabelText(/current password/i), 'oldpassword');
      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm.*password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /change password/i }));

      expect(screen.getByText(/changing/i)).toBeInTheDocument();

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- assigned in async mock callback
      if (!resolveSubmit) throw new Error('Expected resolveSubmit');
      resolveSubmit({ success: true });
      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalled();
      });
    }, 15_000);

    it('shows error when submission fails', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue({
        success: false,
        error: 'Current password is incorrect',
      });
      render(<ChangePasswordModal {...defaultProps} onSubmit={onSubmit} />);

      await user.type(screen.getByLabelText(/current password/i), 'wrongpassword');
      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm.*password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /change password/i }));

      await waitFor(() => {
        expect(screen.getByText(/current password is incorrect/i)).toBeInTheDocument();
      });
    }, 15_000);

    it('shows a fallback error when submission fails without an error message', async () => {
      const user = userEvent.setup();
      // No `error` field: exercises the `?? friendlyErrorMessage(...)` fallback.
      const onSubmit = vi.fn().mockResolvedValue({ success: false });
      render(<ChangePasswordModal {...defaultProps} onSubmit={onSubmit} />);

      await user.type(screen.getByLabelText(/current password/i), 'wrongpassword');
      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm.*password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /change password/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage('CREDENTIAL_UPDATE_FAILED'))
        ).toBeInTheDocument();
      });
    }, 15_000);

    it('calls onSuccess when password change succeeds', async () => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();
      const onSubmit = vi.fn().mockResolvedValue({ success: true });
      render(<ChangePasswordModal {...defaultProps} onSubmit={onSubmit} onSuccess={onSuccess} />);

      await user.type(screen.getByLabelText(/current password/i), 'oldpassword');
      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm.*password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /change password/i }));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    }, 15_000);
  });

  describe('Enter key navigation', () => {
    it('Enter on current password focuses new password', async () => {
      const user = userEvent.setup();
      render(<ChangePasswordModal {...defaultProps} />);

      const currentPasswordInput = screen.getByLabelText(/current password/i);
      await user.click(currentPasswordInput);
      await user.keyboard('{Enter}');

      expect(screen.getByLabelText(/^new password$/i)).toHaveFocus();
    });

    it('Enter on confirm password triggers submit when form is valid', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue({ success: true });
      render(<ChangePasswordModal {...defaultProps} onSubmit={onSubmit} />);

      await user.type(screen.getByLabelText(/current password/i), 'oldpassword');
      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm.*password/i), 'newpassword123');

      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith({
          currentPassword: 'oldpassword',
          newPassword: 'newpassword123',
        });
      });
    }, 15_000);
  });
});
