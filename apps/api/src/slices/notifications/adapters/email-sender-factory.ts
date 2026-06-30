import { createEnvUtilities } from '@hushbox/shared';
import { createMockEmailSender } from './email-mock.js';
import { createResendEmailSender } from './email-resend.js';
import type { EnvContext } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { EmailSender } from '../ports/index.js';

interface EmailSenderEnv extends EnvContext {
  RESEND_API_KEY?: string;
}

/**
 * envUtils-gated sender selection: local dev and CI get the in-process mock
 * (no real email leaves either mode — CI's evidence path is exercised by the
 * adapter's own integration test until Phase 4 re-points real-API jobs),
 * production gets the real Resend adapter. Missing config fails fast — there
 * is no degraded mode.
 */
export function createEmailSenderFromEnv(env: EmailSenderEnv, db: Database): EmailSender {
  // Fail-fast on missing config, not an environment branch: createEnvUtilities
  // defaults a missing NODE_ENV to development, so a production deploy that
  // omitted it would silently select the mock and drop every email.
  if (env.NODE_ENV === undefined) {
    throw new Error('NODE_ENV must be set explicitly to select an email sender');
  }

  const { isLocalDev, isCI } = createEnvUtilities(env);

  if (isLocalDev || isCI) {
    return createMockEmailSender();
  }

  if (env.RESEND_API_KEY === undefined) {
    throw new Error('RESEND_API_KEY is required outside local dev and CI');
  }

  return createResendEmailSender({ apiKey: env.RESEND_API_KEY, db, isCI });
}
