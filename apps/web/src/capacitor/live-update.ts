import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { getApiUrl } from '@/lib/api.js';
import { client, fetchJson } from '@/lib/api-client.js';
import { useAppVersionStore } from '@/stores/app-version.js';
import { isNative, getPlatform } from './platform.js';

interface CheckResult {
  updateAvailable: boolean;
  serverVersion?: string;
}

/** `/updates/current` body: the served version plus the bundle's sha256. */
interface ServerUpdate {
  version: string;
  checksum?: string;
}

/**
 * Fetches `/updates/current` ({ version, checksum? }). Returns null on failure —
 * the caller degrades to "no update" / an unverified download rather than throw.
 */
async function fetchServerUpdate(): Promise<ServerUpdate | null> {
  try {
    return await fetchJson<ServerUpdate>(client.updates.current.$get());
  } catch (error: unknown) {
    console.error('Failed to fetch server version:', error);
    return null;
  }
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
  const update = await fetchServerUpdate();
  return update?.version ?? null;
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
    // The server-published sha256 lets Capgo verify the downloaded bytes and
    // reject a tampered/corrupt bundle before it is ever applied. Absent (older
    // deploy, or the fetch failed) ⇒ download without integrity check, unchanged
    // from the pre-checksum behavior.
    const server = await fetchServerUpdate();
    const checksum = server?.checksum;
    const bundle = await CapacitorUpdater.download(
      checksum === undefined ? { url, version } : { url, version, checksum }
    );

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

  // Any divergence — including a server version *lower* than the installed
  // bundle — is treated as an update to apply. There is deliberately no
  // downgrade guard: a lower APP_VERSION is an intentional rollback lever
  // (ship the previous bundle to recall a bad release), and honoring it is an
  // accepted, ruled behavior, not an oversight.
  if (appVersion !== serverVersion) {
    return { updateAvailable: true, serverVersion };
  }

  return { updateAvailable: false };
}
