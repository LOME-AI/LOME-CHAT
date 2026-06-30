import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './jobs-test-shard-isolation.rule.js';

function projectWith(filePath: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(filePath, source);
  return project;
}

const ROLLBACK_FILE = 'apps/api/src/lib/jobs/claim.integration.test.ts';

describe('jobs-test-shard-isolation', () => {
  it('flags claimBatch on the default shard in a rollback jobs test file', () => {
    const project = projectWith(
      ROLLBACK_FILE,
      "await claimBatch(tx, { shard: 'default', claimantId: 'me', limit: 20 });\n"
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ROLLBACK_FILE, line: 1 });
  });

  it('flags a positional default shard passed to sweepCancelRequested', () => {
    const project = projectWith(ROLLBACK_FILE, "await sweepCancelRequested(tx, 'default');\n");

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a non-literal shard argument to deadLetterExhausted', () => {
    const project = projectWith(
      ROLLBACK_FILE,
      'const shard = pickShard();\nawait deadLetterExhausted(tx, shard);\n'
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags runPass on the default shard reached through a property chain', () => {
    const project = projectWith(
      'apps/api/src/lib/jobs/dispatcher-bindings.integration.test.ts',
      "await bindings.executor.runPass('default');\n"
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags claimBatch whenever the shard cannot be read as a literal', () => {
    const project = projectWith(
      ROLLBACK_FILE,
      [
        "await claimBatch(tx, { claimantId: 'me', limit: 20 });",
        'await claimBatch(tx, options);',
        'await claimBatch(tx, { shard });',
        '',
      ].join('\n')
    );

    expect(rule.check(project)).toHaveLength(3);
  });

  it('ignores calls without a named callee', () => {
    const project = projectWith(ROLLBACK_FILE, '(() => undefined)();\n');

    expect(rule.check(project)).toEqual([]);
  });

  it('allows every shard-wide operation on the bulk shard', () => {
    const project = projectWith(
      ROLLBACK_FILE,
      [
        "await claimBatch(tx, { shard: 'bulk', claimantId: 'me', limit: 20 });",
        "await sweepCancelRequested(tx, 'bulk');",
        "await deadLetterExhausted(tx, 'bulk');",
        "await bindings.executor.runPass('bulk');",
        '',
      ].join('\n')
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('allows the committing pass file to operate on the default shard', () => {
    const project = projectWith(
      'apps/api/src/lib/jobs/pass.integration.test.ts',
      "await bindings.executor.runPass('default');\n"
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores non-integration test files in the jobs tree', () => {
    const project = projectWith(
      'apps/api/src/lib/jobs/pass.test.ts',
      "await sweepCancelRequested(tx, 'default');\n"
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores integration tests outside the jobs tree', () => {
    const project = projectWith(
      'apps/api/src/lib/idempotency/by-key.integration.test.ts',
      "await sweepCancelRequested(tx, 'default');\n"
    );

    expect(rule.check(project)).toEqual([]);
  });
});
