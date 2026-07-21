import { createEnvUtilities } from '@hushbox/shared';
import { createHelcimPaymentProvider } from './payment-helcim.js';
import { createMockPaymentProvider } from './payment-mock.js';
import type { EnvContext } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { PaymentProvider, WebhookDeliveryLifetime } from '../ports/index.js';

/** Where the payment webhook route mounts; wiring overrides via `webhookPath`. */
const DEFAULT_WEBHOOK_PATH = '/api/webhooks/payment';

interface PaymentProviderEnv extends EnvContext {
  HELCIM_API_TOKEN?: string;
  HELCIM_WEBHOOK_VERIFIER?: string;
  API_URL?: string;
}

export interface PaymentProviderFactoryOptions {
  readonly webhookPath?: string;
  /**
   * Threaded only to the local mock so it can register its self-delivered
   * webhook on the request lifetime. The real Helcim provider never receives
   * it — the production path is unchanged.
   */
  readonly executionCtx?: WebhookDeliveryLifetime | undefined;
}

/**
 * envUtils-gated provider selection: local dev gets the in-process mock
 * (signed webhooks against the local route), everything else gets the real
 * Helcim adapter. Missing config fails fast — there is no degraded mode.
 */
export function createPaymentProviderFromEnv(
  env: PaymentProviderEnv,
  db?: Database,
  options: PaymentProviderFactoryOptions = {}
): PaymentProvider {
  // Explicit fail-fast at the selection seam (envUtils still owns all mode
  // branching): createEnvUtilities throws on an absent NODE_ENV, and this guard
  // restates that with a provider-specific message so a production deploy that
  // omitted it fails loudly instead of ever risking the mock — which approves
  // every charge for free and self-delivers validly signed webhooks. Selecting a
  // payment provider on an unset variable is exactly the fallback CODE-RULES forbids.
  if (env.NODE_ENV === undefined) {
    throw new Error('NODE_ENV must be set explicitly to select a payment provider');
  }

  const { isLocalDev, isCI } = createEnvUtilities(env);

  if (isLocalDev) {
    if (env.API_URL === undefined || env.HELCIM_WEBHOOK_VERIFIER === undefined) {
      throw new Error(
        'API_URL and HELCIM_WEBHOOK_VERIFIER are required for the local payment mock'
      );
    }
    return createMockPaymentProvider({
      webhookUrl: `${env.API_URL}${options.webhookPath ?? DEFAULT_WEBHOOK_PATH}`,
      webhookVerifier: env.HELCIM_WEBHOOK_VERIFIER,
      // `undefined` and absent are equivalent — the mock reads
      // `config.executionCtx?.waitUntil`, so no branch is needed here.
      executionCtx: options.executionCtx,
    });
  }

  if (env.HELCIM_API_TOKEN === undefined) {
    throw new Error('HELCIM_API_TOKEN is required outside local dev');
  }

  // The mock never receives db — only the real adapter records evidence, and
  // only when a db is wired (CI-gated inside `recordServiceEvidence`).
  return createHelcimPaymentProvider({
    apiToken: env.HELCIM_API_TOKEN,
    ...(db === undefined ? {} : { db, isCI }),
  });
}
