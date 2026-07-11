import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { getApiUrl } from '@/lib/api.js';
import { client, fetchJson } from '@/lib/api-client.js';
import { useAppVersionStore } from '@/stores/app-version.js';
import { isNative, getPlatform } from './platform.js';

interface CheckResult {
  updateAvailable: boolean;
  serverVersion?: string;
}

/** Returns the current app version — bundle version on native, "web" on browser. */
export async function getAppVersion(): Promise<string> {
  if (!isNative()) {
    return 'web';
  }

  const { bundle, native } = await CapacitorUpdater.current();
  const version = bundle.version;

  // "builtin" or empty means no OTA bundle applied — use native shell version
  if (!version || version === 'builtin') {
    return native;
  }

  return version;
}

/** Fetches the current server version. Returns null on failure. */
export async function getServerVersion(): Promise<string | null> {
  try {
    const data = await fetchJson<{ version: string }>(client.updates.current.$get());
    return data.version;
  } catch (error: unknown) {
    console.error('Failed to fetch server version:', error);
    return null;
  }
}

/**
 * Downloads and applies an OTA update. On success, the JS context is destroyed
 * and the app reloads with the new bundle. On failure, sets the upgrade-required
 * flag so the user sees the modal.
 */
export async function applyUpdate(version: string): Promise<void> {
  if (!isNative()) {
    return;
  }

  try {
    const platform = getPlatform();
    // A 426 VERSION_MISMATCH stashes the server-supplied (relative) download
    // path; prefer it over the hand-built URL so the server stays the single
    // source of the OTA route. Fall back when no 426 populated the store.
    const serverUpdatePath = useAppVersionStore.getState().updateUrl;
    const url =
      serverUpdatePath === null
        ? `${getApiUrl()}/updates/download/${platform}/${version}`
        : `${getApiUrl()}${serverUpdatePath}`;
    const bundle = await CapacitorUpdater.download({
      url,
      version,
    });

    // set() destroys JS context — no code runs after this
    await CapacitorUpdater.set({ id: bundle.id });
  } catch (error: unknown) {
    console.error('Failed to apply OTA update:', error);
    // Download or apply failed — show upgrade modal as fallback
    useAppVersionStore.getState().setUpgradeRequired(true);
  }
}

/**
 * Checks whether an OTA update is available. Calls `notifyAppReady()` to
 * confirm the current bundle is healthy (prevents Capgo auto-rollback).
 * Returns whether an update is available and the target version.
 */
export async function checkForUpdate(): Promise<CheckResult> {
  if (!isNative()) {
    return { updateAvailable: false };
  }

  // Notify Capgo that the current bundle booted successfully
  await CapacitorUpdater.notifyAppReady();

  const [appVersion, serverVersion] = await Promise.all([getAppVersion(), getServerVersion()]);

  // Can't check if server unreachable
  if (!serverVersion) {
    return { updateAvailable: false };
  }

  // Skip comparison in dev
  if (serverVersion === 'dev-local') {
    return { updateAvailable: false };
  }

  if (appVersion !== serverVersion) {
    return { updateAvailable: true, serverVersion };
  }

  return { updateAvailable: false };
}
