import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(stylesDir, '../../../../../../');

const SOURCE_ROOTS = ['apps', 'packages'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.astro', '.css']);
// Derived-output directory names, mirroring the root .gitignore's build-output
// entries. The guard polices authored source only; generated bundles are
// derived from source the scan already covers.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-ota',
  'build',
  'out',
  '.next',
  '.vercel',
  '.wrangler',
  '.astro',
  '.turbo',
  '.tanstack',
  '.gradle',
  'coverage',
]);

// Capacitor syncs the built web dist into the native projects (gitignored as
// "Copied web assets"). Those trees are derived output, but their leaf dir is
// named "public" — which elsewhere (apps/web/public, apps/marketing/public)
// holds authored static assets — so they are skipped by path suffix, not name.
const SKIP_PATH_SUFFIXES = ['android/app/src/main/assets/public', 'ios/App/App/public'];

function isDerivedOutputDir(fullPath: string, name: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  const normalized = fullPath.split(path.sep).join('/');
  return SKIP_PATH_SUFFIXES.some((suffix) => normalized.endsWith(`/${suffix}`));
}

const TAILWIND_CONFIG = path.join(repoRoot, 'packages/config/tailwind/index.css');

function isTestFile(file: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(file);
}

function collectSourceFiles(dir: string, accumulator: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isDerivedOutputDir(full, entry.name)) collectSourceFiles(full, accumulator);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      accumulator.push(full);
    }
  }
}

function collectRootFiles(root: string): string[] {
  const files: string[] = [];
  collectSourceFiles(path.join(repoRoot, root), files);
  // A zero-file collection means the walker broke; without this the guards
  // below would pass vacuously against an empty scan.
  if (files.length === 0) {
    throw new Error(`token guard scan collected no source files under ${root}`);
  }
  return files;
}

function findMatches(needle: string, allow: (file: string) => boolean): string[] {
  const offenders: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of collectRootFiles(root)) {
      if (allow(file)) continue;
      if (readFileSync(file, 'utf8').includes(needle)) offenders.push(file);
    }
  }
  return offenders;
}

describe('collectSourceFiles', () => {
  const fixtureRoot = path.join(stylesDir, '__test-fixtures-token-guards__');

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function collect(): string[] {
    const files: string[] = [];
    collectSourceFiles(fixtureRoot, files);
    return files;
  }

  it('collects authored source files', () => {
    mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
    writeFileSync(path.join(fixtureRoot, 'src/app.css'), 'body {}\n');
    expect(collect()).toEqual([path.join(fixtureRoot, 'src/app.css')]);
  });

  it('excludes files under dist-ota build output', () => {
    mkdirSync(path.join(fixtureRoot, 'dist-ota/assets'), { recursive: true });
    writeFileSync(path.join(fixtureRoot, 'dist-ota/assets/index.css'), 'body {}\n');
    expect(collect()).toEqual([]);
  });

  it('excludes the Capacitor android synced web assets', () => {
    const synced = path.join(fixtureRoot, 'android/app/src/main/assets/public/assets');
    mkdirSync(synced, { recursive: true });
    writeFileSync(path.join(synced, 'index.css'), 'body {}\n');
    expect(collect()).toEqual([]);
  });

  it('excludes the Capacitor ios synced web assets', () => {
    const synced = path.join(fixtureRoot, 'ios/App/App/public/assets');
    mkdirSync(synced, { recursive: true });
    writeFileSync(path.join(synced, 'index.css'), 'body {}\n');
    expect(collect()).toEqual([]);
  });
});

describe('token canonicalization guards', () => {
  it('no source file uses the non-canonical text-foreground-muted utility', () => {
    // The alias DEFINITION (--color-foreground-muted) in the tailwind config is
    // intentionally retained; only the utility CLASS usage is banned. Test files
    // (including this guard) name the banned string and are excluded.
    const offenders = findMatches(
      'text-foreground-muted',
      (file) => file === TAILWIND_CONFIG || isTestFile(file)
    );
    expect(offenders).toEqual([]);
  });

  it('no source file hardcodes the brand-red hex via text-[#ec4755]', () => {
    const offenders = findMatches('text-[#ec4755]', isTestFile);
    expect(offenders).toEqual([]);
  });
});
