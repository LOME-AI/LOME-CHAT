import { createEnvUtilities } from '@hushbox/shared';

/**
 * Frontend environment utilities — initialized once with Vite's env, same
 * pattern as apps/web/src/lib/env.ts. `env.isLocalDev` gates the dev-auth
 * fetch wrapper and the actor switcher.
 */
const viteCI = import.meta.env['VITE_CI'] as string | undefined;
const viteE2E = import.meta.env['VITE_E2E'] as string | undefined;

export const env = createEnvUtilities({
  NODE_ENV: import.meta.env.MODE,
  ...(viteCI ? { CI: viteCI } : {}),
  ...(viteE2E ? { E2E: viteE2E } : {}),
});
