#!/usr/bin/env tsx
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from 'ts-morph';
import { discoverRuleFiles, formatViolations, loadRules, runRules } from './lib/harness.js';

/**
 * Architecture-rule runner. Loads every `arch/rules/*.rule.ts`, builds a
 * ts-morph project over the backend source paths (the demoted legacy
 * reference corpus is exempt), runs the rules, and exits non-zero on
 * violations.
 *
 * Run via `pnpm arch:check` (root) — also wired as a CI step.
 */

const ARCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ARCH_DIR, '..', '..', '..');

/**
 * Backend source globs; the slice template is scaffolding, not code, and
 * legacy-named paths (`legacy_*` files, `legacy-*` dirs, `legacy/` trees) are
 * the reference corpus, not running code.
 */
const SOURCE_GLOBS = [
  'apps/api/src/slices/**/*.ts',
  '!apps/api/src/slices/_template/**',
  'apps/api/src/lib/**/*.ts',
  'apps/api/src/middleware/**/*.ts',
  'apps/api/src/app.ts',
  'packages/db/src/schema/**/*.ts',
  'packages/shared/src/**/*.ts',
  'packages/crypto/src/**/*.ts',
  '!**/legacy/**',
  '!**/legacy_*',
  '!**/legacy_*/**',
  '!**/legacy-*/**',
];

async function main(): Promise<void> {
  const ruleFiles = discoverRuleFiles(path.join(ARCH_DIR, 'rules'));
  const rules = await loadRules(ruleFiles);

  const project = new Project({ skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths(
    SOURCE_GLOBS.map((glob) =>
      glob.startsWith('!') ? '!' + path.join(REPO_ROOT, glob.slice(1)) : path.join(REPO_ROOT, glob)
    )
  );

  const results = runRules(rules, project);
  if (results.length > 0) {
    console.error('arch:check: ARCHITECTURE RULE VIOLATIONS');
    console.error(formatViolations(results));
    process.exitCode = 1;
    return;
  }
  console.warn(
    `arch:check: OK — ${String(rules.length)} rule(s) over ${String(project.getSourceFiles().length)} file(s)`
  );
}

await main();
