import * as React from 'react';
import { useState, useCallback, useMemo, useRef } from 'react';
import {
  Checkbox,
  InlineFormError,
  Input,
  Label,
  ModalActions,
  Overlay,
  OverlayContent,
  OverlayHeader,
  UserMessageError,
  useAsyncAction,
  type UseAsyncActionReturn,
} from '@hushbox/ui';
import {
  createOpaqueClient,
  startLogin,
  finishLogin,
  OPAQUE_SERVER_IDENTIFIER,
} from '@hushbox/crypto';
import {
  DELETE_ACCOUNT_CONFIRMATION_PHRASE,
  formatLockoutMessage,
  friendlyErrorMessage,
  nanoUsdToDollarString,
  parseNanoUSD,
  ROUTES,
  TEST_IDS,
  type UserFacingMessage,
} from '@hushbox/shared';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav';
import { useMobileAutoFocus } from '@/hooks/ui/use-mobile-auto-focus';
import { useDeleteAccountInit, useDeleteAccountFinish } from '@/hooks/auth/use-delete-account';
import { useBalance } from '@/hooks/billing/billing';
import { useAuthStore, clearLocalAuthState } from '@/lib/auth';
import { getErrorBody } from '@/lib/api';
import { AuthPasswordInput } from '@/components/auth/auth-password-input';
import { OtpInput } from '@/components/auth/otp-input';

interface DeleteAccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = 'intro' | 'wallet' | 'password' | 'totp' | 'final';

// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- DOM id for aria-describedby, not a credential
const PASSWORD_ERROR_ID = 'delete-account-password-error';
const CONFIRMATION_ERROR_ID = 'delete-account-confirmation-error';

// Returns a duration-aware lockout message when the server included
// retryAfterSeconds. The deletion gate reports lockout as
// DELETE_ACCOUNT_LOCKED + retryAfterSeconds, so key on the detail rather than a
// specific code — the countdown renders regardless of which code carried it.
function messageFor(code: string, details?: Record<string, unknown>): UserFacingMessage {
  if (typeof details?.['retryAfterSeconds'] === 'number') {
    return formatLockoutMessage(details['retryAfterSeconds']);
  }
  return friendlyErrorMessage(code);
}

function formatBalanceDollars(rawNanoUsd: string): string {
  return `$${nanoUsdToDollarString(rawNanoUsd)}`;
}

// Translate an arbitrary thrown error into a UserMessageError carrying a
// user-facing message. Lockout payloads with a `retryAfterSeconds` detail
// produce a duration-aware string; other ApiError bodies use their code's
// friendly message; opaque errors fall back to INTERNAL's generic message.
function mapOpaqueError(error: unknown): UserMessageError {
  if (error instanceof UserMessageError) return error;
  const body = getErrorBody(error);
  return new UserMessageError(
    body ? messageFor(body.code, body.details) : friendlyErrorMessage('INTERNAL')
  );
}

function computeStepNumber(step: Step, hasBalance: boolean, totpEnabled: boolean): number {
  const sequence: Step[] = ['intro'];
  if (hasBalance) sequence.push('wallet');
  sequence.push('password');
  if (totpEnabled) sequence.push('totp');
  sequence.push('final');
  return sequence.indexOf(step) + 1;
}

function IntroStep({
  onContinue,
  onCancel,
  balanceLoading,
}: Readonly<{
  onContinue: () => void;
  onCancel: () => void;
  balanceLoading: boolean;
}>): React.JSX.Element {
  return (
    <>
      <OverlayHeader title="Delete your account" />
      <div className="space-y-3 text-sm">
        <p>
          Deleting your account removes your conversations, files, custom instructions, and
          encryption keys from our servers. You will be signed out immediately and unable to log
          back in.
        </p>
        <p>
          Anonymized billing records are retained for tax and accounting compliance. These records
          have no link back to your identity once your account is gone.
        </p>
        <p className="font-medium">This action cannot be undone.</p>
      </div>
      <ModalActions
        cancel={{ label: 'Cancel', onClick: onCancel, testId: TEST_IDS.deleteAccountCancel }}
        primary={{
          label: 'Continue',
          onClick: onContinue,
          // Block advancing until balance is known — otherwise we'd silently
          // skip the forfeit step for a user with credits.
          disabled: balanceLoading,
          loading: balanceLoading,
          loadingLabel: 'Loading...',
          testId: TEST_IDS.deleteAccountIntroContinue,
        }}
      />
    </>
  );
}

