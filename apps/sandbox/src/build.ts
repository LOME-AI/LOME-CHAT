import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSandboxConfigScript } from './config.js';

/**
 * Assemble the sandbox origin's deploy directory (`./dist`), which the
 * production Cloudflare assets Worker serves (wrangler.toml `[assets]`). The
 * static pages and the self-hosted Pyodide assets are copied from `public/`
 * verbatim, then the env-derived `/config.js` is written on top. Pyodide bytes
 * must already be present under `public/pyodide/` (run `fetch-pyodide` first);
 * this step does not fetch.
 */

export interface BuildSandboxOptions {
  /** Absolute source directory (the committed static pages + fetched assets). */
  readonly publicDir: string;
  /** Absolute deploy directory to (re)assemble. */
  readonly distDir: string;
  /** The `/config.js` body (from buildSandboxConfigScript). */
  readonly configScript: string;
}

/** (Re)assemble `distDir` from `publicDir` plus the generated `config.js`. */
export function buildSandbox(options: BuildSandboxOptions): void {
  rmSync(options.distDir, { recursive: true, force: true });
  mkdirSync(options.distDir, { recursive: true });
  cpSync(options.publicDir, options.distDir, { recursive: true });
  writeFileSync(path.join(options.distDir, 'config.js'), options.configScript);
}

/* v8 ignore start -- CLI entry, exercised via the `build` package script */
function main(): void {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  buildSandbox({
    publicDir: path.join(packageRoot, 'public'),
    distDir: path.join(packageRoot, 'dist'),
    configScript: buildSandboxConfigScript(process.env),
  });
  console.log('✓ sandbox dist assembled');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
/* v8 ignore stop */
