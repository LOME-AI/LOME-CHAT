import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import { createConsolePushClient } from './console.js';
import { createFcmPushClient } from './fcm.js';
import type { PushClient } from './types.js';

interface PushEnv extends EnvContext {
  FCM_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
}

/**
 * Get the appropriate push notification client based on environment.
 *
 * - Local dev: Returns console client (logs to terminal)
 * - CI: Returns console client (no real push sending in tests)
 * - Production: Requires FCM credentials, fails fast if missing
 */
export function getPushClient(env: PushEnv): PushClient {
  const { isLocalDev, isCI } = createEnvUtilities(env);

  if (isLocalDev || isCI) {
    return createConsolePushClient();
  }

  if (!env.FCM_PROJECT_ID || !env.FCM_SERVICE_ACCOUNT_JSON) {
    throw new Error('FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON required in production');
  }

  return createFcmPushClient(env.FCM_PROJECT_ID, env.FCM_SERVICE_ACCOUNT_JSON);
}