function WalletStep({
  balanceDisplay,
  acknowledged,
  onAcknowledgedChange,
  onContinue,
  onCancel,
}: Readonly<{
  balanceDisplay: string;
  acknowledged: boolean;
  onAcknowledgedChange: (checked: boolean) => void;
  onContinue: () => void;
  onCancel: () => void;
}>): React.JSX.Element {
  return (
    <>
      <OverlayHeader title="Forfeit remaining credit" />
      <div className="space-y-3 text-sm">
        <p>
          You have <span className="font-semibold">{balanceDisplay}</span> in credits. They will be
          permanently forfeited and cannot be refunded.
        </p>
        <Label className="flex items-start gap-2">
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(checked) => {
              onAcknowledgedChange(checked === true);
            }}
            aria-label={`I understand I will forfeit ${balanceDisplay} and it cannot be refunded.`}
            data-testid={TEST_IDS.deleteAccountForfeitCheckbox}
          />
          <span>I understand I will forfeit {balanceDisplay} and it cannot be refunded.</span>
        </Label>
      </div>
      <ModalActions
        cancel={{ label: 'Cancel', onClick: onCancel }}
        primary={{
          label: 'Continue',
          onClick: onContinue,
          disabled: !acknowledged,
          testId: TEST_IDS.deleteAccountWalletContinue,
        }}
      />
    </>
  );
}

function PasswordStep({
  password,
  onPasswordChange,
  passwordAction,
  onSubmit,
  onCancel,
  formRef,
}: Readonly<{
  password: string;
  onPasswordChange: (value: string) => void;
  passwordAction: UseAsyncActionReturn;
  onSubmit: () => void;
  onCancel: () => void;
  formRef: React.RefObject<HTMLFormElement | null>;
}>): React.JSX.Element {
  const { isPending: isSubmitting, error, errorKey, clearError } = passwordAction;
  const hasError = error !== null;
  return (
    <>
      <OverlayHeader title="Enter your password to continue" />
      <form
        id="delete-account-password-form"
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <AuthPasswordInput
          id="delete-account-password"
          label="Password"
          value={password}
          onChange={(e) => {
            onPasswordChange(e.target.value);
            if (hasError) clearError();
          }}
          aria-invalid={hasError}
          aria-describedby={hasError ? PASSWORD_ERROR_ID : undefined}
        />
      </form>
      <InlineFormError error={error} errorKey={errorKey} id={PASSWORD_ERROR_ID} />
      <ModalActions
        cancel={{ label: 'Cancel', onClick: onCancel }}
        primary={{
          label: 'Continue',
          type: 'submit',
          form: 'delete-account-password-form',
          onClick: onSubmit,
          disabled: password.length === 0,
          loading: isSubmitting,
          loadingLabel: 'Verifying...',
          testId: TEST_IDS.deleteAccountPasswordContinue,
        }}
      />
    </>
  );
}

function TotpStep({
  otpValue,
  onOtpChange,
  onContinue,
  onCancel,
  error,
}: Readonly<{
  otpValue: string;
  onOtpChange: (value: string) => void;
  onContinue: () => void;
  onCancel: () => void;
  error: string | null;
}>): React.JSX.Element {
  return (
    <>
      <OverlayHeader
        title="Enter your verification code"
        description="Enter the 6-digit code from your authenticator app."
      />
      <OtpInput value={otpValue} onChange={onOtpChange} error={error} />
      <ModalActions
        cancel={{ label: 'Cancel', onClick: onCancel }}
        primary={{
          label: 'Continue',
          onClick: onContinue,
          disabled: otpValue.length !== 6,
          testId: TEST_IDS.deleteAccountTotpContinue,
        }}
      />
    </>
  );
}

