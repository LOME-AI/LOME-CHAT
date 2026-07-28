#!/usr/bin/env tsx
/**
 * The e2e web-bundle build sequence: build web + marketing, merge marketing's
 * output on top of web's, then generate the CSP `_headers`. Two callers, both
 * via `pnpm build:e2e`: `playwright.config.ts`'s preview server and CI's
 * `e2e-build` job. It builds no other kind of bundle.
 *
 * Self-contained: regenerates the env files before building, so the bundle
 * always bakes the right `VITE_*` values (`VITE_E2E`, localhost API, sandbox
 * tokens). The "e2e-ness" is the env mode, not the bundler flag — `--mode
 * development` is only the `.env.development` file selector plus minify-off
 * (see `apps/web/vite.config.ts`).
 *
 * Turbo orchestrates the two app builds: it runs them in parallel and restores
 * `dist/**` from cache when inputs are unchanged. Cache correctness holds across
 * differing passthrough args (they are hashed) and across workspace-package
 * source edits (folded into the dependent app's hash); `.env*` is a build input,
 * so a regenerated env with different values busts the cache rather than serving
 * a stale bundle.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { Mode, createEnvUtilities } from '@hushbox/shared';
import { generateEnvFiles } from './generate-env.js';
import { mergeMarketingIntoWeb } from './merge-marketing-into-web.js';
import { appBundleOptions, verifyBundle } from './verify-bundle.js';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import type { VerifyBundle } from './verify-bundle.js';

export type BuildTarget = 'e2e';

type EnvContext = Parameters<typeof createEnvUtilities>[0];

/**
 * Validates `--target` rather than dispatching on it: `e2e` is the only bundle
 * this script builds, so any other value has to fail loudly instead of silently
 * yielding an e2e bundle to a caller that asked for something else.
 */
export function assertE2eTarget(args: readonly string[]): BuildTarget {
  const value = args.find((argument) => argument.startsWith('--target='))?.split('=')[1];
  if (value === 'e2e') return value;
  throw new Error(`build-web-bundle requires --target=e2e (got: ${value ?? 'none'})`);
}

/**
 * The e2e env mode, split on CI: CI adds the Helcim sandbox secrets the test env
 * expects (`CiE2E` extends `E2E`). Uses the shared `envUtils` detector — never a
 * direct `process.env.CI` check.
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
  rootDir: string,
  env: EnvContext,
  deps: BuildWebBundleDeps
): Promise<void> {
  // Frontend-only: the build reads .env.development; skipping the backend env
  // means the server secrets are never required by this build.
  deps.generateEnv(rootDir, selectE2eEnvMode(env), { skipBackend: true });

  // `^build` is free here (workspace packages have no build script); the filter
  // keeps a future buildable app out of the web bundle. Passthrough `--mode
  // development` reaches both `vite build` and `astro build`.
  await deps.exec('turbo', [
    'build',
    '--filter=@hushbox/web',
    '--filter=@hushbox/marketing',
    '--',
    '--mode',
    'development',
  ]);

  await deps.merge({ repoRoot: rootDir });

  // After the merge, because the defects it catches only exist once marketing's
  // output has landed on top of web's: a stray ORT copy, or a file count past
  // the Pages limit.
  await deps.verify(appBundleOptions(rootDir, 'apps/web'));

  // Under with-env so the freshly generated VITE_API_URL / minio port reach the
  // CSP generator.
  await deps.exec('tsx', ['scripts/with-env.ts', 'tsx', 'scripts/generate-headers.ts']);
}

/* v8 ignore start -- CLI entry point exercised via the build:e2e package script */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDir, '..');
    assertE2eTarget(process.argv.slice(2));
    await buildWebBundle(repoRoot, process.env, {
      generateEnv: generateEnvFiles,
      exec: (file, args) => execa(file, [...args], { stdio: 'inherit', cwd: repoRoot }),
      merge: mergeMarketingIntoWeb,
      verify: verifyBundle,
    });
  });
}
/* v8 ignore stop */
