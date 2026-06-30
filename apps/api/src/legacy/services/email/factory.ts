import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import { createConsoleEmailClient } from './console.js';
import { createResendEmailClient } from './resend.js';
import type { EmailClient } from './types.js';

interface EmailEnv extends EnvContext {
  RESEND_API_KEY?: string;
}

/**
 * Get the appropriate email client based on environment.
 *
 * - Local dev: Returns console client (dev UX - shows verification links)
 * - CI: Returns console client (no real email sending in tests)
 * - Production: Requires real Resend credentials, fails fast if missing
 */
export function getEmailClient(env: EmailEnv): EmailClient {
  const { isLocalDev, isCI } = createEnvUtilities(env);

  if (isLocalDev || isCI) {
    return createConsoleEmailClient();
  }

  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY required in production');
  }

  return createResendEmailClient(env.RESEND_API_KEY);
}
