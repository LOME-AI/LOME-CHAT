import { createEnvUtilities } from '@hushbox/shared';
import { createHelcimPaymentProvider } from './payment-helcim.js';
import { createMockPaymentProvider } from './payment-mock.js';
import type { EnvContext } from '@hushbox/shared';
import type { PaymentProvider } from '../ports/index.js';

/** Where the payment webhook route mounts; wiring overrides via `webhookPath`. */
const DEFAULT_WEBHOOK_PATH = '/api/webhooks/payment';

interface PaymentProviderEnv extends EnvContext {
  HELCIM_API_TOKEN?: string;
  HELCIM_WEBHOOK_VERIFIER?: string;
  API_URL?: string;
}

export interface PaymentProviderFactoryOptions {
  readonly webhookPath?: string;
}

/**
 * envUtils-gated provider selection: local dev gets the in-process mock
 * (signed webhooks against the local route), everything else gets the real
 * Helcim adapter. Missing config fails fast — there is no degraded mode.
 */
export function createPaymentProviderFromEnv(
  env: PaymentProviderEnv,
  options: PaymentProviderFactoryOptions = {}
): PaymentProvider {
  // Fail-fast on missing config, not an environment branch (envUtils still
  // owns all mode branching): createEnvUtilities defaults a missing NODE_ENV
  // to development, so a production deploy that omitted it would otherwise
  // silently select the mock — which approves every charge for free and
  // self-delivers validly signed webhooks. Selecting a payment provider on a
  // defaulted variable is exactly the fallback CODE-RULES forbids.
  if (env.NODE_ENV === undefined) {
    throw new Error('NODE_ENV must be set explicitly to select a payment provider');
  }

  const { isLocalDev } = createEnvUtilities(env);

  if (isLocalDev) {
    if (env.API_URL === undefined || env.HELCIM_WEBHOOK_VERIFIER === undefined) {
      throw new Error(
        'API_URL and HELCIM_WEBHOOK_VERIFIER are required for the local payment mock'
      );
    }
    return createMockPaymentProvider({
      webhookUrl: `${env.API_URL}${options.webhookPath ?? DEFAULT_WEBHOOK_PATH}`,
      webhookVerifier: env.HELCIM_WEBHOOK_VERIFIER,
    });
  }

  if (env.HELCIM_API_TOKEN === undefined) {
    throw new Error('HELCIM_API_TOKEN is required outside local dev');
  }

  return createHelcimPaymentProvider({ apiToken: env.HELCIM_API_TOKEN });
}
