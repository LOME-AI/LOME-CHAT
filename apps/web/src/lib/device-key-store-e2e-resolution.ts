// Build-time selection of the device-key-store implementation variant.
//
// E2E builds must swap `device-key-store.ts` (IndexedDB, non-extractable
// device key) for `device-key-store.e2e.ts` (localStorage, so Playwright
// `storageState` can capture the key across contexts). The swap happens at
// module-resolution time inside the Vite build — never via a runtime
// `env.isE2E`-gated dynamic `import()`: a runtime import() is a cancellable
// chunk fetch, and on the auth-bootstrap path (every route, guests included)
// a racing navigation aborts that fetch, the import() rejects uncaught, and
// the router's CatchBoundary blanks the page. The arch rule
// `e2e-store-isolation` forbids every source-level reference to `*.e2e`
// modules; this resolver — installed by the apps/web Vite config only when the
// build bakes `VITE_E2E` — is the single sanctioned path, so production builds
// contain zero e2e-variant code by construction.

/** Module specifiers resolving to the production device-key store:
 * `./device-key-store`, `@/lib/device-key-store`, optional `.js`/`.ts`. */
const DEVICE_KEY_STORE_SPECIFIER = /(^|\/)device-key-store(\.[jt]s)?$/;

/**
 * Vite `resolveId` body for the E2E build: remaps any specifier targeting the
 * production device-key store to the e2e variant module. Returns null (no
 * opinion — normal resolution proceeds) for everything else, including the
 * e2e module's own imports, so its type-only reference back to the production
 * module can never loop onto itself.
 */
export function resolveDeviceKeyStoreE2eVariant(
  source: string,
  importer: string | undefined,
  e2eModulePath: string
): string | null {
  if (!DEVICE_KEY_STORE_SPECIFIER.test(source)) return null;
  if (importer?.includes('device-key-store.e2e')) return null;
  return e2eModulePath;
}
