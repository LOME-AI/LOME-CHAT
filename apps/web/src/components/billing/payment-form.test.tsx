import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import { renderWithProviders } from '@/test-utils/render';
import { makeBalance } from '@/test-utils/balance-fixture';
import * as envModule from '@/lib/env';
import { ApiError } from '@/lib/api';
import { PaymentForm } from './payment-form';
import * as helcimLoader from '../../lib/helcim-loader';
import * as billingHooks from '@/hooks/billing/billing';

// api.ts parses VITE_API_URL at import time via frontendEnvSchema; the test
// runtime has no Vite env, so override just that schema while keeping the rest
// of @hushbox/shared (friendlyErrorMessage, TEST_IDS) real.
vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    frontendEnvSchema: { parse: () => ({ VITE_API_URL: 'http://localhost:8787' }) },
  };
});

vi.mock('../../lib/helcim-loader', () => ({
  loadHelcimScript: vi.fn(),
  tokenizeWithHelcim: vi.fn(),
}));

vi.mock('@/hooks/billing/billing', () => ({
  useInitiatePayment: vi.fn(),
  useBalance: vi.fn(),
  billingKeys: {
    all: ['billing'] as const,
    balance: () => ['billing', 'balance'] as const,
    transactions: () => ['billing', 'transactions'] as const,
    transactionList: (cursor?: string) => ['billing', 'transactions', { cursor }] as const,
  },
}));

vi.mock('@/lib/env', () => ({
  env: {
    isDev: true,
    isLocalDev: false,
    isProduction: false,
    isCI: false,
    requiresRealServices: false,
  },
}));

vi.mock('@/components/shared/form-input', () => ({
  FormInput: ({
    label,
    id,
    error,
    success,
    ...props
  }: {
    label: string;
    id?: string;
    error?: string;
    success?: string;
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input id={id} {...props} />
      {error && <span role="alert">{error}</span>}
      {success && id && <span data-testid={`${id}-success`}>{success}</span>}
    </div>
  ),
}));

// Mutable purchased-wallet balance (NanoUSD string) the useBalance mock reads;
// flip it (and re-render) to simulate the webhook credit landing during
// awaiting-webhook polling. $10 = 10_000_000_000 nano.
const balanceState = { current: '10000000000' };
const mockRefetch = vi.fn();

async function fillValidCardDetails(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/card number/i), '4111111111111111');
  await user.type(screen.getByLabelText(/expiry/i), '1230');
  await user.type(screen.getByLabelText(/cvv/i), '123');
  await user.type(screen.getByLabelText(/name on card/i), 'Test User');
  await user.type(screen.getByLabelText(/billing address/i), '123 Test Street');
  await user.type(screen.getByLabelText(/zip/i), '12345');
}

// userEvent deadlocks under fake timers (it awaits its own setTimeout), so the
// timeout tests drive the form synchronously via fireEvent + act and flush
// pending microtasks between steps.
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setFieldById(id: string, value: string): void {
  const el = document.querySelector(`#${id}`);
  if (!el) throw new Error(`field #${id} not found`);
  fireEvent.change(el, { target: { value } });
}

function submitPaymentForm(): HTMLFormElement {
  const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
  if (!formEl) throw new Error('payment form not found');
  return formEl;
}

function fillValidCardDetailsById(): void {
  setFieldById('amount-input', '50');
  setFieldById('cardNumber', '4111111111111111');
  setFieldById('cardExpiryDate', '12/30');
  setFieldById('cardCVV', '123');
  setFieldById('cardHolderName', 'Test User');
  setFieldById('cardHolderAddress', '123 Test Street');
  setFieldById('cardHolderPostalCode', '12345');
}