interface FinalStepProps {
  confirmation: string;
  onConfirmationChange: (value: string) => void;
  finishAction: UseAsyncActionReturn;
  showStartOver: boolean;
  phraseMatches: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  onStartOver: () => void;
}

function FinalStep({
  confirmation,
  onConfirmationChange,
  finishAction,
  showStartOver,
  phraseMatches,
  onSubmit,
  onCancel,
  onStartOver,
}: Readonly<FinalStepProps>): React.JSX.Element {
  const { isPending: isSubmitting, error, errorKey, clearError } = finishAction;
  const hasError = error !== null;
  const primary = {
    label: 'Delete account permanently',
    variant: 'destructive' as const,
    onClick: onSubmit,
    disabled: !phraseMatches || isSubmitting,
    loading: isSubmitting,
    loadingLabel: 'Deleting...',
    testId: TEST_IDS.deleteAccountFinalSubmit,
  };

  return (
    <>
      <OverlayHeader title="Type delete my account to confirm" />
      <div className="space-y-3">
        <p className="text-sm">
          Type the phrase{' '}
          <code className="bg-muted rounded px-1 py-0.5 text-sm font-medium">
            {DELETE_ACCOUNT_CONFIRMATION_PHRASE}
          </code>{' '}
          exactly to enable the delete button.
        </p>
        <Label htmlFor="delete-account-confirmation" className="block">
          Confirmation
        </Label>
        <Input
          id="delete-account-confirmation"
          value={confirmation}
          onChange={(e) => {
            onConfirmationChange(e.target.value);
            if (hasError) clearError();
          }}
          aria-label="Confirmation"
          aria-invalid={hasError}
          aria-describedby={hasError ? CONFIRMATION_ERROR_ID : undefined}
          data-testid={TEST_IDS.deleteAccountConfirmationInput}
          autoComplete="off"
        />
      </div>
      <InlineFormError error={error} errorKey={errorKey} id={CONFIRMATION_ERROR_ID} />
      {showStartOver ? (
        <ModalActions
          cancel={{
            label: 'Start over',
            onClick: onStartOver,
            testId: TEST_IDS.deleteAccountStartOver,
          }}
          primary={primary}
        />
      ) : (
        <ModalActions cancel={{ label: 'Cancel', onClick: onCancel }} primary={primary} />
      )}
    </>
  );
}

