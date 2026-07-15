import { useState, useEffect, useRef, useCallback } from 'react';
import { DollarSign, CreditCard, Lock, MapPin, User, Home } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, ModalActions, OverlayContent, OverlayHeader } from '@hushbox/ui';
import {
  TEST_IDS,
  dollarsToNanoUsd,
  legacyFriendlyErrorMessage,
  parseNanoUSD,
} from '@hushbox/shared';
import { FormInput } from '@/components/shared/form-input';
import { DevOnly } from '@/components/shared/dev-only';
import { getErrorBody } from '@/lib/api';
import { env } from '@/lib/env';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav.js';
import { useInitiatePayment, useBalance, billingKeys } from '@/hooks/billing/billing.js';
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

// `pending_credit` is the terminal state after an `awaiting_webhook` charge
// whose credit did not land before the poll timeout. The processor has ALREADY
// approved the charge; the credit is guaranteed by the webhook + the
// `payment.verify.v1` reconcile job. This state must never offer a re-charge —
// re-tokenizing would mint a fresh Idempotency-Key the server cannot dedup,
// double-charging the card.
//
// `unconfirmed` is the terminal state after the `POST /billing/payments` request
// was dispatched but threw (network drop / 5xx) — the charge OUTCOME IS UNKNOWN:
// the processor may already have approved before our response was lost. A
// fresh-key re-submit would mint a new server pre-claim that cannot be deduped
// against the first, double-charging the card. Like `pending_credit`, this state
// offers NO re-charge — only a balance re-read and a close.
type PaymentState = 'idle' | 'processing' | 'success' | 'error' | 'pending_credit' | 'unconfirmed';

// Max time to wait for the asynchronous webhook credit to land (observed as the
// balance increasing) before telling the user to check their balance. A charged
// user must always get a resolution even if the webhook is slow.
const POLLING_TIMEOUT_MS = 60_000;

// How often to re-read the balance while awaiting the webhook credit.
const BALANCE_POLL_INTERVAL_MS = 2000;

/**
 * The Helcim.js tokenization token, from the env registry (VITE_HELCIM_JS_TOKEN,
 * supplied in CiE2E/Production; absent in dev and CiVitest, which use the mock
 * tokenizer). In production the token MUST exist — its absence is a deploy
 * misconfiguration, so fail fast rather than silently POST an empty token to
 * Helcim. Elsewhere an absent token yields an empty string the mock ignores.
 */
function resolveHelcimJsToken(isProduction: boolean): string {
  const token = import.meta.env['VITE_HELCIM_JS_TOKEN'] as string | undefined;
  if (token !== undefined && token !== '') return token;
  if (isProduction) throw new Error('VITE_HELCIM_JS_TOKEN is not configured');
  return '';
}

// Resolves a thrown payment error into a user-facing reason. ApiError carries
// a machine-readable code (e.g. PAYMENT_DECLINED) which legacyFriendlyErrorMessage
// maps to copy; unknown/non-ApiError errors fall back to the generic message.
function resolvePaymentErrorMessage(error: unknown): string {
  const code = getErrorBody(error)?.code;
  // legacyFriendlyErrorMessage returns its generic fallback for unknown/empty codes.
  return legacyFriendlyErrorMessage(code ?? '');
}

