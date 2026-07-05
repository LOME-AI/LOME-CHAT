import { describe, it, expect } from 'vitest';
import {
  COST_CIRCUIT_MULTIPLIER,
  PAYMENT_MINIMUM_NANO_USD,
  PAYMENT_VERIFY_JOB_TYPE,
  admitRun,
  applyPaymentWebhookEvent,
  chargeWithinTx,
  createBillingManifest,
  createBillingStores,
  createHelcimPaymentProvider,
  createMockPaymentProvider,
  createPaymentProviderFromEnv,
  createPaymentVerifyJobRegistration,
  createWebhookVerifier,
  initiateCardPayment,
  provisionUserBilling,
} from './index.js';

describe('billing slice barrel', () => {
  it('exposes the payment seam factories and the webhook verifier', () => {
    expect(typeof createHelcimPaymentProvider).toBe('function');
    expect(typeof createMockPaymentProvider).toBe('function');
    expect(typeof createPaymentProviderFromEnv).toBe('function');
    expect(typeof createWebhookVerifier).toBe('function');
  });

  it('exposes the money core: charge, admission, provisioning', () => {
    expect(typeof chargeWithinTx).toBe('function');
    expect(typeof admitRun).toBe('function');
    expect(typeof provisionUserBilling).toBe('function');
    expect(typeof createBillingStores).toBe('function');
    expect(typeof createBillingManifest).toBe('function');
    expect(COST_CIRCUIT_MULTIPLIER).toBe(5n);
  });

  it('exposes the Pattern-D payment flow: charge, webhook application, verify job', () => {
    expect(typeof initiateCardPayment).toBe('function');
    expect(typeof applyPaymentWebhookEvent).toBe('function');
    expect(typeof createPaymentVerifyJobRegistration).toBe('function');
    expect(PAYMENT_MINIMUM_NANO_USD).toBe(5_000_000_000n);
    expect(PAYMENT_VERIFY_JOB_TYPE).toBe('payment.verify.v1');
  });
});
