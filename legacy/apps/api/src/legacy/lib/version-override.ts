/**
 * Module-level version override for local development.
 *
 * In Wrangler dev mode, the process is long-lived so a module variable
 * persists across requests. In production Workers, this resets on every
 * cold start — but the `POST /api/dev/set-version` endpoint is dev-only
 * so the override is never set in production.
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
