import { describe, it, expect } from 'vitest';
import {
  createHelcimPaymentProvider,
  createMockPaymentProvider,
  createPaymentProviderFromEnv,
  createWebhookVerifier,
} from './index.js';

describe('billing slice barrel', () => {
  it('exposes the payment seam factories and the webhook verifier', () => {
    expect(typeof createHelcimPaymentProvider).toBe('function');
    expect(typeof createMockPaymentProvider).toBe('function');
    expect(typeof createPaymentProviderFromEnv).toBe('function');
    expect(typeof createWebhookVerifier).toBe('function');
  });
});
