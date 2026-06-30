import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import { createMockHelcimClient } from './mock.js';
import { createHelcimClient } from './helcim.js';
import { WEBHOOK_PAYMENT_PATH } from './mock-webhook.js';
import type { HelcimClient } from './types.js';
import type { EvidenceConfig } from '@hushbox/db';

export type {
  HelcimClient,
  MockHelcimClient,
  ProcessPaymentRequest,
  ProcessPaymentResponse,
} from './types.js';
export { createMockHelcimClient } from './mock.js';
export { createHelcimClient, verifyWebhookSignatureAsync } from './helcim.js';

interface HelcimEnv extends EnvContext {
  HELCIM_API_TOKEN?: string;
  HELCIM_WEBHOOK_VERIFIER?: string;
  API_URL?: string;
}

/**
 * Get the appropriate Helcim client based on environment.
 *
 * - Local dev: Returns mock client with webhook scheduling
 * - CI/Production: Requires real credentials, fails fast if missing.
 *   When `evidence` is supplied (db + isCI), the real client records evidence
 *   after every successful processPayment so the CI verify:evidence step can
 *   prove the integration was exercised.
 */
export function getHelcimClient(env: HelcimEnv, evidence?: EvidenceConfig): HelcimClient {
  const { isLocalDev } = createEnvUtilities(env);

  if (isLocalDev) {
    if (!env.API_URL || !env.HELCIM_WEBHOOK_VERIFIER) {
      throw new Error('API_URL and HELCIM_WEBHOOK_VERIFIER required for local dev');
    }
    return createMockHelcimClient({
      webhookUrl: `${env.API_URL}${WEBHOOK_PAYMENT_PATH}`,
      webhookVerifier: env.HELCIM_WEBHOOK_VERIFIER,
    });
  }

  if (!env.HELCIM_API_TOKEN || !env.HELCIM_WEBHOOK_VERIFIER) {
    throw new Error('HELCIM_API_TOKEN and HELCIM_WEBHOOK_VERIFIER required in CI/production');
  }

  return createHelcimClient({
    apiToken: env.HELCIM_API_TOKEN,
    webhookVerifier: env.HELCIM_WEBHOOK_VERIFIER,
    ...(evidence !== undefined && { evidence }),
  });
}
