import * as React from 'react';
import { useState, useMemo, useCallback, useEffect, useRef, useId } from 'react';
import { Copy, Check, AlertTriangle } from 'lucide-react';
import {
  InlineFormError,
  Input,
  ModalActions,
  Overlay,
  OverlayContent,
  UserMessageError,
  useAsyncAction,
  useIsMobile,
  type UseAsyncActionReturn,
} from '@hushbox/ui';
import { regenerateRecoveryPhrase } from '@hushbox/crypto';
import { toBase64, TEST_IDS, TEST_ID_BUILDERS, friendlyErrorMessage } from '@hushbox/shared';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav';
import { useMobileAutoFocus } from '@/hooks/ui/use-mobile-auto-focus';
import { ModalSuccessStep } from '@/components/shared/modal-success-step';
import { useAuthStore } from '@/lib/auth';
import { client, fetchJson } from '@/lib/api-client';

interface RecoveryPhraseModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

type Step = 'display' | 'verify' | 'success';

interface ModalState {
  setStep: (step: Step) => void;
  setCopied: (copied: boolean) => void;
  setVerificationInputs: (inputs: string[]) => void;
  setInitError: (error: string | null) => void;
  setPhrase: (phrase: string) => void;
  setVerificationIndices: (indices: number[]) => void;
  recoveryWrappedPrivateKeyRef: React.RefObject<Uint8Array | null>;
}

async function initializeRecoveryPhrase(
  privateKey: Uint8Array | null,
  state: ModalState
): Promise<void> {
  if (!privateKey) {
    state.setInitError(friendlyErrorMessage('RECOVERY_MATERIAL_SAVE_FAILED'));
    return;
  }

  try {
    const result = await regenerateRecoveryPhrase(privateKey);
    state.setPhrase(result.recoveryPhrase);
    state.setVerificationIndices(generateVerificationIndices());
    state.recoveryWrappedPrivateKeyRef.current = result.recoveryWrappedPrivateKey;
  } catch (error_: unknown) {
    state.setInitError(
      error_ instanceof Error
        ? error_.message
        : friendlyErrorMessage('RECOVERY_PHRASE_GENERATION_FAILED')
    );
  }
}

function resetModalState(state: ModalState, clearVerifyError: () => void): void {
  state.setStep('display');
  state.setCopied(false);
  state.setVerificationInputs(['', '', '']);
  state.setInitError(null);
  clearVerifyError();
  state.setPhrase('');
  state.recoveryWrappedPrivateKeyRef.current = null;
}

async function performVerification(
  wrappedKeyRef: React.RefObject<Uint8Array | null>,
  setStep: (step: Step) => void
): Promise<void> {
  const wrappedKey = wrappedKeyRef.current;
  if (!wrappedKey) {
    throw new UserMessageError(friendlyErrorMessage('RECOVERY_MATERIAL_SAVE_FAILED'));
  }

  try {
    await saveRecoveryMaterial(wrappedKey);
  } catch {
    throw new UserMessageError(friendlyErrorMessage('RECOVERY_MATERIAL_SAVE_FAILED'));
  }
  setStep('success');
}

const STEP_NUMBERS: Record<Step, number> = {
  display: 1,
  verify: 2,
  success: 3,
};

function generateVerificationIndices(): number[] {
  const indices: number[] = [];
  while (indices.length < 3) {
    const buf = new Uint8Array(1);
    crypto.getRandomValues(buf);
    const randomIndex = (buf[0] ?? 0) % 12;
    if (!indices.includes(randomIndex)) {
      indices.push(randomIndex);
    }
  }
  return indices.toSorted((a, b) => a - b);
}

function ErrorBanner({
  error,
  phrase,
}: Readonly<{ error: string | null; phrase: string }>): React.JSX.Element | null {
  if (!error || phrase) return null;
  return <p className="text-destructive text-sm">{error}</p>;
}

async function saveRecoveryMaterial(recoveryWrappedPrivateKey: Uint8Array): Promise<void> {
  await fetchJson(
    client.auth.recovery.save.$post({
      json: { recoveryWrappedPrivateKey: toBase64(recoveryWrappedPrivateKey) },
    })
  );
}

