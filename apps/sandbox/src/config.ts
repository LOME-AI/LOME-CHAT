/**
 * Runtime configuration handed to the renderer pages served by this origin.
 *
 * The document renderer must know the module-CDN base URL to resolve a
 * document's bare imports, and that base is environment-driven (never
 * hard-coded): production
 * and dev-default point at esm.sh, while test modes point at a local static stub
 * on this same origin (env registry `ESM_CDN_URL`). Both the local
 * dev server and the production build emit the identical `/config.js` from this
 * single function, so the pages read one shape everywhere. The renderer pages
 * (owned downstream) consume `globalThis[SANDBOX_CONFIG_GLOBAL]`.
 */

/** The global the emitted script assigns; the seam the renderer pages read. */
export const SANDBOX_CONFIG_GLOBAL = '__SANDBOX_CONFIG__';

/** The subset of the process environment this module reads. */
export interface SandboxConfigEnv {
  readonly ESM_CDN_URL?: string | undefined;
}

/** The resolved config shape assigned to the page global. */
export interface SandboxConfig {
  readonly esmCdnUrl: string;
}

/**
 * Serialize a value as a `<script>`-safe JSON literal: `<` is escaped so the
 * emitted text can never contain a `</script>` sequence, keeping it safe whether
 * a page loads `/config.js` externally or inlines it.
 */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', String.raw`\u003c`);
}

/**
 * Build the `/config.js` source that publishes the resolved config to the page
 * global. Fails fast when `ESM_CDN_URL` is absent or empty — a missing base URL
 * is a deploy misconfiguration, never a silently-defaulted value.
 */
export function buildSandboxConfigScript(env: SandboxConfigEnv): string {
  const esmCdnUrl = env.ESM_CDN_URL;
  if (esmCdnUrl === undefined || esmCdnUrl === '') {
    throw new Error(
      'ESM_CDN_URL is not set — run `pnpm generate:env` (production/dev-default = esm.sh, test modes = local stub).'
    );
  }
  const config: SandboxConfig = { esmCdnUrl };
  return `globalThis[${scriptSafeJson(SANDBOX_CONFIG_GLOBAL)}] = ${scriptSafeJson(config)};`;
}
