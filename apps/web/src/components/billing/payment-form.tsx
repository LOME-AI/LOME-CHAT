import { useState, useEffect, useRef, useCallback } from 'react';
import { DollarSign, CreditCard, Lock, MapPin, User, Home } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, ModalActions, OverlayContent, OverlayHeader } from '@hushbox/ui';
import { TEST_IDS, legacyFriendlyErrorMessage } from '@hushbox/shared';
import { FormInput } from '@/components/shared/form-input';
import { DevOnly } from '@/components/shared/dev-only';
import { getErrorBody } from '@/lib/api';
import { env } from '@/lib/env';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav.js';
import {
  useCreatePayment,
  useProcessPayment,
  usePaymentStatus,
  billingKeys,
} from '@/hooks/billing/billing.js';
import { usePaymentForm } from '@/hooks/billing/use-payment-form.js';
import { HelcimLogo } from './helcim-logo.js';
import {
  loadHelcimScript,
  readHelcimResult,
  type HelcimTokenResult,
} from '../../lib/helcim-loader.js';
import { MOCK_TEST_CARDS } from '../../lib/helcim-mock.js';
import { MIN_DEPOSIT_AMOUNT, MAX_DEPOSIT_AMOUNT } from '../../lib/payment-validation.js';

declare global {
  interface Window {
    helcimProcess?: () => void;
  }
  var helcimProcess: (() => void) | undefined;
}

type PaymentState = 'idle' | 'processing' | 'success' | 'error';

// Max time to wait for the asynchronous webhook to confirm a 'processing'
// payment before telling the user to check their balance. A charged user must
// always get a resolution even if the webhook never arrives.
const POLLING_TIMEOUT_MS = 60_000;

interface PaymentStatusCallbacks {
  onConfirmed: (newBalance: string) => void;
  onFailed: (errorMessage?: string | null) => void;
}

interface PaymentStatusResult {
  status: string;
  newBalance?: string;
  errorMessage?: string | null | undefined;
}

// Resolves a thrown payment error into a user-facing reason. ApiError carries
// a machine-readable code (e.g. PAYMENT_DECLINED) which legacyFriendlyErrorMessage
// maps to copy; unknown/non-ApiError errors fall back to the generic message.
function resolvePaymentErrorMessage(error: unknown): string {
  const code = getErrorBody(error)?.code;
  // legacyFriendlyErrorMessage returns its generic fallback for unknown/empty codes.
  return legacyFriendlyErrorMessage(code ?? '');
}

function handlePaymentStatusUpdate(
  status: PaymentStatusResult,
  callbacks: PaymentStatusCallbacks
): boolean {
  if (status.status === 'completed') {
    if (status.newBalance) {
      callbacks.onConfirmed(status.newBalance);
    }
    return true;
  }
  if (status.status === 'failed') {
    callbacks.onFailed(status.errorMessage);
    return true;
  }
  return false;
}

interface PaymentSuccessCardProps {
  amount: string;
  onClose?: (() => void) | undefined;
}

function PaymentSuccessCard({
  amount,
  onClose,
}: Readonly<PaymentSuccessCardProps>): React.JSX.Element {
  return (
    <OverlayContent>
      <OverlayHeader title="Payment Successful" description="Your deposit has been processed" />
      <div className="py-4 text-center">
        <p className="text-primary text-2xl font-semibold">
          +${Number.parseFloat(amount || '0').toFixed(2)}
        </p>
        <p className="text-muted-foreground mt-2">Added to your balance</p>
      </div>
      <ModalActions
        primary={{
          label: 'Close',
          onClick: () => {
            onClose?.();
          },
        }}
      />
    </OverlayContent>
  );
}

interface PaymentErrorCardProps {
  errorMessage: string | null;
  onCancel?: (() => void) | undefined;
  onRetry: () => void;
}

function PaymentErrorCard({
  errorMessage,
  onCancel,
  onRetry,
}: Readonly<PaymentErrorCardProps>): React.JSX.Element {
  return (
    <OverlayContent>
      <OverlayHeader title="Payment Failed" description="We couldn't process your payment" />
      <div className="py-4 text-center">
        <p className="text-destructive">
          {errorMessage ?? 'Something went wrong. Please try again or contact support.'}
        </p>
      </div>
      {onCancel ? (
        <ModalActions
          cancel={{
            label: 'Cancel',
            onClick: onCancel,
          }}
          primary={{
            label: 'Try Again',
            onClick: onRetry,
          }}
        />
      ) : (
        <ModalActions
          primary={{
            label: 'Try Again',
            onClick: onRetry,
          }}
        />
      )}
    </OverlayContent>
  );
}

