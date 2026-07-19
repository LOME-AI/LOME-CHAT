import { createEnvUtilities } from '@hushbox/shared';
import { createMockPushSender } from './push-mock.js';
import { createFcmPushSender } from './push-fcm.js';
import type { EnvContext } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { PushSender } from '../ports/index.js';

interface PushSenderEnv extends EnvContext {
  FCM_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
}

/**
 * envUtils-gated sender selection: local dev and CI get the in-process mock
 * (no real push leaves either mode), production gets the real FCM adapter.
 * Missing config fails fast — there is no degraded mode.
 */
export function createPushSenderFromEnv(env: PushSenderEnv, db: Database): PushSender {
  // Explicit fail-fast at the selection seam: createEnvUtilities throws on an
  // absent NODE_ENV, and this guard restates that with a sender-specific message
  // so a production deploy that omitted it fails loudly instead of ever risking
  // the mock (which drops every notification).
  if (env.NODE_ENV === undefined) {
    throw new Error('NODE_ENV must be set explicitly to select a push sender');
  }

  const { isLocalDev, isCI } = createEnvUtilities(env);

  if (isLocalDev || isCI) {
    return createMockPushSender();
  }

  if (env.FCM_PROJECT_ID === undefined || env.FCM_SERVICE_ACCOUNT_JSON === undefined) {
    throw new Error(
      'FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON are required outside local dev and CI'
    );
  }

  return createFcmPushSender({
    projectId: env.FCM_PROJECT_ID,
    serviceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON,
    db,
    isCI,
  });
}
