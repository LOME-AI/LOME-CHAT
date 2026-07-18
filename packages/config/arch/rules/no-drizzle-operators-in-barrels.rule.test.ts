import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './no-drizzle-operators-in-barrels.rule.js';

function projectWith(filePath: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(filePath, source);
  return project;
}

const BARREL = 'packages/db/src/index.ts';

describe('no-drizzle-operators-in-barrels', () => {
  it('flags a barrel re-exporting a named operator from drizzle-orm', () => {
    const project = projectWith(BARREL, "export { eq } from 'drizzle-orm';\n");

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: BARREL, line: 1 });
    expect(violations[0]?.message).toContain('eq');
    expect(violations[0]?.message).toContain('drizzle-orm');
  });

  it('flags a barrel star-re-exporting drizzle-orm', () => {
    const project = projectWith(BARREL, "export * from 'drizzle-orm';\n");

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('drizzle-orm');
  });

  it('flags any re-export from drizzle-orm even when the symbol is not an operator', () => {
    const project = projectWith(BARREL, "export { getTableName } from 'drizzle-orm';\n");

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a barrel surfacing an operator symbol laundered through a local module', () => {
    const project = projectWith(BARREL, "export { eq, sql } from './operators.js';\n");

    const violations = rule.check(project);

    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.message).join(' ')).toContain('sql');
  });

  it('flags an operator re-exported under a benign alias (source name still the operator)', () => {
    const project = projectWith(BARREL, "export { inArray as within } from './q.js';\n");

    expect(rule.check(project)).toHaveLength(1);
  });

  it('passes a barrel that exports only tables, clients, and helpers', () => {
    const project = projectWith(
      BARREL,
      "export * from './schema/index.js';\nexport { createDatabase } from './client.js';\nexport { and as andHelper } from './unrelated.js';\n"
    );

    // `and as andHelper`: outward name is a false-positive candidate, but the
    // source symbol `and` is the operator, so this SHOULD flag — see next test
    // for the genuinely-clean shape.
    expect(rule.check(project).length).toBeGreaterThan(0);
  });

  it('passes a barrel with no operator or drizzle-orm re-exports', () => {
    const project = projectWith(
      BARREL,
      "export * from './schema/index.js';\nexport { createDatabase } from './client.js';\nexport { evidenceHelper } from './evidence.js';\n"
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores operator names in local export-star from the package itself', () => {
    const project = projectWith(BARREL, "export * from './formatting.js';\n");

    expect(rule.check(project)).toEqual([]);
  });

  it('only inspects package barrels, not arbitrary package source files', () => {
    const project = projectWith('packages/db/src/client.ts', "export { eq } from 'drizzle-orm';\n");

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag operator words appearing only in comments', () => {
    const project = projectWith(
      BARREL,
      "// Query operators (eq/sql/inArray/and) are deliberately NOT re-exported.\nexport { createDatabase } from './client.js';\n"
    );

    expect(rule.check(project)).toEqual([]);
  });
});
