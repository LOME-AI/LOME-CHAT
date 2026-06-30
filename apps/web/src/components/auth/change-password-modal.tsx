import * as React from 'react';
import { useState, useCallback, useMemo, useRef } from 'react';
import { UserMessageError, useAsyncAction } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav';
import { useMobileAutoFocus } from '@/hooks/ui/use-mobile-auto-focus';
import { AuthPasswordInput } from '@/components/auth/auth-password-input';
import { ActionModal } from '@/components/shared/action-modal';

interface ChangePasswordModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  onSubmit: (data: {
    currentPassword: string;
    newPassword: string;
  }) => Promise<{ success: boolean; error?: string }>;
}

const MIN_PASSWORD_LENGTH = 8;

export function ChangePasswordModal({
  open,
  onOpenChange,
  onSuccess,
  onSubmit,
}: Readonly<ChangePasswordModalProps>): React.JSX.Element | null {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const asyncAction = useAsyncAction();

  const passwordsMatch = useMemo(() => {
    if (confirmPassword === '') return true;
    return newPassword === confirmPassword;
  }, [newPassword, confirmPassword]);

  const passwordLongEnough = useMemo(() => {
    if (newPassword === '') return true;
    return newPassword.length >= MIN_PASSWORD_LENGTH;
  }, [newPassword]);

  const isValid = useMemo(() => {
    return (
      currentPassword.length > 0 &&
      newPassword.length >= MIN_PASSWORD_LENGTH &&
      newPassword === confirmPassword
    );
  }, [currentPassword, newPassword, confirmPassword]);

  // Bridge to the legacy {success,error} shape. The error string is already
  // user-facing, so throw a UserMessageError — useAsyncAction will route it
  // straight to the inline error region without re-running it through
  // legacyFriendlyErrorMessage (which only knows LegacyErrorCode constants).
  const handleSubmit = useCallback(async (): Promise<void> => {
    const result = await onSubmit({ currentPassword, newPassword });
    if (!result.success) {
      throw new UserMessageError(result.error ?? 'Failed to change password. Please try again.');
    }
    onSuccess();
  }, [currentPassword, newPassword, onSubmit, onSuccess]);

  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const handleOpenAutoFocus = useMobileAutoFocus();

  // Destructure clearError (a stable useCallback) so the reset effect's deps
  // don't transitively include `asyncAction` — which is a fresh object every
  // render and would otherwise re-fire the effect, wiping form state on every
  // keystroke.
  const { clearError } = asyncAction;
  React.useEffect(() => {
    if (open) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      clearError();
    }
  }, [open, clearError]);

  if (!open) return null;

  return (
    <ActionModal
      open={open}
      onOpenChange={onOpenChange}
      title="Change Password"
      ariaLabel="Change password"
      asyncAction={asyncAction}
      primary={{
        label: 'Change Password',
        loadingLabel: 'Changing…',
        onSubmit: handleSubmit,
        disabled: !isValid,
        testId: TEST_IDS.changePasswordSubmit,
        type: 'submit',
        form: 'change-password-form',
      }}
      testId={TEST_IDS.changePasswordModal}
      onOpenAutoFocus={handleOpenAutoFocus}
    >
      <p className="text-muted-foreground text-sm">
        Enter your current password and choose a new one.
      </p>
      <form
        id="change-password-form"
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <div className="space-y-4">
          <AuthPasswordInput
            id="current-password"
            label="Current Password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
            }}
          />

          <AuthPasswordInput
            id="new-password"
            label="New Password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
            }}
            showStrength
            error={
              passwordLongEnough
                ? undefined
                : `Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`
            }
          />

          <AuthPasswordInput
            id="confirm-password"
            label="Confirm New Password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
            }}
            error={passwordsMatch ? undefined : 'Passwords do not match'}
          />
        </div>
      </form>
    </ActionModal>
  );
}
