/**
 * Module-level server-version override for dev/E2E version-gate testing.
 *
 * This looks like a no-in-memory-state violation but is deliberate dev-only
 * test tooling: the only setter is reached through `POST /dev/set-version`,
 * a `dev-only`-class route that answers 404 in production, so production
 * state is always null and the override can never influence a production
 * request. In Wrangler dev the process is long-lived, so the variable
 * persists across requests — exactly what the E2E version-gate specs drive.
 *
 * Lives in `middleware/` (not `platform/`) because `version-check.ts` reads
 * it and the boundaries lint allows middleware to import only lib, middleware
 * and slice barrels — a platform-side module would be an unknown local.
 */
let versionOverride: string | null = null;

export function getVersionOverride(): string | null {
  return versionOverride;
}

export function setVersionOverride(version: string): void {
  versionOverride = version;
}

export function clearVersionOverride(): void {
  versionOverride = null;
}
