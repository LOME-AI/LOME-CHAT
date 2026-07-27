#!/usr/bin/env tsx
/**
 * The single web-bundle build path: build web + marketing, merge marketing's
 * output on top of web's, then generate the CSP `_headers`. Shared by every
 * caller so the sequence lives in one place:
 *   - `playwright.config.ts` (E2E preview server) and CI's `e2e-build` job, via
 *     `--target=e2e` (dev-mode build, loads `.env.development`)
 *   - the production build/deploy paths, via `--target=prod`
 *
 * Self-contained: regenerates the env files for its target mode before building,
 * so the bundle always bakes the right `VITE_*` values (e2e bakes `VITE_E2E`,
 * localhost API, sandbox tokens). The "e2e-ness" is the env mode, not the
 * bundler flag — `--mode development` is only the `.env.development` file
 * selector plus minify-off (see `apps/web/vite.config.ts`).
 *
 * Turbo orchestrates the two app builds: it runs them in parallel and restores
 * `dist/**` from cache when inputs are unchanged. Cache correctness holds across
 * dev/prod (passthrough args are hashed) and across workspace-package source
 * edits (folded into the dependent app's hash); `.env*` is a build input, so a
 * regenerated env with different values busts the cache rather than serving a
 * stale bundle.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { Mode, createEnvUtilities } from '@hushbox/shared';
import { generateEnvFiles } from './generate-env.js';
import { mergeMarketingIntoWeb } from './merge-marketing-into-web.js';
import { appBundleOptions, verifyWebBundle } from './verify-web-bundle.js';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import type { VerifyBundle } from './verify-web-bundle.js';

export type BuildTarget = 'e2e' | 'prod';

type EnvContext = Parameters<typeof createEnvUtilities>[0];

export function parseTarget(args: readonly string[]): BuildTarget {
  const value = args.find((argument) => argument.startsWith('--target='))?.split('=')[1];
  if (value === 'e2e' || value === 'prod') return value;
  throw new Error(`build-web-bundle requires --target=e2e|prod (got: ${value ?? 'none'})`);
}

/**
 * The e2e env mode, split on CI: CI adds the Helcim sandbox secrets the test env
 * expects (`CiE2E` extends `E2E`). Uses the shared `envUtils` detector — never a
 * direct `process.env.CI` check. Prod has no analogue: its `VITE_*` arrive inline
 * from the caller (CI build env), so nothing is generated.
 */
export function selectE2eEnvMode(env: EnvContext): Mode {
  return createEnvUtilities(env).isCI ? Mode.CiE2E : Mode.E2E;
}

export interface BuildWebBundleDeps {
  readonly generateEnv: (rootDir: string, mode: Mode, options?: { skipBackend?: boolean }) => void;
  readonly exec: (file: string, args: readonly string[]) => Promise<unknown>;
  readonly merge: (options: { repoRoot: string }) => Promise<unknown>;
  readonly verify: VerifyBundle;
}

export async function buildWebBundle(
  target: BuildTarget,
  rootDir: string,
  env: EnvContext,
  deps: BuildWebBundleDeps
): Promise<void> {
  // e2e self-generates its env files (VITE_E2E, localhost, sandbox tokens). prod
  // takes its VITE_* inline from the caller, exactly like the existing prod build
  // — there is nothing to generate, and Mode.Production targets wrangler.toml, not
  // this web bundle.
  if (target === 'e2e') {
    // Frontend-only: the build reads .env.development; skipping the backend env
    // means the server secrets are never required by this build.
    deps.generateEnv(rootDir, selectE2eEnvMode(env), { skipBackend: true });
  }

  // `^build` is free here (workspace packages have no build script); the filter
  // keeps a future buildable app out of the web bundle. Passthrough `--mode
  // development` reaches both `vite build` and `astro build`.
  const turboArgs = ['build', '--filter=@hushbox/web', '--filter=@hushbox/marketing'];
  if (target === 'e2e') turboArgs.push('--', '--mode', 'development');
  await deps.exec('turbo', turboArgs);

  await deps.merge({ repoRoot: rootDir });

  // After the merge, because the merged dist is what actually deploys: a stray
  // ORT copy or a Pages-limit breach only exists once marketing's output has
  // landed on top of web's. Every caller — prod, e2e, preview — comes through
  // here, so this is the single gate.
  await deps.verify(appBundleOptions(rootDir, 'apps/web'));

  // e2e re-runs under with-env so the freshly generated VITE_API_URL / minio port
  // reach the CSP generator; prod reads them from the inline build env directly,
  // matching the existing prod build's invocation.
  await (target === 'e2e'
    ? deps.exec('tsx', ['scripts/with-env.ts', 'tsx', 'scripts/generate-headers.ts'])
    : deps.exec('tsx', ['scripts/generate-headers.ts']));
}

/* v8 ignore start -- CLI entry point exercised via the build:* package scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDir, '..');
    const target = parseTarget(process.argv.slice(2));
    await buildWebBundle(target, repoRoot, process.env, {
      generateEnv: generateEnvFiles,
      exec: (file, args) => execa(file, [...args], { stdio: 'inherit', cwd: repoRoot }),
      merge: mergeMarketingIntoWeb,
      verify: verifyWebBundle,
    });
  });
}
/* v8 ignore stop */
