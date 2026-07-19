import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './single-writer-per-table.rule.js';

const BARREL = 'packages/db/src/schema/index.ts';

/** The live table-export set, mirrored from `packages/db/src/schema/index.ts`. */
const TABLE_NAMES = [
  'users',
  'verificationTokens',
  'accountDeletionEvents',
  'wallets',
  'ledgerEntries',
  'usageRecords',
  'llmCompletions',
  'mediaGenerations',
  'payments',
  'memberBudgets',
  'conversationSpending',
  'allowanceSpending',
  'publicStatsSnapshots',
  'conversations',
  'conversationMembers',
  'conversationForks',
  'epochs',
  'epochMembers',
  'sharedLinks',
  'sharedMessages',
  'messages',
  'contentItems',
  'modelCatalog',
  'newsletterSubscribers',
  'newsletterIssues',
  'newsletterDeliveries',
  'adminAudit',
  'deviceTokens',
  'feedback',
  'customInstructions',
  'preferences',
  'bannerConfig',
  'bannerDismissals',
  'idempotencyKeys',
  'jobs',
  'serviceEvidence',
];

/**
 * Builds a synthetic schema barrel. The `./enums` and `./relations` declarations
 * must be filtered out by the rule; the remaining named exports are the table set.
 */
function barrelSource(tables: readonly string[] = TABLE_NAMES): string {
  const enums = "export { walletTypeEnum } from './enums';\n";
  const relations = "export { usersRelations } from './relations';\n";
  const tableExports = tables.map((name) => `export { ${name} } from './${name}';\n`).join('');
  return enums + relations + tableExports;
}

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, source] of Object.entries(files)) {
    project.createSourceFile(path, source);
  }
  return project;
}

describe('single-writer-per-table', () => {
  it('flags a slice writing a foreign table via the query builder', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/billing/adapters/stores.ts':
        'const x = db.insert(messages).values({});\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("slice 'billing'");
    expect(violations[0]?.message).toContain("table 'messages'");
    expect(violations[0]?.message).toContain("owned by 'chat'");
  });

  it('flags a slice writing an infra sentinel table', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/chat/adapters/stores.ts': 'const x = db.insert(jobs).values({});\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("slice 'chat'");
    expect(violations[0]?.message).toContain("table 'jobs'");
    expect(violations[0]?.message).toContain("owned by 'lib'");
  });

  it('flags a raw-SQL cross-slice write', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/billing/adapters/stores.ts':
        'const x = db.execute(sql`INSERT INTO ${messages} (a) VALUES (1)`);\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("slice 'billing'");
    expect(violations[0]?.message).toContain("table 'messages'");
  });

  it('passes a raw-SQL owner write', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/feedback/adapters/stores.ts':
        'const x = db.execute(sql`INSERT INTO ${feedback} (a) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${feedback})`);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a non-DML sql template that reads a foreign table', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/billing/adapters/stores.ts':
        'const x = db.execute(sql`SELECT * FROM ${messages}`);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a correct owner write via the query builder', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/identity/adapters/stores.ts': 'const x = db.insert(users).values({});\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag Hono route verbs, Set.delete, or storage.delete', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/identity/routes.ts':
        "router.delete('/session', handler);\nseen.delete(makeKey(x));\nstorage.delete(object.key);\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores writes in test files', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/billing/adapters/stores.test.ts':
        'const x = db.insert(messages).values({});\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a schema table with no TABLE_OWNER entry', () => {
    const project = projectWith({
      [BARREL]: barrelSource([...TABLE_NAMES, 'ghostTable']),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("table 'ghostTable'");
    expect(violations[0]?.message).toContain('no owning slice');
  });

  it('flags a TABLE_OWNER key absent from the schema', () => {
    const project = projectWith({
      [BARREL]: barrelSource(TABLE_NAMES.filter((name) => name !== 'feedback')),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("'feedback'");
    expect(violations[0]?.message).toContain('no longer exists');
  });

  it('passes cleanly when every table maps one-to-one to its owner', () => {
    const project = projectWith({ [BARREL]: barrelSource() });

    expect(rule.check(project)).toEqual([]);
  });

  it('throws when the schema barrel is absent from the project', () => {
    const project = projectWith({
      'apps/api/src/slices/billing/adapters/stores.ts': 'const x = 1;\n',
    });

    expect(() => rule.check(project)).toThrow(/schema barrel/);
  });

  it('defensively drops names ending in Enum or Relations even outside the enum/relation modules', () => {
    const project = projectWith({
      [BARREL]:
        barrelSource() +
        "export { fooEnum } from './foo';\nexport { fooRelations } from './foo';\n",
    });

    // Neither synthetic name is a real table, so treating them as tables would
    // trip the "no owning slice" completeness check. A clean pass proves they
    // were filtered.
    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a slice writing a schema table that has no owner (owner completeness reports it once, at the barrel)', () => {
    const project = projectWith({
      [BARREL]: barrelSource([...TABLE_NAMES, 'ghostTable']),
      'apps/api/src/slices/billing/adapters/stores.ts':
        'const x = db.insert(ghostTable).values({});\n',
    });

    const violations = rule.check(project);

    // The write itself is not attributed (no owner to compare against); only the
    // completeness violation at the barrel fires.
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(BARREL);
    expect(violations[0]?.message).toContain('no owning slice');
  });

  it('ignores a query-builder write whose first argument is a non-table identifier', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      // Mirrors the real feedback/domain/submit.ts shape: `db.insert(userId, input)`
      // passes a bare identifier that is not a schema table, so the matcher must
      // ignore it rather than mis-flag it.
      'apps/api/src/slices/feedback/domain/submit.ts':
        'const x = db.insert(userId, input);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a non-sql tagged template and a sql template with no interpolation', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/billing/adapters/stores.ts':
        'const a = other`INSERT INTO ${messages}`;\nconst b = sql`INSERT INTO messages VALUES (1)`;\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores non-table and non-identifier interpolations in a DML sql template', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/feedback/adapters/stores.ts':
        'const x = db.execute(sql`INSERT INTO ${feedback} (${sql.identifier(col)}) VALUES (${userId})`);\n',
    });

    // `${sql.identifier(col)}` is a call, `${userId}` is a non-table identifier;
    // only `${feedback}` counts, and feedback owns feedback, so no violation.
    expect(rule.check(project)).toEqual([]);
  });
});
