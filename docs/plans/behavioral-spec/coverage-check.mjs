#!/usr/bin/env node
/**
 * T0.0 coverage check (ad-hoc, NOT CI-wired — run manually):
 *
 *   node docs/plans/behavioral-spec/coverage-check.mjs
 *
 * Walks every e2e spec file (e2e/**\/*.spec.ts and e2e/**\/*.test.ts) and
 * asserts each one is mapped in mapping.json to exactly one of the 14 spec
 * families, or is explicitly marked out-of-scope with a reason. Exits
 * non-zero listing unmapped files, invalid entries, and stale mapping
 * entries whose spec file no longer exists.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const artifactDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(artifactDir, '..', '..', '..');
const e2eDir = join(repoRoot, 'e2e');

// Directories that can never contain our own specs.
const SKIP_DIRS = new Set(['node_modules', 'report', 'test-results']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.spec.ts') || entry.endsWith('.test.ts')) {
      out.push(relative(repoRoot, full).replaceAll('\\', '/'));
    }
  }
  return out;
}

const mapping = JSON.parse(readFileSync(join(artifactDir, 'mapping.json'), 'utf8'));
const families = new Set(mapping.families);
const specEntries = mapping.specs;

const found = walk(e2eDir).sort();
const errors = [];

for (const file of found) {
  const entry = specEntries[file];
  if (entry === undefined) {
    errors.push(`UNMAPPED: ${file} — add it to mapping.json (family or outOfScope+reason)`);
    continue;
  }
  const hasFamily = typeof entry.family === 'string';
  const isOutOfScope = entry.outOfScope === true;
  if (hasFamily && isOutOfScope) {
    errors.push(`INVALID: ${file} — has both a family and outOfScope; pick exactly one`);
  } else if (hasFamily) {
    if (!families.has(entry.family)) {
      errors.push(`INVALID: ${file} — unknown family "${entry.family}"`);
    }
  } else if (isOutOfScope) {
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      errors.push(`INVALID: ${file} — outOfScope entries require a non-empty reason`);
    }
  } else {
    errors.push(`INVALID: ${file} — entry must have a family or outOfScope: true`);
  }
}

for (const mapped of Object.keys(specEntries)) {
  if (!found.includes(mapped)) {
    errors.push(`STALE: ${mapped} — mapped in mapping.json but file not found under e2e/`);
  }
}

if (errors.length > 0) {
  console.error(`coverage-check FAILED (${String(errors.length)} problem(s)):`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

const mappedCount = found.filter((f) => typeof specEntries[f].family === 'string').length;
const oosCount = found.length - mappedCount;
console.log(
  `coverage-check OK: ${String(found.length)} e2e spec files — ${String(mappedCount)} mapped to families, ${String(oosCount)} out-of-scope.`
);
