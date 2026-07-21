import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { renderWithProviders } from '@/test-utils/render';
import { makeBalance } from '@/test-utils/balance-fixture';
import * as billingHooks from '@/hooks/billing/billing';
import { resetHelcimLoader } from '../../lib/helcim-loader';
import { uninstallMockHelcim } from '../../lib/helcim-mock';
import { PaymentForm } from './payment-form';

// api.ts parses VITE_API_URL at import time via frontendEnvSchema; the test
// runtime has no Vite env, so override just the schema while keeping the rest
// of @hushbox/shared (TEST_IDS) real.
vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    frontendEnvSchema: { parse: () => ({ VITE_API_URL: 'http://localhost:8787' }) },
  };
});

// Local-dev env: PaymentForm selects the mock tokenizer
// (loadHelcimScript({ useMock: true })) and renders the DevOnly simulate
// buttons — the exact path the billing e2e suite drives. helcim-loader and
// helcim-mock stay REAL here: this file is the mock↔form tokenization parity
// contract, so it must fail if the mock stops satisfying the tokenization
// signal the form waits on.
vi.mock('@/lib/env', () => ({
  env: {
    isDev: true,
    isLocalDev: true,
    isDevServer: true,
    isProduction: false,
    isCI: false,
    isE2E: false,
    requiresRealServices: false,
  },
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

// jsdom (verified v28) reflects `input.value = …` property writes into the
// `value` content attribute and fires an attribute MutationRecord; real
// browsers never do (the dirty value flag decouples the property from the
// attribute). That infidelity is exactly what let observer-based tokenization
// look green in unit tests while freezing in real browsers when the mock only
// wrote `.value`. Neutralize it: observers attached to #helcimResults see
// nothing — like a browser watching the mock's property writes — so the form
// must complete tokenization through the typed loader signal instead.
class BrowserFaithfulMutationObserver extends MutationObserver {
  override observe(target: Node, options?: MutationObserverInit): void {
    if (target instanceof Element && target.id === 'helcimResults') return;
    super.observe(target, options);
  }
}

describe('PaymentForm × mock Helcim tokenization contract', () => {
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
    vi.stubGlobal('MutationObserver', BrowserFaithfulMutationObserver);
    resetHelcimLoader();

    vi.mocked(billingHooks.useInitiatePayment).mockReturnValue(
      mockInitiatePayment as unknown as ReturnType<typeof billingHooks.useInitiatePayment>
    );
    vi.mocked(billingHooks.useBalance).mockReturnValue({
      data: makeBalance('10000000000'),
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof billingHooks.useBalance>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    uninstallMockHelcim();
    resetHelcimLoader();
  });

  it('dispatches the charge with the mock-minted token after simulate-success tokenization', async () => {
    const user = userEvent.setup();
    mockInitiatePayment.mutateAsync.mockResolvedValue({
      paymentId: 'pay_123',
      status: 'completed',
      amountNanoUsd: '100000000000',
    });

    renderWithProviders(<PaymentForm />);

    await user.click(await screen.findByTestId(TEST_IDS.simulateSuccessBtn));

    await waitFor(() => {
      expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mockInitiatePayment.mutateAsync).toHaveBeenCalledWith({
      amountNanoUsd: '100000000000',
      cardToken: expect.stringMatching(/^mock-token-/) as unknown,
      customerCode: expect.stringMatching(/^mock-customer-/) as unknown,
    });
  });

  it('reaches the terminal success state after the mock-tokenized charge completes', async () => {
    const user = userEvent.setup();
    mockInitiatePayment.mutateAsync.mockResolvedValue({
      paymentId: 'pay_123',
      status: 'completed',
      amountNanoUsd: '100000000000',
    });

    renderWithProviders(<PaymentForm />);

    await user.click(await screen.findByTestId(TEST_IDS.simulateSuccessBtn));

    await waitFor(() => {
      expect(screen.getByText(/payment successful/i)).toBeInTheDocument();
    });
  });

  it('reaches the terminal error state on the declined mock card without dispatching a charge', async () => {
    const user = userEvent.setup();

    renderWithProviders(<PaymentForm />);

    await user.click(await screen.findByTestId(TEST_IDS.simulateFailureBtn));

    await waitFor(() => {
      expect(screen.getByText(/card declined/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(mockInitiatePayment.mutateAsync).not.toHaveBeenCalled();
  });
});
