/**
 * Environment context for detecting dev/prod/CI status.
 */
export interface EnvContext {
  NODE_ENV?: string;
  CI?: string;
  E2E?: string;
  /**
   * Set to `'true'` when running under the Vitest runner. Vitest exposes this
   * as `process.env.VITEST` (Node) / `import.meta.env.VITEST` (browser); the
   * caller that builds this context forwards it. Distinguishes a local vitest
   * run from the local dev server — both of which are otherwise `NODE_ENV=
   * development` with no CI/E2E — so `isDevServer` can stay honest.
   */
  VITEST?: string;
}

/**
 * Create environment utilities from runtime env vars.
 * This is THE source of truth for all dev/prod/CI detection.
 *
 * @example Backend (Hono)
 * ```typescript
 * const env = createEnvUtilities(c.env);
 * if (env.isLocalDev) { return createMockClient(); }
 * ```
 *
 * @example Frontend (Vite) - initialize once
 * ```typescript
 * export const env = createEnvUtilities({
 *   NODE_ENV: import.meta.env.MODE,
 *   CI: import.meta.env.VITE_CI,
 * });
 * ```
 */
export function createEnvUtilities(env: EnvContext): EnvUtilities {
  // Fail fast: a fallback here would silently classify a misconfigured
  // production isolate as local dev (mock clients).
  if (env.NODE_ENV === undefined) {
    throw new Error('NODE_ENV is not set: createEnvUtilities requires an explicit NODE_ENV');
  }
  const nodeEnv = env.NODE_ENV;
  const isCI = Boolean(env.CI);
  const isE2E = Boolean(env.E2E);
  // Vitest sets `VITEST='true'` in its process. The backend stays on
  // `NODE_ENV=development` under vitest (via .dev.vars), so without this signal
  // a local vitest run is indistinguishable from the dev server. Kept private —
  // its only purpose is to make `isDevServer` honest (no direct consumers).
  const isVitest = Boolean(env.VITEST);
  const isDevMode = nodeEnv === 'development';
  const isLocalDev = isDevMode && !isCI;

  return {
    isDev: isDevMode,
    isLocalDev,
    // A real interactive dev server with no automated test harness attached —
    // the only place human-facing dev affordances (visible mock streaming, the
    // media-generation placeholder delay) should fire. A strict subset of
    // `isLocalDev`, which also covers local vitest and local E2E.
    isDevServer: isLocalDev && !isE2E && !isVitest,
    isProduction: nodeEnv === 'production',
    isCI,
    isE2E,
    requiresRealServices: nodeEnv === 'production' || isCI,
  };
}

/**
 * Environment utilities returned by createEnvUtilities.
 */
export interface EnvUtilities {
  /** Development mode (local OR CI in dev mode) - for UI visibility */
  isDev: boolean;
  /** Local development only (not CI, not production) - for using mocks */
  isLocalDev: boolean;
  /**
   * A real interactive dev server — local dev mode, but NOT under vitest or
   * E2E. Strict subset of `isLocalDev`. Use this (not `isLocalDev`) to gate
   * human-facing dev affordances like visible mock-stream timing.
   */
  isDevServer: boolean;
  /** Production mode */
  isProduction: boolean;
  /** Running in CI */
  isCI: boolean;
  /** Running E2E tests (in CI) - uses mocks for some services like the AI Gateway */
  isE2E: boolean;
  /** CI or production - require real credentials */
  requiresRealServices: boolean;
}