// Copy for a charge the processor rejected (`failed`) or that could not be
// confirmed before expiry (`expired`). These are returned inline by the single
// `POST /billing/payments` call — no code is thrown, so this maps status → copy.
function statusErrorMessage(status: 'failed' | 'expired'): string {
  return status === 'expired'
    ? 'Your payment could not be confirmed and has expired. Please try again.'
    : 'Your payment was declined. Please try again or use a different card.';
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

// Copy for the two terminal no-re-charge cards. `approved` = an `awaiting_webhook`
// charge whose credit is guaranteed but slow (the card was approved). `unconfirmed`
// = a charge whose outcome is unknown because the request threw (the card MAY have
// been charged). Both deliberately expose only a balance re-read and a close.
const PROCESSING_COPY = {
  approved: {
    title: 'Payment Processing',
    description: 'Your card was approved and the credit is on its way',
    body: "Your payment is processing and will be credited shortly — check your balance in a moment, or contact support if it doesn't appear.",
  },
  unconfirmed: {
    title: 'Payment Unconfirmed',
    description: "We couldn't confirm your payment",
    body: "Check your balance in a moment — if the credit doesn't appear, contact support before trying again.",
  },
} as const;

interface PaymentProcessingCardProps {
  onDone?: (() => void) | undefined;
  onRefreshBalance: () => void;
  variant: 'approved' | 'unconfirmed';
}

/**
 * Terminal state for a charge that cannot be safely re-issued: either an approved
 * (`awaiting_webhook`) charge whose credit was not observed before the poll
 * timeout, or a charge whose request threw with an unknown outcome. Deliberately
 * offers NO re-charge path: only a balance re-read and a close. A second
 * `POST /billing/payments` here would re-tokenize and risk double-charging.
 */
function PaymentProcessingCard({
  onDone,
  onRefreshBalance,
  variant,
}: Readonly<PaymentProcessingCardProps>): React.JSX.Element {
  const copy = PROCESSING_COPY[variant];
  return (
    <OverlayContent>
      <OverlayHeader title={copy.title} description={copy.description} />
      <div className="py-4 text-center">
        <p className="text-muted-foreground">{copy.body}</p>
      </div>
      <ModalActions
        cancel={{
          label: 'Refresh Balance',
          onClick: onRefreshBalance,
        }}
        primary={{
          label: 'Done',
          onClick: () => {
            onDone?.();
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
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function PaymentForm({
  onSuccess,
  onCancel,
}: Readonly<PaymentFormProps>): React.JSX.Element {
  const isDevMode = env.isLocalDev;
  const jsToken = resolveHelcimJsToken(env.isProduction);

  const form = usePaymentForm();

  const [paymentState, setPaymentState] = useState<PaymentState>('idle');
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const observerRef = useRef<MutationObserver | null>(null);
  const expectingTokenizationRef = useRef(false);
  const simulateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paymentFormRef = useRef<HTMLFormElement>(null);
  // The purchased-wallet snapshot (NanoUSD, bigint) captured when
  // awaiting-webhook polling begins; the credit is confirmed when the live
  // balance rises above it.
  const pollBaselineRef = useRef<bigint>(0n);
  useFormEnterNav(paymentFormRef);

  const queryClient = useQueryClient();
  const initiatePayment = useInitiatePayment();
  // Enabled unconditionally: the payment form is only shown to a signed-in
  // (or billing-only) principal, and polling needs the query mounted to refetch.
  const { data: balanceData, refetch: refetchBalance } = useBalance({ enabled: true });
  // A deposit credits the purchased wallet; the poll watches that value rise.
  const displayBalance = balanceData?.purchased.balanceNanoUsd ?? '0';

  const stopPolling = useCallback((): void => {
    setIsPolling(false);
  }, []);

  // Deadline: a real timer, not a data dependency, so it fires once polling
  // starts and clears when polling settles or the form unmounts. Polling only
  // ever begins after an `awaiting_webhook` charge, so a timeout here means an
  // approved charge whose credit is still in flight — the terminal
  // `pending_credit` state (never a re-chargeable error).
  useEffect(() => {
    if (!isPolling) return;

    const timer = setTimeout(() => {
      setIsPolling(false);
      setPaymentState('pending_credit');
    }, POLLING_TIMEOUT_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [isPolling]);

  // Re-read the balance on an interval while awaiting the webhook credit. There
  // is no payment-status route — the credit's arrival is observed as the balance
  // increasing past the pre-charge baseline.
  useEffect(() => {
    if (!isPolling) return;

    const interval = setInterval(() => {
      void refetchBalance();
    }, BALANCE_POLL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, [isPolling, refetchBalance]);

  // Confirm the credit the moment the polled balance rises above the baseline.
  useEffect(() => {
    if (!isPolling) return;
    if (parseNanoUSD(displayBalance) <= pollBaselineRef.current) return;

    stopPolling();
    setPaymentState('success');
    void queryClient.invalidateQueries({ queryKey: billingKeys.transactions() });
    onSuccess?.();
  }, [isPolling, displayBalance, stopPolling, queryClient, onSuccess]);

  const handleTokenizationResult = useCallback(
    async (result: HelcimTokenResult): Promise<void> => {
      // Disable further processing until next helcimProcess() call
      expectingTokenizationRef.current = false;

      if (!result.success) {
        setPaymentState('error');
        setErrorMessage(result.errorMessage ?? 'Card tokenization failed');
        return;
      }

      if (!result.cardToken || !result.customerCode) {
        setPaymentState('error');
        setErrorMessage('Missing card token or customer code');
        return;
      }

      try {
        // One pre-claimed charge (Pattern D): tokenize first (done), then this
        // single call. The server mints the payment id; there is no create step.
        const response = await initiatePayment.mutateAsync({
          amountNanoUsd: dollarsToNanoUsd(form.amount),
          cardToken: result.cardToken,
          customerCode: result.customerCode,
        });

        if (response.status === 'completed') {
          setPaymentState('success');
          onSuccess?.();
        } else if (response.status === 'awaiting_webhook') {
          // Baseline the balance now, before the credit lands, then poll for it.
          pollBaselineRef.current = parseNanoUSD(displayBalance);
          setIsPolling(true);
        } else {
          setPaymentState('error');
          setErrorMessage(statusErrorMessage(response.status));
        }
      } catch {
        // The charge request was already dispatched, so its outcome is UNKNOWN —
        // a network drop or 5xx can hide a charge the processor already approved.
        // The server's confirmed no-charge signal arrives inline as a `failed`/
        // `expired` STATUS (handled above), never as a throw. Routing a throw to
        // the retryable error card would let a fresh-key re-submit double-charge,
        // so land in the terminal no-re-charge state instead.
        setPaymentState('unconfirmed');
      }
    },
    [initiatePayment, onSuccess, form.amount, displayBalance]
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

  const handleSubmit = (e: React.SyntheticEvent): void => {
    e.preventDefault();

    if (!form.validateAll()) {
      return;
    }

    setPaymentState('processing');

    try {
      // Tokenize FIRST (Helcim.js), then charge in one call once the observer
      // reads the token. The server mints the payment id — no pre-create step.
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
    expectingTokenizationRef.current = false;
    setErrorMessage(null);
    setIsPolling(false);
  };

  if (paymentState === 'success') {
    return <PaymentSuccessCard amount={form.amount} onClose={onCancel} />;
  }

  if (paymentState === 'pending_credit') {
    return (
      <PaymentProcessingCard
        variant="approved"
        onDone={onCancel}
        onRefreshBalance={() => {
          void refetchBalance();
        }}
      />
    );
  }

  if (paymentState === 'unconfirmed') {
    return (
      <PaymentProcessingCard
        variant="unconfirmed"
        onDone={onCancel}
        onRefreshBalance={() => {
          void refetchBalance();
        }}
      />
    );
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
        onSubmit={handleSubmit}
        className="space-y-2"
        noValidate
      >
        {/* Hidden Helcim fields */}
        <input type="hidden" id="token" value={jsToken} />
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
        isPaymentPending={initiatePayment.isPending}
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
