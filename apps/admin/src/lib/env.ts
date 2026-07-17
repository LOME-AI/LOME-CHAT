import { createEnvUtilities } from '@hushbox/shared';
import type { EnvUtilities } from '@hushbox/shared';

/**
 * Frontend environment utilities — initialized once with Vite's env, same
 * pattern as apps/web/src/lib/env.ts. `isDevAuthEnabled` gates the dev-auth
 * fetch wrapper and the actor switcher.
 */
const viteCI = import.meta.env['VITE_CI'] as string | undefined;
const viteE2E = import.meta.env['VITE_E2E'] as string | undefined;

export const env = createEnvUtilities({
  NODE_ENV: import.meta.env.MODE,
  ...(viteCI ? { CI: viteCI } : {}),
  ...(viteE2E ? { E2E: viteE2E } : {}),
});

/**
 * Whether the admin dev-auth path (dev-JWT fetch wrapper + actor switcher) is
 * enabled: local dev, or E2E runs (local and CI — `Mode.CiE2E` bakes
 * `VITE_E2E`, which makes `isLocalDev` false via `CI`). The `!isProduction`
 * term is a defense-in-depth pin: a production build (`vite build`, MODE
 * 'production') never enables dev auth even if an E2E/CI flag were ever baked
 * into it. Server-side the mint route is dev-only-classed (404 in production)
 * and the dev signing key does not exist there, so this gate is the client
 * half of a two-sided guarantee.
 */
export function computeDevAuthEnabled(
  utilities: Pick<EnvUtilities, 'isLocalDev' | 'isE2E' | 'isProduction'>
): boolean {
  return (utilities.isLocalDev || utilities.isE2E) && !utilities.isProduction;
}

export function isDevAuthEnabled(): boolean {
  return computeDevAuthEnabled(env);
}
