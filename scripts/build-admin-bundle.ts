#!/usr/bin/env tsx
/**
 * The single admin-bundle build path for E2E: regenerate the env files for the
 * e2e mode, then build the admin SPA. Consumed by CI's admin e2e build and by
 * `playwright.config.ts`'s preview server (both via `pnpm build:e2e:admin`).
 *
 * This mirrors the web bundle's env method exactly — the "e2e-ness" is the env
 * mode, not a bundler flag. `generateEnvFiles(..., Mode.E2E|CiE2E)` bakes
 * `VITE_E2E` (localhost API, sandbox tokens) and `--mode development` selects
 * `.env.development` plus minify-off (see `apps/admin/vite.config.ts`), so the
 * static build keeps the dev-JWT self-auth path (`computeDevAuthEnabled`).
 *
 * It reuses `selectE2eEnvMode` and `generateEnvFiles` verbatim from the web
 * path — the only admin-specific bits are the turbo filter (`@hushbox/admin`)
 * and the absence of the marketing merge: admin is a standalone SPA on its own
 * origin with no marketing content. Admin's own security headers (CSP +
 * `X-Frame-Options` + HSTS) are emitted by the admin Vite build's `_headers`
 * plugin (`apps/admin/vite.config.ts`), not assembled here.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { generateEnvFiles } from './generate-env.js';
import { selectE2eEnvMode } from './build-web-bundle.js';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import type { Mode, createEnvUtilities } from '@hushbox/shared';

type EnvContext = Parameters<typeof createEnvUtilities>[0];

export interface BuildAdminBundleDeps {
  readonly generateEnv: (rootDir: string, mode: Mode, options?: { skipBackend?: boolean }) => void;
  readonly exec: (file: string, args: readonly string[]) => Promise<unknown>;
}

export async function buildAdminBundle(
  rootDir: string,
  env: EnvContext,
  deps: BuildAdminBundleDeps
): Promise<void> {
  // Frontend-only: the build reads .env.development; skipping the backend env
  // means the server secrets are never required by this build.
  deps.generateEnv(rootDir, selectE2eEnvMode(env), { skipBackend: true });

  // Passthrough `--mode development` reaches `vite build`. No marketing merge here;
  // admin's CSP `_headers` are emitted by the admin Vite build's own plugin.
  await deps.exec('turbo', ['build', '--filter=@hushbox/admin', '--', '--mode', 'development']);
}

/* v8 ignore start -- CLI entry point exercised via the build:* package scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDir, '..');
    await buildAdminBundle(repoRoot, process.env, {
      generateEnv: generateEnvFiles,
      exec: (file, args) => execa(file, [...args], { stdio: 'inherit', cwd: repoRoot }),
    });
  });
}
/* v8 ignore stop */
