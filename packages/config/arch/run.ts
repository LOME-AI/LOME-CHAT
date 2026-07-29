#!/usr/bin/env tsx
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from 'ts-morph';
import { discoverRuleFiles, formatViolations, loadRules, runRules } from './lib/harness.js';

/**
 * Architecture-rule runner. Loads every `arch/rules/*.rule.ts`, builds a
 * ts-morph project over the backend source paths, runs the rules, and exits
 * non-zero on violations.
 *
 * Run via `pnpm arch:check` (root) — also wired as a CI step.
 */

const ARCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ARCH_DIR, '..', '..', '..');

/**
 * Scanned source globs; the slice template is scaffolding, not code. The web
 * app is scanned so `demo-isolation` sees production web code; every other rule
 * gates itself to backend paths and stays inert over web files. The quarantined
 * `/legacy/` corpus lives at the repo root, outside every glob below.
 *
 * The api tree is taken WHOLE rather than as a list of its directories. An
 * enumerated list silently exempts whatever it does not name — `platform/**`,
 * `adapters/**`, `jobs/**` and the root-level entry points sat outside it, so a
 * rule could report a scope it did not actually inspect, and `platform/dev`
 * writes ledger legs and wallet state. A rule that gates itself to a subtree
 * filters inside `check`; the glob's job is to withhold nothing.
 */
const SOURCE_GLOBS = [
  'apps/api/src/**/*.ts',
  '!apps/api/src/slices/_template/**',
  'apps/web/src/**/*.{ts,tsx}',
  'packages/db/src/schema/**/*.ts',
  'packages/shared/src/**/*.ts',
  'packages/crypto/src/**/*.ts',
  'packages/*/src/index.ts',
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
