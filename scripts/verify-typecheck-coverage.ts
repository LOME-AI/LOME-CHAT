#!/usr/bin/env tsx
/**
 * TypeScript Coverage Verification Script
 *
 * Ensures every .ts/.tsx file in the repo is covered by at least one tsconfig.
 * Catches orphaned files that escape typecheck coverage.
 *
 * Usage:
 *   pnpm verify:typecheck-coverage
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { discoverWorkspaces } from './workspaces.js';
import { isMainModule } from './lib/is-main.js';
import type { Workspace } from './workspaces.js';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.turbo',
  '.astro',
  '.wrangler',
  'coverage',
]);

const EXCLUDED_FILES = new Set(['routeTree.gen.ts']);

/**
 * Legacy-named path segment (`legacy`, `legacy_*`, `legacy-*`, `legacy.*`).
 * Mirrors the no-legacy-imports lint rule: the legacy corpus is reference-only
 * and deliberately excluded from every package tsconfig, so requiring tsconfig
 * coverage for it would contradict that convention.
 */
function isLegacySegment(name: string): boolean {
  return /^legacy([._-]|$)/.test(name);
}

/**
 * Find all tsconfig*.json files across the repo (root + workspaces).
 * Excludes node_modules.
 */
export function findAllTsconfigs(rootDirectory: string, workspaces?: Workspace[]): string[] {
  const tsconfigs: string[] = [];

  const rootTsconfig = path.join(rootDirectory, 'tsconfig.json');
  if (existsSync(rootTsconfig)) {
    tsconfigs.push(rootTsconfig);
  }

  const resolvedWorkspaces = workspaces ?? discoverWorkspaces(rootDirectory);
  for (const workspace of resolvedWorkspaces) {
    const workspaceDirectory = path.join(rootDirectory, workspace.path);
    if (!existsSync(workspaceDirectory)) continue;

    const entries = readdirSync(workspaceDirectory);
    for (const entry of entries) {
      if (entry.startsWith('tsconfig') && entry.endsWith('.json')) {
        tsconfigs.push(path.join(workspaceDirectory, entry));
      }
    }
  }

  return tsconfigs;
}

/**
 * Return every source file covered by a tsconfig, including transitively
 * imported ones. Uses the TypeScript compiler API so we do not depend on the
 * `tsc` CLI or any of its unstable diagnostic flags (e.g. `--listFiles`).
 * Filters out files inside node_modules.
 *
 * Synchronous: `ts.createProgram` does not do any async I/O.
 */
export function getFilesFromTsconfig(tsconfigPath: string): string[] {
  const readResult = ts.readConfigFile(tsconfigPath, (filePath) => ts.sys.readFile(filePath));
  if (readResult.error || !readResult.config) {
    return [];
  }

  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    path.dirname(tsconfigPath)
  );
  if (parsed.errors.length > 0) {
    const host: ts.FormatDiagnosticsHost = {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => ts.sys.newLine,
    };
    console.warn(ts.formatDiagnosticsWithColorAndContext(parsed.errors, host));
  }
  if (parsed.fileNames.length === 0) {
    return [];
  }

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });

  return program
    .getSourceFiles()
    .map((sourceFile) => sourceFile.fileName)
    .filter((fileName) => !fileName.replaceAll('\\', '/').includes('/node_modules/'));
}

function isExcludedDirectory(name: string): boolean {
  return EXCLUDED_DIRS.has(name) || isLegacySegment(name);
}

function isExcludedFile(name: string): boolean {
  if (name.endsWith('.d.ts')) return true;
  if (isLegacySegment(name)) return true;
  return EXCLUDED_FILES.has(name);
}

function isTypeScriptFile(name: string): boolean {
  return (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.d.ts');
}

/**
 * Recursively find all .ts/.tsx files in specified directories,
 * excluding standard ignore patterns.
 */
export function findAllSourceFiles(directories: string[]): string[] {
  const files: string[] = [];

  function walk(directory: string): void {
    const entries = readdirSync(directory);
    for (const entry of entries) {
      const fullPath = path.join(directory, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (!isExcludedDirectory(entry)) {
          walk(fullPath);
        }
      } else if (isTypeScriptFile(entry) && !isExcludedFile(entry)) {
        files.push(fullPath);
      }
    }
  }

  for (const directory of directories) {
    if (existsSync(directory)) {
      walk(directory);
    }
  }
  return files;
}

/**
 * Return files in allSourceFiles that are not in coveredFiles.
 */
export function findOrphanedFiles(
  allSourceFiles: Set<string>,
  coveredFiles: Set<string>
): string[] {
  const orphans: string[] = [];
  for (const file of allSourceFiles) {
    if (!coveredFiles.has(file)) {
      orphans.push(file);
    }
  }
  return orphans.toSorted((a, b) => a.localeCompare(b));
}

/**
 * Format a human-readable report of orphaned files.
 */
export function formatReport(orphanedFiles: string[], rootDirectory: string): string {
  if (orphanedFiles.length === 0) {
    return '✓ All TypeScript files are covered by a tsconfig.';
  }

  const relativePaths = orphanedFiles.map((file) => path.relative(rootDirectory, file));
  const lines = [
    `✗ ${String(orphanedFiles.length)} TypeScript file(s) not covered by any tsconfig:`,
    '',
    ...relativePaths.map((file) => `  ${file}`),
    '',
    'Fix: Add these files to the appropriate tsconfig "include" pattern.',
  ];

  return lines.join('\n');
}

/**
 * Run the full verification: find all source files, check tsconfig coverage, report.
 */
export function verify(rootDirectory: string): { success: boolean; orphanedFiles: string[] } {
  const workspaces = discoverWorkspaces(rootDirectory);
  const tsconfigs = findAllTsconfigs(rootDirectory, workspaces);
  const coveredFiles = new Set<string>();

  for (const tsconfig of tsconfigs) {
    const files = getFilesFromTsconfig(tsconfig);
    for (const file of files) {
      coveredFiles.add(file);
    }
  }

  const workspaceDirectories = workspaces.map((ws) => path.join(rootDirectory, ws.path));
  const allSourceFiles = new Set(findAllSourceFiles(workspaceDirectories));
  const orphanedFiles = findOrphanedFiles(allSourceFiles, coveredFiles);

  return {
    success: orphanedFiles.length === 0,
    orphanedFiles,
  };
}

/* v8 ignore start -- CLI entry point */
function main(): void {
  const rootDirectory = process.cwd();

  console.log('Verifying TypeScript coverage...\n');

  const result = verify(rootDirectory);
  const report = formatReport(result.orphanedFiles, rootDirectory);

  console.log(report);

  if (!result.success) {
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error: unknown) {
    console.error('Unexpected error:', error);
    process.exit(1);
  }
}
/* v8 ignore stop */
