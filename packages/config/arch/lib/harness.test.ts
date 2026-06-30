import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { discoverRuleFiles, formatViolations, loadRules, runRules } from './harness.js';
import type { ArchRule } from '../types.js';

const FIXTURES_RULES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '__test-fixtures-arch__',
  'rules'
);

function validRuleFiles(): string[] {
  return discoverRuleFiles(FIXTURES_RULES_DIR).filter(
    (file) => !file.includes('broken') && !file.includes('no-default')
  );
}

describe('discoverRuleFiles', () => {
  it('finds only *.rule.ts files, sorted by filename', () => {
    const files = discoverRuleFiles(FIXTURES_RULES_DIR);

    expect(files.map((file) => path.basename(file))).toEqual([
      'always-clean.rule.ts',
      'broken.rule.ts',
      'flag-marker-classes.rule.ts',
      'no-default.rule.ts',
    ]);
  });
});

describe('loadRules', () => {
  it('loads default-exported rules from rule files', async () => {
    const rules = await loadRules(validRuleFiles());

    expect(rules.map((rule) => rule.name)).toEqual(['always-clean', 'flag-marker-classes']);
  });

  it('throws naming the file when a rule file has an invalid shape', async () => {
    const files = discoverRuleFiles(FIXTURES_RULES_DIR).filter((file) => file.includes('broken'));

    await expect(loadRules(files)).rejects.toThrow('broken.rule.ts');
  });

  it('throws naming the file when a rule file has no default export', async () => {
    const files = discoverRuleFiles(FIXTURES_RULES_DIR).filter((file) =>
      file.includes('no-default')
    );

    await expect(loadRules(files)).rejects.toThrow('no-default.rule.ts');
  });
});

describe('runRules', () => {
  it('aggregates violations from every rule with the rule name attached', async () => {
    const rules = await loadRules(validRuleFiles());
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      'apps/api/src/slices/chat/marker.ts',
      'export class MarkerExample {}\n'
    );

    const results = runRules(rules, project);

    expect(results).toEqual([
      {
        rule: 'flag-marker-classes',
        violation: {
          file: 'apps/api/src/slices/chat/marker.ts',
          line: 1,
          message: 'class name contains Marker',
        },
      },
    ]);
  });
});

describe('formatViolations', () => {
  it('formats one line per violation', () => {
    const results = [
      {
        rule: 'example-rule',
        violation: { file: 'a/b.ts', line: 3, message: 'broke the rule' },
      },
    ];

    expect(formatViolations(results)).toContain('a/b.ts:3 [example-rule] broke the rule');
  });
});

describe('rule contract', () => {
  it('exposes name and check on loaded rules', async () => {
    const rules: ArchRule[] = await loadRules(validRuleFiles());

    for (const rule of rules) {
      expect(typeof rule.name).toBe('string');
      expect(typeof rule.check).toBe('function');
    }
  });
});