export function DeleteAccountModal({
  open,
  onOpenChange,
}: Readonly<DeleteAccountModalProps>): React.JSX.Element | null {
  const balanceQuery = useBalance();
  const totpEnabled = useAuthStore((s) => s.user?.totpEnabled ?? false);

  const initMutation = useDeleteAccountInit();
  const finishMutation = useDeleteAccountFinish();

  const [step, setStep] = useState<Step>('intro');
  const [walletAcknowledged, setWalletAcknowledged] = useState(false);
  const [password, setPassword] = useState('');
  const [otpValue, setOtpValue] = useState('');
  const [totpError, setTotpError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [showStartOver, setShowStartOver] = useState(false);
  const [ke3, setKe3] = useState<number[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const passwordAction = useAsyncAction();
  const finishAction = useAsyncAction();

  // The spendable purchased wallet (NanoUSD wire string) drives the "you still
  // have credits" warning; bigint math throughout — never `parseFloat` on money.
  const balanceRaw = balanceQuery.data?.purchased.balanceNanoUsd;
  const hasBalance = balanceRaw ? parseNanoUSD(balanceRaw) > 0n : false;
  const balanceDisplay = balanceRaw ? formatBalanceDollars(balanceRaw) : '$0.00';
  const balanceLoading = balanceQuery.isPending;

  const { clearError: clearPasswordError } = passwordAction;
  const { clearError: clearFinishError } = finishAction;

  const resetState = useCallback(() => {
    setStep('intro');
    setWalletAcknowledged(false);
    setPassword('');
    setOtpValue('');
    setTotpError(null);
    setConfirmation('');
    setShowStartOver(false);
    setKe3(null);
    setSessionId(null);
    clearPasswordError();
    clearFinishError();
  }, [clearPasswordError, clearFinishError]);

  React.useEffect(() => {
    if (open) {
      resetState();
    }
  }, [open, resetState]);

  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const handleOpenAutoFocus = useMobileAutoFocus();

  const runPasswordSubmit = useCallback(async (): Promise<void> => {
    if (password.length === 0) return;
    // Mirrors the disable-2FA / change-password defense-in-depth pattern:
    // the encoded byte copy is zeroed on every exit path so a heap inspection
    // after the modal closes can't recover it. JS strings stay un-zeroable.
    const passwordBytes = new TextEncoder().encode(password);
    try {
      const opaqueClient = createOpaqueClient();
      const { ke1 } = await startLogin(opaqueClient, password);
      const { ke2, deleteAccountSessionId } = await initMutation.mutateAsync({ ke1: [...ke1] });
      // OPAQUE is constant-time: `/init` always succeeds, so wrong-password
      // surfaces as a thrown crypto error in `finishLogin`. Map that to
      // INCORRECT_PASSWORD instead of the generic INTERNAL fallback.
      let loginResult;
      try {
        loginResult = await finishLogin(opaqueClient, ke2, OPAQUE_SERVER_IDENTIFIER);
      } catch {
        throw new UserMessageError(friendlyErrorMessage('INCORRECT_PASSWORD'));
      }
      setKe3([...loginResult.ke3]);
      setSessionId(deleteAccountSessionId);
      setStep(totpEnabled ? 'totp' : 'final');
    } catch (error) {
      throw mapOpaqueError(error);
    } finally {
      passwordBytes.fill(0);
    }
  }, [password, initMutation, totpEnabled]);

  const handlePasswordSubmit = useCallback((): void => {
    void passwordAction.run(runPasswordSubmit);
  }, [passwordAction, runPasswordSubmit]);

  const phraseMatches = useMemo(
    () => confirmation.trim().toLowerCase() === DELETE_ACCOUNT_CONFIRMATION_PHRASE,
    [confirmation]
  );

  const runFinishSubmit = useCallback(async (): Promise<void> => {
    if (!phraseMatches || ke3 === null || sessionId === null) return;
    setTotpError(null);
    setShowStartOver(false);
    try {
      const body: {
        ke3: number[];
        totpCode?: string;
        confirmationPhrase: string;
        deleteAccountSessionId: string;
      } = {
        ke3,
        confirmationPhrase: confirmation.trim().toLowerCase(),
        deleteAccountSessionId: sessionId,
      };
      if (totpEnabled) body.totpCode = otpValue;
      await finishMutation.mutateAsync(body);
      // Assign before clearLocalAuthState: queryClient.clear() flips the
      // settled-aware indicator true, racing the browser's URL commit.
      globalThis.location.href = ROUTES.MARKETING;
      // reload:false — the same-origin href assignment above is itself a
      // full-document navigation that tears the JS context down, so it already
      // provides clearLocalAuthState's memory-hygiene guarantee. A reload here
      // would reload the CURRENT url (still /settings), overriding the pending
      // /welcome nav and bouncing the re-run auth guard to /login.
      clearLocalAuthState({ reload: false });
    } catch (error) {
      const code = getErrorBody(error)?.code;
      // TOTP-shape errors get routed back to the TOTP step so the user sees
      // the error next to the offending input. Don't throw — the final step
      // won't be visible anyway, so a thrown UserMessageError would surface
      // on a step the user isn't on.
      if (code === 'INVALID_TOTP_CODE' || code === 'TOTP_CODE_REQUIRED') {
        setTotpError(messageFor(code));
        setStep('totp');
        return;
      }
      if (code === 'NO_PENDING_DELETE_ACCOUNT') setShowStartOver(true);
      throw mapOpaqueError(error);
    }
  }, [phraseMatches, ke3, sessionId, confirmation, totpEnabled, otpValue, finishMutation]);

  const handleFinishSubmit = useCallback((): void => {
    void finishAction.run(runFinishSubmit);
  }, [finishAction, runFinishSubmit]);

  const previousStep = useCallback(
    (current: Step): Step => {
      if (current === 'wallet') return 'intro';
      if (current === 'password') return hasBalance ? 'wallet' : 'intro';
      if (current === 'totp') return 'password';
      return totpEnabled ? 'totp' : 'password';
    },
    [hasBalance, totpEnabled]
  );

  const handleBack = useCallback(() => {
    setStep((current) => previousStep(current));
  }, [previousStep]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const stepNumber = useMemo(
    () => computeStepNumber(step, hasBalance, totpEnabled),
    [step, hasBalance, totpEnabled]
  );

  if (!open) return null;

  const isBusy = passwordAction.isPending || finishAction.isPending;

  const stepBody = renderStepBody({
    step,
    hasBalance,
    balanceLoading,
    balanceDisplay,
    walletAcknowledged,
    setWalletAcknowledged,
    password,
    setPassword,
    passwordAction,
    handlePasswordSubmit,
    formRef,
    otpValue,
    setOtpValue,
    totpError,
    setStep,
    confirmation,
    setConfirmation,
    finishAction,
    showStartOver,
    phraseMatches,
    handleFinishSubmit,
    resetState,
    handleCancel,
  });

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Delete account"
      onOpenAutoFocus={handleOpenAutoFocus}
      currentStep={stepNumber}
      dismissible={!isBusy}
      {...(step !== 'intro' && { onBack: handleBack })}
    >
      <OverlayContent data-testid={TEST_IDS.deleteAccountModal} className="w-[75vw]">
        {stepBody}
      </OverlayContent>
    </Overlay>
  );
}

interface StepBodyArgs {
  step: Step;
  hasBalance: boolean;
  balanceLoading: boolean;
  balanceDisplay: string;
  walletAcknowledged: boolean;
  setWalletAcknowledged: (value: boolean) => void;
  password: string;
  setPassword: (value: string) => void;
  passwordAction: UseAsyncActionReturn;
  handlePasswordSubmit: () => void;
  formRef: React.RefObject<HTMLFormElement | null>;
  otpValue: string;
  setOtpValue: (value: string) => void;
  totpError: string | null;
  setStep: React.Dispatch<React.SetStateAction<Step>>;
  confirmation: string;
  setConfirmation: (value: string) => void;
  finishAction: UseAsyncActionReturn;
  showStartOver: boolean;
  phraseMatches: boolean;
  handleFinishSubmit: () => void;
  resetState: () => void;
  handleCancel: () => void;
}

function renderStepBody(args: Readonly<StepBodyArgs>): React.JSX.Element | null {
  if (args.step === 'intro') {
    return (
      <IntroStep
        onContinue={() => {
          args.setStep(args.hasBalance ? 'wallet' : 'password');
        }}
        onCancel={args.handleCancel}
        balanceLoading={args.balanceLoading}
      />
    );
  }
  if (args.step === 'wallet') {
    return (
      <WalletStep
        balanceDisplay={args.balanceDisplay}
        acknowledged={args.walletAcknowledged}
        onAcknowledgedChange={args.setWalletAcknowledged}
        onContinue={() => {
          args.setStep('password');
        }}
        onCancel={args.handleCancel}
      />
    );
  }
  if (args.step === 'password') {
    return (
      <PasswordStep
        password={args.password}
        onPasswordChange={args.setPassword}
        passwordAction={args.passwordAction}
        onSubmit={args.handlePasswordSubmit}
        onCancel={args.handleCancel}
        formRef={args.formRef}
      />
    );
  }
  if (args.step === 'totp') {
    return (
      <TotpStep
        otpValue={args.otpValue}
        onOtpChange={args.setOtpValue}
        onContinue={() => {
          args.setStep('final');
        }}
        onCancel={args.handleCancel}
        error={args.totpError}
      />
    );
  }
  return (
    <FinalStep
      confirmation={args.confirmation}
      onConfirmationChange={args.setConfirmation}
      finishAction={args.finishAction}
      showStartOver={args.showStartOver}
      phraseMatches={args.phraseMatches}
      onSubmit={args.handleFinishSubmit}
      onCancel={args.handleCancel}
      onStartOver={args.resetState}
    />
  );
}