interface CardFormSectionProps {
  scriptError: string | null;
  scriptLoaded: boolean;
  form: ReturnType<typeof usePaymentForm>;
}

function CardFormSection({
  scriptError,
  scriptLoaded,
  form,
}: Readonly<CardFormSectionProps>): React.JSX.Element {
  if (scriptError) {
    return (
      <div className="py-4 text-center">
        <p className="text-destructive mb-4">Failed to load payment form</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            globalThis.location.reload();
          }}
        >
          Reload Page
        </Button>
      </div>
    );
  }

  if (scriptLoaded) {
    return (
      <>
        <FormInput
          id="cardNumber"
          label="Card Number"
          type="text"
          inputMode="numeric"
          autoComplete="cc-number"
          icon={<CreditCard className="h-5 w-5" />}
          value={form.cardFields.cardNumber}
          onChange={(e) => {
            form.handleFieldChange('cardNumber', e.target.value);
          }}
          maxLength={19}
          aria-invalid={!!form.cardValidation.cardNumber.error}
          {...(form.cardValidation.cardNumber.error != null && {
            error: form.cardValidation.cardNumber.error,
          })}
          success={form.cardValidation.cardNumber.success}
        />

        <div className="flex gap-3">
          <div className="flex-1">
            <FormInput
              id="cardExpiryDate"
              label="Expiry (MM/YY)"
              type="text"
              inputMode="numeric"
              autoComplete="cc-exp"
              value={form.cardFields.expiry}
              onChange={(e) => {
                form.handleFieldChange('expiry', e.target.value);
              }}
              maxLength={7}
              aria-invalid={!!form.cardValidation.expiry.error}
              {...(form.cardValidation.expiry.error != null && {
                error: form.cardValidation.expiry.error,
              })}
              success={form.cardValidation.expiry.success}
            />
          </div>
          {/* Hidden fields for Helcim - it needs month and year separately */}
          <input type="hidden" id="cardExpiryMonth" value={form.expiryParts.month} />
          <input type="hidden" id="cardExpiryYear" value={form.expiryParts.year} />

          <div className="flex-1">
            <FormInput
              id="cardCVV"
              label="CVV"
              type="text"
              inputMode="numeric"
              autoComplete="cc-csc"
              icon={<Lock className="h-5 w-5" />}
              value={form.cardFields.cvv}
              onChange={(e) => {
                form.handleFieldChange('cvv', e.target.value);
              }}
              maxLength={4}
              aria-invalid={!!form.cardValidation.cvv.error}
              {...(form.cardValidation.cvv.error != null && {
                error: form.cardValidation.cvv.error,
              })}
              success={form.cardValidation.cvv.success}
            />
          </div>
        </div>

        {/* Name on Card - Required by Helcim */}
        <FormInput
          id="cardHolderName"
          label="Name on Card"
          type="text"
          autoComplete="cc-name"
          icon={<User className="h-5 w-5" />}
          value={form.cardFields.cardHolderName}
          onChange={(e) => {
            form.handleFieldChange('cardHolderName', e.target.value);
          }}
          aria-invalid={!!form.cardValidation.cardHolderName.error}
          {...(form.cardValidation.cardHolderName.error != null && {
            error: form.cardValidation.cardHolderName.error,
          })}
          success={form.cardValidation.cardHolderName.success}
        />

        {/* Billing Address - Required by Helcim */}
        <FormInput
          id="cardHolderAddress"
          label="Billing Address"
          type="text"
          autoComplete="address-line1"
          icon={<Home className="h-5 w-5" />}
          value={form.cardFields.billingAddress}
          onChange={(e) => {
            form.handleFieldChange('billingAddress', e.target.value);
          }}
          aria-invalid={!!form.cardValidation.billingAddress.error}
          {...(form.cardValidation.billingAddress.error != null && {
            error: form.cardValidation.billingAddress.error,
          })}
          success={form.cardValidation.billingAddress.success}
        />

        <FormInput
          id="cardHolderPostalCode"
          label="ZIP Code"
          type="text"
          autoComplete="postal-code"
          icon={<MapPin className="h-5 w-5" />}
          value={form.cardFields.zipCode}
          onChange={(e) => {
            form.handleFieldChange('zipCode', e.target.value);
          }}
          maxLength={10}
          aria-invalid={!!form.cardValidation.zipCode.error}
          {...(form.cardValidation.zipCode.error != null && {
            error: form.cardValidation.zipCode.error,
          })}
          success={form.cardValidation.zipCode.success}
        />

        {/* Hidden results container for Helcim response */}
        <div id="helcimResults" className="hidden">
          <input type="hidden" id="response" />
          <input type="hidden" id="responseMessage" />
          <input type="hidden" id="cardToken" />
          <input type="hidden" id="cardType" />
          <input type="hidden" id="cardF4L4" />
          <input type="hidden" id="customerCode" />
        </div>
      </>
    );
  }

  return (
    <div className="py-8 text-center" data-testid={TEST_IDS.helcimLoading}>
      <p className="text-muted-foreground">Loading payment form...</p>
    </div>
  );
}

