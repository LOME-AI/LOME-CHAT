import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Directories never descended into. The rule is "no human wrote this": dependency
 * installs, build output, tool caches, VCS internals, generated test reports and
 * harness state, and the tool-generated Drizzle migration directory. Hand-written
 * dev tooling (e.g. `.claude`) and CI config are deliberately NOT here.
 */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
  '.wrangler',
  '.astro',
  '.vite',
  'out',
  // Generated test reports/artifacts and harness state: Playwright/Maestro
  // reports, jscpd output, per-run results, saved auth — output, not source.
  'report',
  'reports',
  'playwright-report',
  'test-results',
  'maestro-results',
  '.auth',
  // drizzle-kit migration output (SQL + snapshot JSON) is generated from the
  // hand-written schema, which is counted; the generated migrations are not.
  'drizzle',
]);

/** Lockfiles are generated resolver output, never hand-edited. */
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);

/** Tool-generated files (e.g. TanStack Router's `routeTree.gen.ts`) overwritten
 * on build; counting them measures the generator, not the codebase. */
const GENERATED_FILE = /\.gen\.(?:ts|tsx|js|jsx)$/;

/**
 * Extensions counted toward the repo's "lines written" stat: anything a human
 * authors here — code, styles, markup, config, CI workflows, scripts, diagrams,
 * and documentation. Binary assets (images, fonts, wasm) are excluded by omission.
 */
const COUNTED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.html',
  '.astro',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.sh',
  '.mermaid',
  '.md',
  '.mdx',
]);

/** Physical line count of a file's text: the empty file is zero, a trailing
 * newline does not add a phantom final line. */
function countLines(contents: string): number {
  if (contents.length === 0) return 0;
  const body = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  return body.split('\n').length;
}

/** A file counts when a human authored it: a counted extension that is neither a
 * lockfile nor a generated file. */
function isCountedSource(name: string): boolean {
  if (LOCKFILES.has(name) || GENERATED_FILE.test(name)) return false;
  return COUNTED_EXTENSIONS.has(path.extname(name));
}

/**
 * Same source-file rules as `countLinesOfCode`'s walk, applied to a
 * slash-separated repo-relative path (the form git emits). Shared with the
 * churn count so the two README stats can never disagree on what "source" is.
 */
export function isCountedPath(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const name = segments.at(-1);
  if (name === undefined || name === '') return false;
  if (segments.slice(0, -1).some((segment) => IGNORED_DIRECTORIES.has(segment))) return false;
  return isCountedSource(name);
}

/**
 * Total physical lines across every source file under `dir`, skipping the
 * vendored/generated directories above. Walks the tree with `node:fs` only — no
 * shell-out — so it runs identically on every OS and inside unit tests.
 */
export function countLinesOfCode(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) total += countLinesOfCode(absolute);
    } else if (entry.isFile() && isCountedSource(entry.name)) {
      total += countLines(readFileSync(absolute, 'utf8'));
    }
  }
  return total;
}
