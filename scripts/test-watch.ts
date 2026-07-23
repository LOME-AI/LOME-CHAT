import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import { NODE_OPTION_FLAG, appendNodeOption, loadEnvironment } from './with-env.js';

/**
 * Package-aware `pnpm test:watch`. A root invocation naming a package's test
 * file must run vitest FROM that package directory — vitest only loads the
 * owning package's config (aliases like apps/web's `@/`) for an in-package
 * invocation, so running from the repo root fails alias resolution.
 */

export interface WatchFs {
  readonly isFile: (p: string) => boolean;
  readonly isDirectory: (p: string) => boolean;
  readonly hasPackageJson: (dir: string) => boolean;
}

export interface Invocation {
  readonly cwd: string;
  readonly args: readonly string[];
}

/** Nearest ancestor of `targetPath` (inclusive for directories) with a package.json, up to `rootDir`. */
export function findOwningPackageDir(targetPath: string, rootDir: string, fs: WatchFs): string {
  let dir = fs.isDirectory(targetPath) ? targetPath : path.dirname(targetPath);
  for (;;) {
    if (fs.hasPackageJson(dir)) {
      return dir;
    }
    if (dir === rootDir || path.dirname(dir) === dir) {
      throw new Error(`test:watch: no package.json found from ${targetPath} up to ${rootDir}`);
    }
    dir = path.dirname(dir);
  }
}

/**
 * Split argv into existing paths (rewritten absolute, driving package
 * detection) and passthrough args (flags, vitest name filters). One owning
 * package → run from it; none → the invocation directory (watch-all and
 * name-filter behavior unchanged); several → error.
 */
export function planInvocation(
  args: readonly string[],
  invocationDir: string,
  fs: WatchFs
): Invocation {
  const rewritten: string[] = [];
  const packageDirectories = new Set<string>();
  for (const argument of args) {
    const resolved = path.resolve(invocationDir, argument);
    if (argument.startsWith('-') || (!fs.isFile(resolved) && !fs.isDirectory(resolved))) {
      rewritten.push(argument);
      continue;
    }
    const owner = findOwningPackageDir(resolved, invocationDir, fs);
    if (owner !== invocationDir) {
      packageDirectories.add(owner);
    }
    rewritten.push(resolved);
  }
  if (packageDirectories.size > 1) {
    const names = [...packageDirectories].map((d) => path.relative(invocationDir, d)).join(', ');
    throw new Error(
      `test:watch: files span multiple packages (${names}); run one package at a time`
    );
  }
  const [packageDir] = packageDirectories;
  return { cwd: packageDir ?? invocationDir, args: rewritten };
}

/** Spawn vitest in the planned cwd; `preferLocal` picks the package's own binary. */
export async function runVitest(invocation: Invocation): Promise<number> {
  const result = await execa('vitest', [...invocation.args], {
    stdio: 'inherit',
    reject: false,
    preferLocal: true,
    localDir: invocation.cwd,
    cwd: invocation.cwd,
  });
  return typeof result.exitCode === 'number' ? result.exitCode : 1;
}

/* v8 ignore start -- CLI entry point exercised via package.json scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(scriptDir, '..');
    loadEnvironment(rootDir);
    process.env['NODE_OPTIONS'] = appendNodeOption(process.env['NODE_OPTIONS'], NODE_OPTION_FLAG);

    const fs: WatchFs = {
      isFile: (p) => existsSync(p) && statSync(p).isFile(),
      isDirectory: (p) => existsSync(p) && statSync(p).isDirectory(),
      hasPackageJson: (dir) => existsSync(path.join(dir, 'package.json')),
    };
    return runVitest(planInvocation(process.argv.slice(2), process.cwd(), fs));
  });
}
/* v8 ignore stop */