interface PaymentFormActionsProps {
  onCancel?: (() => void) | undefined;
  scriptLoaded: boolean;
  paymentState: PaymentState;
  isPaymentPending: boolean;
}

function PaymentFormActions({
  onCancel,
  scriptLoaded,
  paymentState,
  isPaymentPending,
}: Readonly<PaymentFormActionsProps>): React.JSX.Element {
  const isProcessing = paymentState === 'processing' || isPaymentPending;

  const primary = {
    label: 'Purchase',
    onClick: () => {
      /* noop — form uses type="submit" */
    },
    type: 'submit' as const,
    form: 'helcimForm',
    disabled: !scriptLoaded || isProcessing,
    loading: isProcessing,
    loadingLabel: 'Processing...',
  };

  if (onCancel) {
    return (
      <ModalActions
        cancel={{
          label: 'Cancel',
          onClick: onCancel,
        }}
        primary={primary}
      />
    );
  }

  return <ModalActions primary={primary} />;
}

interface PaymentFormProps {
  onSuccess?: (newBalance: string) => void;
  onCancel?: () => void;
}

export function PaymentForm({
  onSuccess,
  onCancel,
}: Readonly<PaymentFormProps>): React.JSX.Element {
  const jsToken = import.meta.env['VITE_HELCIM_JS_TOKEN'] as string | undefined;
  const isDevMode = env.isLocalDev;

  const form = usePaymentForm();

  const [paymentState, setPaymentState] = useState<PaymentState>('idle');
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const observerRef = useRef<MutationObserver | null>(null);
  const paymentIdRef = useRef<string | null>(null);
  const expectingTokenizationRef = useRef(false);
  const simulateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paymentFormRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(paymentFormRef);

  const queryClient = useQueryClient();
  const createPayment = useCreatePayment();
  const processPayment = useProcessPayment();

  const { data: paymentStatus } = usePaymentStatus(paymentId, {
    enabled: isPolling,
    refetchInterval: isPolling ? 2000 : false,
  });

  const stopPolling = useCallback((errorMsg?: string): void => {
    setIsPolling(false);
    if (errorMsg) {
      setPaymentState('error');
      setErrorMessage(errorMsg);
    }
  }, []);

  // The timeout is driven by a real timer rather than a poll-data dependency:
  // React Query's structural sharing keeps `paymentStatus` referentially stable
  // while the webhook stays 'processing', so a data-keyed effect would never
  // re-run to notice the deadline. Keyed on `isPolling` so it fires once polling
  // starts and is cleared the moment polling settles or the form unmounts.
  useEffect(() => {
    if (!isPolling) return;

    const timer = setTimeout(() => {
      stopPolling('Payment confirmation timed out. Please check your balance.');
    }, POLLING_TIMEOUT_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [isPolling, stopPolling]);

  useEffect(() => {
    if (!isPolling || !paymentStatus) return;

    const handled = handlePaymentStatusUpdate(paymentStatus, {
      onConfirmed: (newBalance) => {
        stopPolling();
        setPaymentState('success');
        onSuccess?.(newBalance);
      },
      onFailed: (errorMsg) => {
        stopPolling();
        setPaymentState('error');
        setErrorMessage(errorMsg ?? null);
      },
    });

    if (handled) {
      void queryClient.invalidateQueries({ queryKey: billingKeys.transactions() });
    }
  }, [paymentStatus, isPolling, onSuccess, queryClient, stopPolling]);

  const handleTokenizationResult = useCallback(
    async (result: HelcimTokenResult): Promise<void> => {
      // Disable further processing until next helcimProcess() call
      expectingTokenizationRef.current = false;

      if (!result.success) {
        setPaymentState('error');
        setErrorMessage(result.errorMessage ?? 'Card tokenization failed');
        return;
      }

      const currentPaymentId = paymentIdRef.current;
      if (!result.cardToken || !result.customerCode || !currentPaymentId) {
        setPaymentState('error');
        setErrorMessage('Missing card token, customer code, or payment ID');
        return;
      }

      try {
        const response = await processPayment.mutateAsync({
          paymentId: currentPaymentId,
          cardToken: result.cardToken,
          customerCode: result.customerCode,
        });

        if (response.status === 'completed') {
          setPaymentState('success');
          onSuccess?.(response.newBalance);
        } else {
          // response.status === 'processing' - Start polling for webhook confirmation
          setIsPolling(true);
        }
      } catch (error) {
        setPaymentState('error');
        setErrorMessage(resolvePaymentErrorMessage(error));
      }
    },
    [processPayment, onSuccess]
  );

  useEffect(() => {
    let mounted = true;

    const loadScript = async (): Promise<void> => {
      try {
        await loadHelcimScript({ useMock: isDevMode });
        if (mounted) {
          setScriptLoaded(true);
        }
      } catch (error: unknown) {
        if (mounted) {
          setScriptError(error instanceof Error ? error.message : 'Failed to load payment form');
        }
      }
    };

    void loadScript();

    return () => {
      mounted = false;
    };
  }, [isDevMode]);

  useEffect(() => {
    return () => {
      if (simulateTimerRef.current !== null) {
        clearTimeout(simulateTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!scriptLoaded) return;

    const resultsDiv = document.querySelector('#helcimResults');
    if (!resultsDiv) return;

    observerRef.current = new MutationObserver(() => {
      if (!expectingTokenizationRef.current) return;

      const responseEl = document.querySelector<HTMLInputElement>('#response');
      if (!responseEl?.value) return;

      // For successful tokenization (response=1), also wait for customerCode
      // Helcim.js may populate fields sequentially, so we need to ensure
      // customerCode is set before processing. For failures (response=0),
      // customerCode won't be present, so process immediately.
      if (responseEl.value === '1') {
        const customerCodeEl = document.querySelector<HTMLInputElement>('#customerCode');
        if (!customerCodeEl?.value) return;
      }

      const result = readHelcimResult();
      void handleTokenizationResult(result);
    });

    observerRef.current.observe(resultsDiv, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    return () => {
      observerRef.current?.disconnect();
    };
  }, [scriptLoaded, handleTokenizationResult]);

  // Clear stale Helcim results to prevent MutationObserver from reading old values
  // eslint-disable-next-line unicorn/consistent-function-scoping -- React handler
  const clearHelcimResults = (): void => {
    for (const id of [
      'response',
      'responseMessage',
      'cardToken',
      'customerCode',
      'cardType',
      'cardF4L4',
    ]) {
      const el = document.querySelector<HTMLInputElement>(`#${id}`);
      if (el) el.value = '';
    }
  };

  const populateTestCard = (cvv: string): void => {
    clearHelcimResults(); // Clear FIRST, before form updates trigger re-renders
    if (!form.amount) {
      form.handleAmountChange('100');
    }
    form.handleFieldChange('cardNumber', MOCK_TEST_CARDS.SUCCESS.number);
    form.handleFieldChange('expiry', MOCK_TEST_CARDS.SUCCESS.expiry);
    form.handleFieldChange('cvv', cvv);
    form.handleFieldChange('cardHolderName', 'Test User');
    form.handleFieldChange('billingAddress', '123 Test St');
    form.handleFieldChange('zipCode', '12345');
  };

  const handleSimulateSuccess = (): void => {
    populateTestCard(MOCK_TEST_CARDS.SUCCESS.cvv);
    simulateTimerRef.current = setTimeout(() => {
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      formEl?.requestSubmit();
    }, 100);
  };

  const handleSimulateFailure = (): void => {
    populateTestCard(MOCK_TEST_CARDS.DECLINE.cvv);
    simulateTimerRef.current = setTimeout(() => {
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      formEl?.requestSubmit();
    }, 100);
  };

  const handleSubmit = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();

    if (!form.validateAll()) {
      return;
    }

    setPaymentState('processing');

    try {
      const formattedAmount = Number.parseFloat(form.amount).toFixed(8);
      const result = await createPayment.mutateAsync({ amount: formattedAmount });
      paymentIdRef.current = result.paymentId;
      setPaymentId(result.paymentId);

      // Clear stale tokenization results and enable observer before calling helcimProcess
      clearHelcimResults();
      expectingTokenizationRef.current = true;

      if (globalThis.helcimProcess) {
        globalThis.helcimProcess();
      } else {
        throw new Error('Helcim payment processor not available');
      }
    } catch (error) {
      expectingTokenizationRef.current = false;
      setPaymentState('error');
      setErrorMessage(resolvePaymentErrorMessage(error));
    }
  };

  const handleReset = (): void => {
    form.reset();
    setPaymentState('idle');
    paymentIdRef.current = null;
    expectingTokenizationRef.current = false;
    setPaymentId(null);
    setErrorMessage(null);
    setIsPolling(false);
  };

  if (paymentState === 'success') {
    return <PaymentSuccessCard amount={form.amount} onClose={onCancel} />;
  }

  if (paymentState === 'error') {
    return (
      <PaymentErrorCard errorMessage={errorMessage} onCancel={onCancel} onRetry={handleReset} />
    );
  }

  return (
    <OverlayContent>
      <OverlayHeader title="Add Credits" description="Enter amount and card details" />
      <form
        ref={paymentFormRef}
        id="helcimForm"
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        className="space-y-2"
        noValidate
      >
        {/* Hidden Helcim fields */}
        <input type="hidden" id="token" value={jsToken ?? ''} />
        <input type="hidden" id="amount" value={form.amount} />

        <FormInput
          id="amount-input"
          label="Amount (USD) - Minimum $5"
          type="number"
          min={MIN_DEPOSIT_AMOUNT}
          max={MAX_DEPOSIT_AMOUNT}
          step="0.01"
          icon={<DollarSign className="h-5 w-5" />}
          value={form.amount}
          onChange={(e) => {
            form.handleAmountChange(e.target.value);
          }}
          onKeyDown={(e) => {
            // Block non-numeric characters that number inputs allow (e, E, +, -)
            if (['e', 'E', '+', '-'].includes(e.key)) {
              e.preventDefault();
            }
          }}
          aria-invalid={!!form.amountValidation.error}
          error={form.amountValidation.error}
          success={form.amountValidation.success}
          className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />

        <CardFormSection scriptError={scriptError} scriptLoaded={scriptLoaded} form={form} />

        {paymentState === 'processing' && (
          <div className="py-4 text-center">
            <p className="text-muted-foreground animate-pulse">Processing payment...</p>
          </div>
        )}
      </form>

      <PaymentFormActions
        onCancel={onCancel}
        scriptLoaded={scriptLoaded}
        paymentState={paymentState}
        isPaymentPending={createPayment.isPending}
      />

      <div data-testid={TEST_IDS.helcimSecurityBadge} className="flex justify-center">
        <HelcimLogo />
      </div>

      <DevOnly>
        <div className="flex gap-2" data-testid={TEST_IDS.devSimulationButtons}>
          <Button
            type="button"
            variant="outline"
            onClick={handleSimulateSuccess}
            disabled={paymentState === 'processing'}
            className="flex-1"
            data-testid={TEST_IDS.simulateSuccessBtn}
          >
            Simulate Success
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleSimulateFailure}
            disabled={paymentState === 'processing'}
            className="flex-1"
            data-testid={TEST_IDS.simulateFailureBtn}
          >
            Simulate Failure
          </Button>
        </div>
      </DevOnly>
    </OverlayContent>
  );
}
