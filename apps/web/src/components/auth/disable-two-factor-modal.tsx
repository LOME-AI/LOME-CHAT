import * as React from 'react';
import { useState, useCallback, useRef } from 'react';
import {
  InlineFormError,
  ModalActions,
  Overlay,
  OverlayContent,
  OverlayHeader,
  UserMessageError,
  useAsyncAction,
} from '@hushbox/ui';
import { TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav';
import { useMobileAutoFocus } from '@/hooks/ui/use-mobile-auto-focus';
import { useOtpVerification } from '@/hooks/auth/use-otp-verification';
import { AuthPasswordInput } from '@/components/auth/auth-password-input';
import { OtpInput } from '@/components/auth/otp-input';
import { disable2FAInit, disable2FAFinish } from '@/lib/auth';

interface DisableTwoFactorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function DisableTwoFactorModal({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<DisableTwoFactorModalProps>): React.JSX.Element | null {
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [password, setPassword] = useState('');
  const [ke3, setKe3] = useState<number[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const passwordAction = useAsyncAction();

  const disableVerify = useCallback(
    async (code: string): Promise<{ success: boolean; error?: string }> => {
      if (!ke3 || !sessionId) return { success: false, error: friendlyErrorMessage('INTERNAL') };
      return disable2FAFinish(ke3, code, sessionId);
    },
    [ke3, sessionId]
  );

  const {
    otpValue,
    setOtpValue,
    error: otpError,
    isVerifying,
    handleVerify,
    handleComplete,
    reset: resetOtp,
  } = useOtpVerification({ onVerify: disableVerify, onSuccess });

  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const handleOpenAutoFocus = useMobileAutoFocus();

  const { clearError } = passwordAction;
  React.useEffect(() => {
    if (open) {
      setStep('password');
      setPassword('');
      setKe3(null);
      setSessionId(null);
      clearError();
      resetOtp();
    }
  }, [open, resetOtp, clearError]);

  const handlePasswordSubmit = useCallback(async (): Promise<void> => {
    if (password.length === 0) return;
    let result: Awaited<ReturnType<typeof disable2FAInit>>;
    try {
      result = await disable2FAInit(password);
    } catch {
      throw new UserMessageError(friendlyErrorMessage('CREDENTIAL_VERIFICATION_FAILED'));
    }
    if (!result.success) {
      throw new UserMessageError(result.error);
    }
    setKe3(result.ke3);
    setSessionId(result.disable2FASessionId);
    setStep('code');
  }, [password]);

  const triggerPasswordSubmit = useCallback((): void => {
    void passwordAction.run(handlePasswordSubmit);
  }, [passwordAction, handlePasswordSubmit]);

  const handleBack = useCallback(() => {
    setStep('password');
    resetOtp();
  }, [resetOtp]);

  if (!open) return null;

  const {
    isPending: isPasswordSubmitting,
    error: passwordError,
    errorKey: passwordErrorKey,
  } = passwordAction;
  const isBusy = isPasswordSubmitting || isVerifying;

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Disable two-factor authentication"
      onOpenAutoFocus={handleOpenAutoFocus}
      currentStep={step === 'password' ? 1 : 2}
      dismissible={!isBusy}
      {...(step === 'code' && { onBack: handleBack })}
    >
      <OverlayContent data-testid={TEST_IDS.disableTwoFactorModal} className="w-[75vw]">
        {step === 'password' ? (
          <>
            <OverlayHeader
              title="Disable Two-Factor Authentication"
              description="Enter your password to confirm. This will remove the extra security layer from your account."
            />

            <form
              id="disable-2fa-password-form"
              ref={formRef}
              onSubmit={(e) => {
                e.preventDefault();
              }}
            >
              <AuthPasswordInput
                id="current-password"
                label="Current Password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (passwordError !== null) clearError();
                }}
              />
            </form>

            <InlineFormError error={passwordError} errorKey={passwordErrorKey} />

            <ModalActions
              primary={{
                label: 'Continue',
                type: 'submit',
                form: 'disable-2fa-password-form',
                onClick: triggerPasswordSubmit,
                disabled: password.length === 0,
                loading: isPasswordSubmitting,
                loadingLabel: 'Verifying...',
              }}
            />
          </>
        ) : (
          <>
            <OverlayHeader
              title="Enter Verification Code"
              description="Enter the 6-digit code from your authenticator app to confirm."
            />

            <OtpInput
              value={otpValue}
              onChange={setOtpValue}
              onComplete={handleComplete}
              error={otpError}
            />

            <ModalActions
              primary={{
                label: 'Disable 2FA',
                variant: 'destructive',
                onClick: () => {
                  handleVerify();
                },
                disabled: otpValue.length !== 6,
                loading: isVerifying,
                loadingLabel: 'Disabling...',
              }}
            />
          </>
        )}
      </OverlayContent>
    </Overlay>
  );
}
