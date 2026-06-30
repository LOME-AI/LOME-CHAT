import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Project } from 'ts-morph';
import type { ArchRule, ArchRuleResult } from '../types.js';

/**
 * Discovers rule files (`*.rule.ts`) directly inside a directory, sorted by
 * filename so the run order is deterministic. One topic-named file per rule —
 * see arch/README.md for the contract.
 */
export function discoverRuleFiles(rulesDir: string): string[] {
  return readdirSync(rulesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.rule.ts'))
    .map((entry) => path.join(rulesDir, entry.name))
    .toSorted((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function isArchRule(candidate: unknown): candidate is ArchRule {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const rule = candidate as Record<string, unknown>;
  return typeof rule['name'] === 'string' && typeof rule['check'] === 'function';
}

/**
 * Imports each rule file and validates its default export. A malformed rule
 * file fails loudly — the harness never skips a rule silently.
 */
export async function loadRules(ruleFiles: string[]): Promise<ArchRule[]> {
  const rules: ArchRule[] = [];
  for (const ruleFile of ruleFiles) {
    const module = (await import(pathToFileURL(ruleFile).href)) as { default?: unknown };
    if (!isArchRule(module.default)) {
      throw new TypeError(
        `Arch rule "${path.basename(ruleFile)}" must default-export { name, check }.`
      );
    }
    rules.push(module.default);
  }
  return rules;
}

/** Runs every rule against the project and tags violations with rule names. */
export function runRules(rules: ArchRule[], project: Project): ArchRuleResult[] {
  const results: ArchRuleResult[] = [];
  for (const rule of rules) {
    for (const violation of rule.check(project)) {
      results.push({ rule: rule.name, violation });
    }
  }
  return results;
}

/** Formats results for CI output: one `file:line [rule] message` per line. */
export function formatViolations(results: ArchRuleResult[]): string {
  return results
    .map(
      ({ rule, violation }) =>
        `${violation.file}:${String(violation.line)} [${rule}] ${violation.message}`
    )
    .join('\n');
}
