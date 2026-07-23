import { useEffect } from 'react';
import { useAppVersionStore } from '@/stores/app-version.js';
import { checkForUpdate } from '../live-update.js';
import { useAppLifecycle } from './use-app-lifecycle.js';
import { isNative } from '../platform.js';

async function checkForOptionalUpdate(): Promise<void> {
  // Optional (non-forced) OTA check: when a bundle is available, surface the
  // blocking upgrade-required modal and wait for the user to tap Update. The
  // bundle is never applied here — auto-applying reloaded the app out from
  // under the user with no consent.
  const result = await checkForUpdate();
  if (result.updateAvailable) {
    useAppVersionStore.getState().setUpgradeRequired(true);
  }
}

/**
 * On startup (mount) and on resume from background, checks for an OTA update
 * and, if one is available, surfaces the blocking upgrade-required modal so the
 * user can choose to apply it. No-op on web.
 */
export function useLiveUpdate(): void {
  useEffect(() => {
    if (!isNative()) return;
    void checkForOptionalUpdate();
  }, []);

  useAppLifecycle({
    onResume: () => {
      if (!isNative()) return;
      void checkForOptionalUpdate();
    },
  });
}
