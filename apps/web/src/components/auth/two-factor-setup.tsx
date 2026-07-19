import * as React from 'react';
import { useState, useCallback } from 'react';
import { Copy, Check, Loader2 } from 'lucide-react';
import { QRCode } from 'react-qrcode-logo';
import {
  Button,
  InlineFormError,
  ModalActions,
  Overlay,
  OverlayContent,
  UserMessageError,
  useAsyncAction,
  type UseAsyncActionReturn,
} from '@hushbox/ui';
import logoUrl from '@hushbox/ui/assets/HushBoxLogo.png';
import { legacyErrorResponseSchema, TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import { client } from '@/lib/api-client';
import { useMobileAutoFocus } from '@/hooks/ui/use-mobile-auto-focus';
import { useOtpVerification } from '@/hooks/auth/use-otp-verification';
import { OtpInput } from '@/components/auth/otp-input';
import { ModalSuccessStep } from '@/components/shared/modal-success-step';

interface TwoFactorSetupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

type Step = 'loading' | 'scan' | 'verify' | 'success';

interface TotpData {
  secret: string;
  totpUri: string;
}

interface StepContentProps {
  readonly step: Step;
  readonly totpData: TotpData | null;
  readonly copied: boolean;
  readonly otpValue: string;
  readonly otpError: string | null;
  readonly fetchAction: UseAsyncActionReturn;
  readonly isVerifying: boolean;
  readonly onStart: () => void;
  readonly onCopy: () => void;
  readonly onContinueToVerify: () => void;
  readonly setOtpValue: (value: string) => void;
  readonly onOtpComplete: (value: string) => void;
  readonly onVerify: () => void;
  readonly onDone: () => void;
}

function StepContent({
  step,
  totpData,
  copied,
  otpValue,
  otpError,
  fetchAction,
  isVerifying,
  onStart,
  onCopy,
  onContinueToVerify,
  setOtpValue,
  onOtpComplete,
  onVerify,
  onDone,
}: Readonly<StepContentProps>): React.JSX.Element | null {
  if (step === 'loading') {
    return <LoadingStep fetchAction={fetchAction} onStart={onStart} />;
  }

  if (step === 'scan' && totpData) {
    return (
      <ScanStep
        totpData={totpData}
        copied={copied}
        onCopy={onCopy}
        onContinue={onContinueToVerify}
      />
    );
  }

  if (step === 'verify') {
    return (
      <VerifyStep
        otpValue={otpValue}
        onOtpChange={setOtpValue}
        onOtpComplete={onOtpComplete}
        error={otpError}
        isVerifying={isVerifying}
        onVerify={onVerify}
      />
    );
  }

  if (step === 'success') {
    return (
      <ModalSuccessStep
        heading="Two-Factor Authentication Enabled"
        description="Your account is now more secure. You'll need to enter a code from your authenticator app each time you log in."
        primaryLabel="Done"
        onDone={onDone}
      />
    );
  }

  return null;
}

async function fetchTotpSetup(): Promise<
  { ok: true; data: TotpData } | { ok: false; error: string }
> {
  const res = await client.auth['2fa'].setup.$post();

  if (!res.ok) {
    const body: unknown = await res.json();
    const parsed = legacyErrorResponseSchema.safeParse(body);
    return {
      ok: false,
      error: parsed.success
        ? friendlyErrorMessage(parsed.data.code)
        : friendlyErrorMessage('TWO_FACTOR_SETUP_FAILED'),
    };
  }

  const data = (await res.json()) as TotpData;
  return { ok: true, data };
}

async function verifyTotpCode(code: string): Promise<{ success: boolean; error?: string }> {
  const response = await client.auth['2fa'].verify.$post({ json: { code } });

  if (!response.ok) {
    const body: unknown = await response.json();
    const parsed = legacyErrorResponseSchema.safeParse(body);
    return {
      success: false,
      error: parsed.success
        ? friendlyErrorMessage(parsed.data.code)
        : friendlyErrorMessage('TWO_FACTOR_VERIFICATION_FAILED'),
    };
  }

  return { success: true };
}

export function TwoFactorSetup({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<TwoFactorSetupProps>): React.JSX.Element | null {
  const [step, setStep] = useState<Step>('loading');
  const [totpData, setTotpData] = useState<TotpData | null>(null);
  const [copied, setCopied] = useState(false);
  const fetchAction = useAsyncAction();

  const handleVerifySuccess = useCallback(() => {
    setStep('success');
  }, []);

  const {
    otpValue,
    setOtpValue,
    error: otpError,
    isVerifying,
    handleVerify,
    handleComplete,
    reset: resetOtp,
  } = useOtpVerification({
    onVerify: verifyTotpCode,
    onSuccess: handleVerifySuccess,
  });

  const { clearError: clearFetchError } = fetchAction;
  React.useEffect(() => {
    if (open) {
      setStep('loading');
      clearFetchError();
      setCopied(false);
      setTotpData(null);
      resetOtp();
    }
  }, [open, resetOtp, clearFetchError]);

  const handleStart = useCallback((): void => {
    void fetchAction.run(async () => {
      let result: Awaited<ReturnType<typeof fetchTotpSetup>>;
      try {
        result = await fetchTotpSetup();
      } catch {
        throw new UserMessageError(friendlyErrorMessage('TWO_FACTOR_SETUP_FAILED'));
      }
      if (!result.ok) {
        throw new UserMessageError(result.error);
      }
      setTotpData(result.data);
      setStep('scan');
    });
  }, [fetchAction]);

  const handleCopy = useCallback(() => {
    if (!totpData) return;
    void navigator.clipboard.writeText(totpData.secret);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 3000);
  }, [totpData]);

  const handleContinueToVerify = useCallback(() => {
    setStep('verify');
    resetOtp();
  }, [resetOtp]);

  const handleBackToIntro = useCallback(() => {
    setStep('loading');
    clearFetchError();
  }, [clearFetchError]);

  const handleBackToScan = useCallback(() => {
    setStep('scan');
    resetOtp();
  }, [resetOtp]);

  const handleDone = useCallback(() => {
    onSuccess();
  }, [onSuccess]);

  const handleOpenAutoFocus = useMobileAutoFocus();

  if (!open) return null;

  const currentStep = (() => {
    if (step === 'loading') return 1;
    if (step === 'scan') return 2;
    if (step === 'verify') return 3;
    return 4;
  })();
  const showBackButton = step === 'scan' || step === 'verify';

  const handleBack = step === 'verify' ? handleBackToScan : handleBackToIntro;
  const isBusy = fetchAction.isPending || isVerifying;

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Two-factor authentication setup"
      onOpenAutoFocus={handleOpenAutoFocus}
      currentStep={currentStep}
      dismissible={!isBusy}
      {...(showBackButton && { onBack: handleBack })}
    >
      <OverlayContent data-testid={TEST_IDS.twoFactorSetupModal} className="w-[75vw]">
        <StepContent
          step={step}
          totpData={totpData}
          copied={copied}
          otpValue={otpValue}
          otpError={otpError}
          fetchAction={fetchAction}
          isVerifying={isVerifying}
          onStart={handleStart}
          onCopy={handleCopy}
          onContinueToVerify={handleContinueToVerify}
          setOtpValue={setOtpValue}
          onOtpComplete={handleComplete}
          /* v8 ignore start -- the OTP auto-submits on the 6th digit, so the Verify button is never idle-and-enabled on the verify step: success unmounts VerifyStep and failure clears the input */
          onVerify={() => {
            handleVerify();
          }}
          /* v8 ignore stop */
          onDone={handleDone}
        />
      </OverlayContent>
    </Overlay>
  );
}