describe('PaymentForm', () => {
  const mockInitiatePayment = {
    mutateAsync: vi.fn(),
    mutate: vi.fn(),
    isPending: false,
    isIdle: true,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: null,
    variables: undefined,
    reset: vi.fn(),
    context: undefined,
    failureCount: 0,
    failureReason: null,
    status: 'idle' as const,
    submittedAt: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    balanceState.current = '10000000000';

    // The token is registry-supplied (VITE_HELCIM_JS_TOKEN) in CiE2E/Production;
    // stub a configured non-dev value so the form renders like a real deploy.
    vi.stubEnv('VITE_HELCIM_JS_TOKEN', 'test-js-token');

    vi.mocked(envModule).env = {
      isDev: true,
      isLocalDev: false,
      isDevServer: false,
      isProduction: false,
      isCI: false,
      isE2E: false,
      requiresRealServices: false,
    };

    vi.mocked(billingHooks.useInitiatePayment).mockReturnValue(
      mockInitiatePayment as unknown as ReturnType<typeof billingHooks.useInitiatePayment>
    );
    vi.mocked(billingHooks.useBalance).mockImplementation(
      () =>
        ({
          data: makeBalance(balanceState.current),
          refetch: mockRefetch,
        }) as unknown as ReturnType<typeof billingHooks.useBalance>
    );
    vi.mocked(helcimLoader.loadHelcimScript).mockResolvedValue();
    vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
      success: false,
      errorMessage: 'No card data',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('Helcim token configuration', () => {
    it('fails fast when the real tokenizer is used and the token is missing', () => {
      // Real tokenizer runs whenever !isLocalDev (production OR CiE2E). Here the
      // required token is absent, so resolution must throw.
      vi.stubEnv('VITE_HELCIM_JS_TOKEN', '');
      vi.mocked(envModule).env = {
        isDev: false,
        isLocalDev: false,
        isDevServer: false,
        isProduction: true,
        isCI: false,
        isE2E: false,
        requiresRealServices: true,
      };
      expect(() => renderWithProviders(<PaymentForm />)).toThrow(/VITE_HELCIM_JS_TOKEN/);
    });

    it('renders and emits an empty token in the mock tokenizer path (local dev)', () => {
      // Mock tokenizer runs when isLocalDev; it ignores the token, so resolution
      // is empty even when the var happens to be present.
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: false,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };
      expect(() => renderWithProviders(<PaymentForm />)).not.toThrow();
      expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
      const tokenInput = document.querySelector<HTMLInputElement>('#token');
      expect(tokenInput?.value).toBe('');
    });

    it('emits the configured token when the real tokenizer is used (CiE2E / production)', () => {
      // beforeEach sets isLocalDev:false (the CiE2E state) with a configured
      // token. Token resolution mirrors tokenizer selection, so the real
      // tokenizer must receive the sandbox token — not an empty string.
      renderWithProviders(<PaymentForm />);
      const tokenInput = document.querySelector<HTMLInputElement>('#token');
      expect(tokenInput?.value).toBe('test-js-token');
    });
  });

  describe('single-page layout', () => {
    it('renders amount input on initial render', () => {
      renderWithProviders(<PaymentForm />);
      expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
    });

    it('shows minimum $5 in label', () => {
      renderWithProviders(<PaymentForm />);
      expect(screen.getByLabelText(/amount.*minimum.*\$5/i)).toBeInTheDocument();
    });

    it('renders card input fields after script loads', async () => {
      renderWithProviders(<PaymentForm />);
      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/expiry/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/cvv/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/name on card/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/billing address/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/zip/i)).toBeInTheDocument();
      });
    });

    it('loads helcim script on mount', async () => {
      renderWithProviders(<PaymentForm />);
      await waitFor(() => {
        expect(helcimLoader.loadHelcimScript).toHaveBeenCalled();
      });
    });

    it('renders purchase button', () => {
      renderWithProviders(<PaymentForm />);
      expect(screen.getByRole('button', { name: /purchase/i })).toBeInTheDocument();
    });

    it('renders cancel button when onCancel provided', () => {
      renderWithProviders(<PaymentForm onCancel={vi.fn()} />);
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('does not render cancel button when onCancel not provided', () => {
      renderWithProviders(<PaymentForm />);
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });
  });

  describe('negative-balance disclosure', () => {
    // BILLING §Fee Structure: a top-up clears the deficit before it adds
    // spendable funds, and that is stated at the point of payment rather than
    // discovered from a balance that does not match the amount paid.
    it('states the deficit and the net credit before submit', async () => {
      balanceState.current = '-500000000';
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await user.type(screen.getByLabelText(/amount/i), '5');

      const disclosure = await screen.findByRole('status');
      expect(disclosure).toHaveTextContent('$0.50');
      expect(disclosure).toHaveTextContent('$4.50');
    });

    it('states the deficit alone until the amount covers it', async () => {
      balanceState.current = '-500000000';
      renderWithProviders(<PaymentForm />);

      const disclosure = await screen.findByRole('status');
      expect(disclosure).toHaveTextContent('$0.50');
      expect(disclosure).not.toHaveTextContent('adds');
    });

    it('says nothing when the balance is not negative', () => {
      balanceState.current = '10000000000';
      renderWithProviders(<PaymentForm />);

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  describe('amount validation', () => {
    it('shows error when amount is empty on submit', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/please enter an amount/i)).toBeInTheDocument();
      });
    });

    it('shows error when amount is below minimum', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '3');
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/minimum deposit is \$5/i)).toBeInTheDocument();
      });
    });

    it('shows error when amount exceeds maximum', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '1500');
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/maximum deposit is \$1000/i)).toBeInTheDocument();
      });
    });

    it('shows success when amount is valid', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/amount/i), '25');

      await waitFor(() => {
        expect(screen.getByTestId('amount-input-success')).toHaveTextContent(/valid/i);
      });
    });

    it('blocks non-numeric characters in amount field', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      const amountInput = screen.getByLabelText(/amount/i);
      await user.type(amountInput, '1e5');

      expect(amountInput).toHaveValue(15);
    });
  });

  describe('card validation', () => {
    it('shows success for valid card number', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/card number/i), '4111111111111111');

      await waitFor(() => {
        expect(screen.getByTestId('cardNumber-success')).toHaveTextContent(/valid/i);
      });
    });

    it('shows error for invalid card number', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/card number/i), '1234567890123456');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/invalid card/i);
      });
    });

    it('shows success for valid expiry', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/expiry/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/expiry/i), '1230');

      await waitFor(() => {
        expect(screen.getByTestId('cardExpiryDate-success')).toHaveTextContent(/valid/i);
      });
    });

    it('shows error for expired card', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/expiry/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/expiry/i), '0120');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/expired/i);
      });
    });

    it('shows success for valid CVV', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/cvv/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/cvv/i), '123');

      await waitFor(() => {
        expect(screen.getByTestId('cardCVV-success')).toHaveTextContent(/valid/i);
      });
    });

    it('shows error for invalid CVV', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/cvv/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/cvv/i), '12');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/3.*digits/i);
      });
    });

    it('shows success for valid ZIP code', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/zip/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/zip/i), '12345');

      await waitFor(() => {
        expect(screen.getByTestId('cardHolderPostalCode-success')).toHaveTextContent(/valid/i);
      });
    });

    it('shows error for invalid ZIP code', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/zip/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/zip/i), '123');
      await user.tab();

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/must be 5 digits/i);
      });
    });
  });

  describe('payment flow', () => {
    it('sends one charge (amountNanoUsd + token + customerCode) after tokenization', async () => {
      const user = userEvent.setup();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'awaiting_webhook',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledWith({
          amountNanoUsd: '50000000000',
          cardToken: 'tok_abc',
          customerCode: 'cust_abc',
        });
      });
    });

    it('shows processing button state during payment', async () => {
      const user = userEvent.setup();
      // Tokenization never settles — the form sits in 'processing' after submit.
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockImplementation(() => new Promise(() => {}));
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /processing/i })).toBeInTheDocument();
      });
    });

    it('routes a rejected charge to the terminal unconfirmed state (no re-charge)', async () => {
      const user = userEvent.setup();
      mockInitiatePayment.mutateAsync.mockRejectedValue(new Error('Charge error'));
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    });
  });

  describe('cancel functionality', () => {
    it('calls onCancel when cancel button clicked', async () => {
      const user = userEvent.setup();
      const onCancel = vi.fn();
      renderWithProviders(<PaymentForm onCancel={onCancel} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('try again functionality', () => {
    it('shows try again button on a server-confirmed failed status', async () => {
      const user = userEvent.setup();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });

    it('resets form when try again clicked', async () => {
      const user = userEvent.setup();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /try again/i }));

      await waitFor(() => {
        expect(screen.getByLabelText(/amount/i)).toHaveValue(null);
        expect(screen.getByRole('button', { name: /purchase/i })).toBeInTheDocument();
      });
    });
  });

  describe('helcim script loading', () => {
    it('shows loading state while helcim script loads', () => {
      vi.mocked(helcimLoader.loadHelcimScript).mockImplementation(() => new Promise(() => {}));

      renderWithProviders(<PaymentForm />);

      expect(screen.getByText(/loading.*payment/i)).toBeInTheDocument();
    });

    it('shows error when helcim script fails to load', async () => {
      vi.mocked(helcimLoader.loadHelcimScript).mockRejectedValue(new Error('Script load failed'));

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByText(/failed.*load.*payment/i)).toBeInTheDocument();
      });
    });

    it('uses fallback copy when script rejection is not an Error instance', async () => {
      vi.mocked(helcimLoader.loadHelcimScript).mockRejectedValue('plain string error');

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByText(/failed to load payment form/i)).toBeInTheDocument();
      });
    });
  });

  describe('accessibility', () => {
    it('has accessible form labels', async () => {
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
      });
    });

    it('associates error messages with input', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        const input = screen.getByLabelText(/amount/i);
        expect(input).toHaveAttribute('aria-invalid', 'true');
      });
    });
  });

  describe('helcim branding', () => {
    it('displays helcim logo', async () => {
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      expect(screen.getByLabelText('Powered by Helcim')).toBeInTheDocument();
    });

    it('displays helcim branding container', async () => {
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      expect(screen.getByTestId(TEST_IDS.helcimSecurityBadge)).toBeInTheDocument();
    });
  });

  describe('keyboard navigation', () => {
    it('Enter on amount field focuses card number field', async () => {
      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      const amountInput = screen.getByLabelText(/amount/i);
      await user.click(amountInput);
      await user.keyboard('{Enter}');

      expect(document.activeElement).toBe(screen.getByLabelText(/card number/i));
    });
  });

  describe('dev simulation buttons', () => {
    it('does not show simulation buttons in production mode', async () => {
      vi.mocked(envModule).env = {
        isDev: false,
        isLocalDev: false,
        isDevServer: false,
        isProduction: true,
        isCI: false,
        isE2E: false,
        requiresRealServices: true,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      expect(screen.queryByTestId(TEST_IDS.devSimulationButtons)).not.toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.simulateSuccessBtn)).not.toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.simulateFailureBtn)).not.toBeInTheDocument();
    });

    it('shows simulation buttons in local dev mode', async () => {
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/card number/i)).toBeInTheDocument();
      });

      expect(screen.getByTestId(TEST_IDS.devSimulationButtons)).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.simulateSuccessBtn)).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.simulateFailureBtn)).toBeInTheDocument();
    });

    it('pre-fills form fields when pre-fill success clicked', async () => {
      const user = userEvent.setup();

      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.simulateSuccessBtn)).toBeInTheDocument();
      });

      const mockSubmit = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) {
        formEl.requestSubmit = mockSubmit;
      }

      await user.click(screen.getByTestId(TEST_IDS.simulateSuccessBtn));

      await waitFor(() => {
        const cardNumberInput = screen.getByLabelText<HTMLInputElement>(/card number/i);
        expect(cardNumberInput.value).toBe('4111 1111 1111 1111');
      });

      const cvvInput = screen.getByLabelText<HTMLInputElement>(/cvv/i);
      const amountInput = screen.getByLabelText<HTMLInputElement>(/amount/i);

      expect(cvvInput.value).toBe('123');
      expect(amountInput.value).toBe('100');
    });

    it('pre-fills form fields with decline CVV when pre-fill decline clicked', async () => {
      const user = userEvent.setup();

      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.simulateFailureBtn)).toBeInTheDocument();
      });

      const mockSubmit = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) {
        formEl.requestSubmit = mockSubmit;
      }

      await user.click(screen.getByTestId(TEST_IDS.simulateFailureBtn));

      await waitFor(() => {
        const cardNumberInput = screen.getByLabelText<HTMLInputElement>(/card number/i);
        expect(cardNumberInput.value).toBe('4111 1111 1111 1111');
      });

      const cvvInput = screen.getByLabelText<HTMLInputElement>(/cvv/i);
      expect(cvvInput.value).toBe('200');
    });
  });

  describe('script-load failure UI', () => {
    it('reload button calls window.location.reload', async () => {
      vi.mocked(helcimLoader.loadHelcimScript).mockRejectedValue(new Error('Script load failed'));
      const reloadSpy = vi.fn();
      const originalLocation = globalThis.location;

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByText(/failed.*load.*payment/i)).toBeInTheDocument();
      });

      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        writable: true,
        value: { reload: reloadSpy },
      });

      try {
        await user.click(screen.getByRole('button', { name: /reload page/i }));
        expect(reloadSpy).toHaveBeenCalled();
      } finally {
        Object.defineProperty(globalThis, 'location', {
          configurable: true,
          writable: true,
          value: originalLocation,
        });
      }
    });
  });

  describe('charge - success path', () => {
    it('shows success view when the charge returns completed', async () => {
      const onSuccess = vi.fn();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'completed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm onSuccess={onSuccess} onCancel={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
      });
      expect(onSuccess).toHaveBeenCalled();
    });

    it('PaymentSuccessCard close button invokes onCancel', async () => {
      const onCancel = vi.fn();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'completed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm onCancel={onCancel} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /close/i }));
      expect(onCancel).toHaveBeenCalled();
    });

    it('PaymentSuccessCard renders without onCancel when omitted', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'completed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
      });

      // Clicking close when no onCancel provided does nothing (no error).
      await user.click(screen.getByRole('button', { name: /close/i }));
    });
  });

  describe('charge - failed / expired status', () => {
    it('shows error copy when the charge returns failed', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/declined/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });

    it('shows expired copy when the charge returns expired', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'expired',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(/expired/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });
  });

  describe('tokenization failures', () => {
    it('shows error view when tokenization returns success: false', async () => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: false,
        errorMessage: 'Card declined by Helcim',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
      expect(mockInitiatePayment.mutateAsync).not.toHaveBeenCalled();
    });

    it('uses fallback error message when tokenization fails without errorMessage', async () => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({ success: false });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });

    it('shows error when tokenization succeeds but the token is missing', async () => {
      // Success without cardToken — should fall through to "missing token" branch.
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
      expect(mockInitiatePayment.mutateAsync).not.toHaveBeenCalled();
    });
  });

  describe('helcim process not available', () => {
    it('shows error when the tokenizer is not installed', async () => {
      const user = userEvent.setup();
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockRejectedValue(
        new Error('Helcim payment processor not available')
      );
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);

      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });
  });

  describe('awaiting-webhook balance polling', () => {
    it('confirms success when the polled balance rises above the pre-charge baseline', async () => {
      const onSuccess = vi.fn();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'awaiting_webhook',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      const { rerender } = renderWithProviders(<PaymentForm onSuccess={onSuccess} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      // Polling started at baseline $10.00; no success yet.
      await waitFor(() => {
        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalled();
      });
      expect(screen.queryByText(/payment successful/i)).not.toBeInTheDocument();

      // The webhook credit lands: balance rises, re-render surfaces it.
      balanceState.current = '110000000000';
      rerender(<PaymentForm onSuccess={onSuccess} />);

      await waitFor(() => {
        expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
      });
      expect(onSuccess).toHaveBeenCalled();
    });

    it('refetches the balance on an interval while awaiting the webhook', async () => {
      vi.useFakeTimers();
      try {
        mockInitiatePayment.mutateAsync.mockResolvedValue({
          paymentId: 'pay_123',
          status: 'awaiting_webhook',
          amountNanoUsd: '50000000000',
        });
        vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
          success: true,
          cardToken: 'tok_abc',
          customerCode: 'cust_abc',
        });
        renderWithProviders(<PaymentForm />);
        await flushMicrotasks();

        fillValidCardDetailsById();
        await act(async () => {
          fireEvent.submit(submitPaymentForm());
          await Promise.resolve();
        });
        await flushMicrotasks();

        mockRefetch.mockClear();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });

        expect(mockRefetch).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('moves to a terminal processing state (never a re-chargeable error) when the credit never lands before the timeout', async () => {
      vi.useFakeTimers();
      try {
        mockInitiatePayment.mutateAsync.mockResolvedValue({
          paymentId: 'pay_123',
          status: 'awaiting_webhook',
          amountNanoUsd: '50000000000',
        });
        vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
          success: true,
          cardToken: 'tok_abc',
          customerCode: 'cust_abc',
        });
        renderWithProviders(<PaymentForm />);
        await flushMicrotasks();

        fillValidCardDetailsById();
        await act(async () => {
          fireEvent.submit(submitPaymentForm());
          await Promise.resolve();
        });
        await flushMicrotasks();

        expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        await flushMicrotasks();

        // The approved charge is still settling: a terminal processing card, not
        // an error card. Crucially there is NO "Try Again" (which would re-charge).
        expect(screen.getByRole('heading', { name: /payment processing/i })).toBeInTheDocument();
        expect(screen.getByText(/credited shortly/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
        expect(screen.queryByText(/timed out/i)).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('never issues a second POST /billing/payments after an awaiting_webhook poll timeout', async () => {
      vi.useFakeTimers();
      try {
        mockInitiatePayment.mutateAsync.mockResolvedValue({
          paymentId: 'pay_123',
          status: 'awaiting_webhook',
          amountNanoUsd: '50000000000',
        });
        vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
          success: true,
          cardToken: 'tok_abc',
          customerCode: 'cust_abc',
        });
        renderWithProviders(<PaymentForm />);
        await flushMicrotasks();

        fillValidCardDetailsById();
        await act(async () => {
          fireEvent.submit(submitPaymentForm());
          await Promise.resolve();
        });
        await flushMicrotasks();

        // Exactly one charge issued so far.
        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(1);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        await flushMicrotasks();

        // The terminal card exposes no re-charge affordance — no editable form,
        // no Purchase, no Try Again. The only actions re-read the balance or close.
        expect(screen.getByRole('heading', { name: /payment processing/i })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /purchase/i })).not.toBeInTheDocument();

        // Clicking the available actions must never re-POST the charge.
        mockRefetch.mockClear();
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: /refresh balance/i }));
          await Promise.resolve();
        });
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: /done/i }));
          await Promise.resolve();
        });
        await flushMicrotasks();

        expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(1);
        // "Refresh Balance" only re-reads the balance; it never charges.
        expect(mockRefetch).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the timeout on unmount without a late state update', async () => {
      vi.useFakeTimers();
      try {
        mockInitiatePayment.mutateAsync.mockResolvedValue({
          paymentId: 'pay_123',
          status: 'awaiting_webhook',
          amountNanoUsd: '50000000000',
        });
        vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
          success: true,
          cardToken: 'tok_abc',
          customerCode: 'cust_abc',
        });
        const { unmount } = renderWithProviders(<PaymentForm />);
        await flushMicrotasks();

        fillValidCardDetailsById();
        await act(async () => {
          fireEvent.submit(submitPaymentForm());
          await Promise.resolve();
        });
        await flushMicrotasks();

        const errorSpy = vi.spyOn(console, 'error');
        unmount();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });

        expect(
          errorSpy.mock.calls.some((call) =>
            String(call[0]).includes('state update on an unmounted')
          )
        ).toBe(false);
        errorSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('dev simulate buttons - timer cleanup', () => {
    it('cleans up the simulate timer on unmount without errors', async () => {
      const user = userEvent.setup();
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      const { unmount } = renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.simulateSuccessBtn)).toBeInTheDocument();
      });

      await user.click(screen.getByTestId(TEST_IDS.simulateSuccessBtn));
      unmount();
    });

    it('triggers form requestSubmit ~100ms after simulate-success click', async () => {
      const user = userEvent.setup();
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.simulateSuccessBtn)).toBeInTheDocument();
      });

      const requestSubmitSpy = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) {
        formEl.requestSubmit = requestSubmitSpy;
      }

      await user.click(screen.getByTestId(TEST_IDS.simulateSuccessBtn));

      await waitFor(() => {
        expect(requestSubmitSpy).toHaveBeenCalled();
      });
    });

    it('triggers form requestSubmit ~100ms after simulate-failure click', async () => {
      const user = userEvent.setup();
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.simulateFailureBtn)).toBeInTheDocument();
      });

      const requestSubmitSpy = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) {
        formEl.requestSubmit = requestSubmitSpy;
      }

      await user.click(screen.getByTestId(TEST_IDS.simulateFailureBtn));

      await waitFor(() => {
        expect(requestSubmitSpy).toHaveBeenCalled();
      });
    });
  });

  describe('helcim script - mounted guard', () => {
    it('ignores resolved script load if component unmounted first', async () => {
      let resolveLoad: () => void = () => {};
      vi.mocked(helcimLoader.loadHelcimScript).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveLoad = resolve;
          })
      );

      const { unmount } = renderWithProviders(<PaymentForm />);

      unmount();

      resolveLoad();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(helcimLoader.loadHelcimScript).toHaveBeenCalled();
    });

    it('ignores rejected script load if component unmounted first', async () => {
      let rejectLoad: (err: Error) => void = () => {};
      vi.mocked(helcimLoader.loadHelcimScript).mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectLoad = reject;
          })
      );

      const { unmount } = renderWithProviders(<PaymentForm />);

      unmount();

      rejectLoad(new Error('boom'));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(helcimLoader.loadHelcimScript).toHaveBeenCalled();
    });
  });

  describe('PaymentErrorCard with onCancel', () => {
    it('renders both Cancel and Try Again buttons when onCancel provided', async () => {
      const onCancel = vi.fn();
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm onCancel={onCancel} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^cancel$/i }));
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('PaymentErrorCard without onCancel', () => {
    it('renders only the try-again primary action', async () => {
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'failed',
        amountNanoUsd: '50000000000',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
    });
  });

  describe('PaymentSuccessCard amount fallback', () => {
    it('renders +$0.00 on the success card when the amount is empty', async () => {
      // A completed charge with an empty amount still renders the success card;
      // the amount display falls back to +$0.00.
      mockInitiatePayment.mutateAsync.mockResolvedValue({
        paymentId: 'pay_123',
        status: 'completed',
        amountNanoUsd: '0',
      });
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      // Drive by id so we can leave the amount blank while still submitting.
      renderWithProviders(<PaymentForm />);
      await flushMicrotasks();

      setFieldById('amount-input', '50');
      setFieldById('cardNumber', '4111111111111111');
      setFieldById('cardExpiryDate', '12/30');
      setFieldById('cardCVV', '123');
      setFieldById('cardHolderName', 'Test User');
      setFieldById('cardHolderAddress', '123 Test Street');
      setFieldById('cardHolderPostalCode', '12345');

      await act(async () => {
        fireEvent.submit(submitPaymentForm());
        await Promise.resolve();
      });
      await flushMicrotasks();

      expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
    });
  });

  describe('amount already set when simulating', () => {
    it('preserves amount when simulate-success is clicked after typing', async () => {
      const user = userEvent.setup();
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };

      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.simulateSuccessBtn)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/amount/i), '25');

      const requestSubmitSpy = vi.fn();
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      if (formEl) formEl.requestSubmit = requestSubmitSpy;

      await user.click(screen.getByTestId(TEST_IDS.simulateSuccessBtn));

      expect(screen.getByLabelText<HTMLInputElement>(/amount/i).value).toBe('25');
    });
  });

  describe('charge - unknown outcome (thrown exception)', () => {
    // A thrown exception means the POST /billing/payments request was dispatched
    // but its outcome is UNKNOWN (network drop / 5xx) — the processor may have
    // already approved. A fresh-key re-submit would double-charge, so the UI must
    // land in a terminal no-re-charge state, never the retryable error card.
    it('routes a thrown charge to a terminal no-re-charge state (never a second POST)', async () => {
      mockInitiatePayment.mutateAsync.mockRejectedValue(new Error('network dropped'));
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm onCancel={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      // Terminal unknown-outcome card: no editable form, no Purchase, no Try Again.
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      expect(screen.getByText(/contact support before trying again/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /purchase/i })).not.toBeInTheDocument();
      expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(1);

      // The only actions re-read the balance or close — never a second charge.
      mockRefetch.mockClear();
      await user.click(screen.getByRole('button', { name: /refresh balance/i }));
      await user.click(screen.getByRole('button', { name: /done/i }));

      expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(1);
      expect(mockRefetch).toHaveBeenCalled();
    });

    it('routes a non-Error thrown value to the same terminal no-re-charge state', async () => {
      mockInitiatePayment.mutateAsync.mockRejectedValue('some string error');
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    });

    // Even a "declined"-looking ApiError is treated conservatively: a thrown
    // response is not a server-confirmed no-charge signal (that arrives inline as
    // a `failed`/`expired` STATUS), so it must not offer a re-charge.
    it('routes a thrown ApiError to the terminal state without a re-charge action', async () => {
      mockInitiatePayment.mutateAsync.mockRejectedValue(new ApiError('PAYMENT_DECLINED', 400));
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockResolvedValue({
        success: true,
        cardToken: 'tok_abc',
        customerCode: 'cust_abc',
      });

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /payment unconfirmed/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    });
  });

  describe('error reason visible in production', () => {
    // beforeEach sets isLocalDev: false, so these run in production mode where
    // DevOnly content is hidden. A PRE-SUBMIT tokenization-trigger failure (the
    // charge is never POSTed, so it is safely retryable) must still surface the
    // real reason on the retryable error card.
    it('shows the reason from a known ApiError code in production', async () => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockRejectedValue(new ApiError('VALIDATION', 400));

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(friendlyErrorMessage('VALIDATION'))).toBeInTheDocument();
      });
      // Never POSTed — the retryable error card is correct here.
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(mockInitiatePayment.mutateAsync).not.toHaveBeenCalled();
    });

    it('shows generic fallback for an unknown error code', async () => {
      vi.mocked(helcimLoader.tokenizeWithHelcim).mockRejectedValue(
        new ApiError('SOMETHING_WEIRD', 500)
      );

      const user = userEvent.setup();
      renderWithProviders(<PaymentForm />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /purchase/i })).not.toBeDisabled();
      });

      await user.type(screen.getByLabelText(/amount/i), '50');
      await fillValidCardDetails(user);
      await user.click(screen.getByRole('button', { name: /purchase/i }));

      await waitFor(() => {
        expect(screen.getByText(friendlyErrorMessage('SOMETHING_WEIRD'))).toBeInTheDocument();
      });
    });
  });
});