export function RecoveryPhraseModal({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<RecoveryPhraseModalProps>): React.JSX.Element | null {
  const isMobile = useIsMobile();
  const [step, setStep] = useState<Step>('display');
  const [phrase, setPhrase] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [verificationIndices, setVerificationIndices] = useState<number[]>([]);
  const [verificationInputs, setVerificationInputs] = useState<string[]>(['', '', '']);
  const [initError, setInitError] = useState<string | null>(null);
  const verifyAction = useAsyncAction();
  const recoveryWrappedPrivateKeyRef = useRef<Uint8Array | null>(null);

  const { clearError: clearVerifyError } = verifyAction;
  useEffect(() => {
    if (!open) return;

    const state: ModalState = {
      setStep,
      setCopied,
      setVerificationInputs,
      setInitError,
      setPhrase,
      setVerificationIndices,
      recoveryWrappedPrivateKeyRef,
    };
    resetModalState(state, clearVerifyError);
    const { privateKey } = useAuthStore.getState();
    void initializeRecoveryPhrase(privateKey, state);
  }, [open, clearVerifyError]);

  const words = useMemo(() => phrase.split(' '), [phrase]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(phrase);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 3000);
  }, [phrase]);

  const handleProceedToVerify = useCallback(() => {
    setStep('verify');
  }, []);

  const handleBack = useCallback(() => {
    setStep('display');
  }, []);

  const handleVerificationChange = useCallback((index: number, value: string) => {
    setVerificationInputs((previous) => {
      const next = [...previous];
      next[index] = value;
      return next;
    });
  }, []);

  const verificationResults = useMemo(() => {
    return verificationIndices.map((wordIndex, inputIndex) => {
      const inputValue = verificationInputs[inputIndex]?.trim().toLowerCase() ?? '';
      const expectedWord = words[wordIndex]?.toLowerCase() ?? '';
      return inputValue !== '' && inputValue === expectedWord;
    });
  }, [verificationIndices, verificationInputs, words]);

  const allCorrect = verificationResults.every(Boolean);

  const handleVerify = useCallback((): void => {
    void verifyAction.run(() => performVerification(recoveryWrappedPrivateKeyRef, setStep));
  }, [verifyAction]);

  const handleDone = useCallback(() => {
    onSuccess();
  }, [onSuccess]);

  const handleOpenAutoFocus = useMobileAutoFocus();

  if (!open) return null;

  const currentStep = STEP_NUMBERS[step];
  const showBackButton = step === 'verify';

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Recovery phrase setup"
      onOpenAutoFocus={handleOpenAutoFocus}
      currentStep={currentStep}
      dismissible={!verifyAction.isPending}
      {...(showBackButton && { onBack: handleBack })}
    >
      <OverlayContent data-testid={TEST_IDS.recoveryPhraseModal} size="xl" className="w-[75vw]">
        <ErrorBanner error={initError} phrase={phrase} />

        {step === 'display' && phrase && (
          <DisplayStep
            words={words}
            copied={copied}
            onCopy={() => {
              void handleCopy();
            }}
            onProceed={handleProceedToVerify}
            isMobile={isMobile}
          />
        )}

        {step === 'verify' && (
          <VerifyStep
            verificationIndices={verificationIndices}
            verificationInputs={verificationInputs}
            verificationResults={verificationResults}
            allCorrect={allCorrect}
            verifyAction={verifyAction}
            onInputChange={handleVerificationChange}
            onVerify={handleVerify}
          />
        )}

        {step === 'success' && (
          <ModalSuccessStep
            heading="Recovery Phrase Saved"
            description="Your account is now protected. If you forget your password, use this phrase to recover your data."
            primaryLabel="Done"
            onDone={handleDone}
          />
        )}
      </OverlayContent>
    </Overlay>
  );
}

interface DisplayStepProps {
  words: string[];
  copied: boolean;
  onCopy: () => void;
  onProceed: () => void;
  isMobile: boolean;
}

function DisplayStep({
  words,
  copied,
  onCopy,
  onProceed,
  isMobile,
}: Readonly<DisplayStepProps>): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Your Recovery Phrase</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Write these 12 words down in order. Keep them somewhere safe. You will not be able to view
          this phrase again.
        </p>
      </div>

      <div
        className={`grid gap-2 ${isMobile ? 'grid-cols-2' : 'grid-cols-4'}`}
        data-testid={TEST_IDS.wordGrid}
      >
        {words.map((word, index) => (
          <div
            key={index}
            className="bg-muted/50 rounded-md px-3 py-2 text-center font-mono text-sm"
          >
            {index + 1}. {word}
          </div>
        ))}
      </div>

      <div className="text-destructive flex items-start gap-2 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>If you lose your password, this is your only recovery.</span>
      </div>

      <ModalActions
        cancel={{
          label: copied ? 'Copied' : 'Copy to Clipboard',
          onClick: onCopy,
          icon: copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />,
        }}
        primary={{
          label: "I've saved it →",
          onClick: onProceed,
        }}
      />
    </div>
  );
}

interface VerifyStepProps {
  verificationIndices: number[];
  verificationInputs: string[];
  verificationResults: boolean[];
  allCorrect: boolean;
  verifyAction: UseAsyncActionReturn;
  onInputChange: (index: number, value: string) => void;
  onVerify: () => void;
}

function VerifyStep({
  verificationIndices,
  verificationInputs,
  verificationResults,
  allCorrect,
  verifyAction,
  onInputChange,
  onVerify,
}: Readonly<VerifyStepProps>): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const fieldIdPrefix = useId();
  const { isPending: saving, error, errorKey, clearError } = verifyAction;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Verify Your Phrase</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Enter the words at these positions to confirm you&apos;ve saved them.
        </p>
      </div>

      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          onVerify();
        }}
      >
        <div className="space-y-3">
          {verificationIndices.map((wordIndex, inputIndex) => {
            const fieldId = `${fieldIdPrefix}-${String(inputIndex)}`;
            return (
              <div key={inputIndex}>
                <label htmlFor={fieldId} className="text-sm font-medium">
                  Word #{String(wordIndex + 1)}
                </label>
                <div className="relative mt-1">
                  <Input
                    id={fieldId}
                    type="text"
                    value={verificationInputs[inputIndex] ?? ''}
                    onChange={(e) => {
                      onInputChange(inputIndex, e.target.value);
                      if (error !== null) clearError();
                    }}
                    placeholder={`Enter word ${String(wordIndex + 1)}`}
                    className="pr-10"
                    disabled={saving}
                  />
                  {verificationResults[inputIndex] && (
                    <div
                      data-testid={TEST_ID_BUILDERS.wordCheck(inputIndex)}
                      className="absolute top-1/2 right-3 -translate-y-1/2 text-green-500"
                    >
                      <Check className="h-4 w-4" />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </form>

      <InlineFormError error={error} errorKey={errorKey} />

      <ModalActions
        primary={{
          label: 'Verify →',
          onClick: onVerify,
          disabled: !allCorrect,
          loading: saving,
          loadingLabel: 'Saving...',
        }}
      />
    </div>
  );
}