interface LoadingStepProps {
  fetchAction: UseAsyncActionReturn;
  onStart: () => void;
}

function LoadingStep({ fetchAction, onStart }: Readonly<LoadingStepProps>): React.JSX.Element {
  const { isPending: isLoading, error, errorKey } = fetchAction;
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Set Up Two-Factor Authentication</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Add an extra layer of security. You&apos;ll need an authenticator app like Google
          Authenticator, Authy, or 1Password.
        </p>
      </div>

      <InlineFormError error={error} errorKey={errorKey} />

      {error === null && isLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
          <span className="text-muted-foreground ml-2">Loading...</span>
        </div>
      )}

      {error === null && !isLoading && (
        <ModalActions
          primary={{
            label: 'Get Started →',
            onClick: onStart,
          }}
        />
      )}
    </div>
  );
}

interface ScanStepProps {
  totpData: TotpData;
  copied: boolean;
  onCopy: () => void;
  onContinue: () => void;
}

function ScanStep({
  totpData,
  copied,
  onCopy,
  onContinue,
}: Readonly<ScanStepProps>): React.JSX.Element {
  const qrSize = 180;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Scan QR Code</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Open your authenticator app and scan this code.
        </p>
      </div>

      <div className="flex justify-center py-4">
        <div className="rounded-lg bg-white p-3">
          <QRCode
            value={totpData.totpUri}
            size={qrSize}
            qrStyle="fluid"
            eyeRadius={12}
            eyeColor="#ec4755"
            logoImage={logoUrl}
            logoWidth={qrSize * 0.2}
            logoPadding={5}
            logoPaddingStyle="circle"
            ecLevel="H"
            removeQrCodeBehindLogo={true}
          />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-muted-foreground text-center text-sm">
          Can&apos;t scan? Enter this code manually:
        </p>
        <div className="bg-muted/50 flex items-center gap-2 rounded-md border p-2">
          <code className="flex-1 text-center font-mono text-sm">{totpData.secret}</code>
          <Button variant="ghost" size="icon-sm" onClick={onCopy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            <span className="sr-only">{copied ? 'Copied' : 'Copy'}</span>
          </Button>
        </div>
      </div>

      <ModalActions
        primary={{
          label: 'Continue →',
          onClick: onContinue,
        }}
      />
    </div>
  );
}

interface VerifyStepProps {
  otpValue: string;
  onOtpChange: (value: string) => void;
  onOtpComplete: (value: string) => void;
  error: string | null;
  isVerifying: boolean;
  onVerify: () => void;
}

function VerifyStep({
  otpValue,
  onOtpChange,
  onOtpComplete,
  error,
  isVerifying,
  onVerify,
}: Readonly<VerifyStepProps>): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Enter Verification Code</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Enter the 6-digit code from your authenticator app.
        </p>
      </div>

      <OtpInput value={otpValue} onChange={onOtpChange} onComplete={onOtpComplete} error={error} />

      <ModalActions
        primary={{
          label: 'Verify →',
          onClick: onVerify,
          disabled: otpValue.length !== 6,
          loading: isVerifying,
          loadingLabel: 'Verifying...',
        }}
      />
    </div>
  );
}
