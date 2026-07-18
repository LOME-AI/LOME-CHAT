import type { EnvUtilities } from '@hushbox/shared';

/**
 * Record on miss, replay on hit — the legacy policy. The first uncached call in
 * CI is a real recorded call; identical calls thereafter replay from the Actions
 * cache (CI restores/saves `.ai-cassettes`), so a warm cache means zero real
 * calls without ever failing on a cold one. Consulted only on the CI-vitest real
 * provider path; production uses plain fetch and dev/E2E the mock provider, so no
 * other mode is needed here.
 */
export type CassetteMode = 'record' | 'replay-only';

export function cassetteModeFor(_env: EnvUtilities): CassetteMode {
  return 'record';
}
