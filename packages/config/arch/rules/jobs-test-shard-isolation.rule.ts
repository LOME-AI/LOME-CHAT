import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The jobs table is one shared queue, so the jobs integration tests split it:
 * pass.integration.test.ts is the single file allowed to commit claimable
 * rows, and only on the `default` shard; every other jobs integration test
 * runs inside rolled-back transactions and must keep shard-wide FOR UPDATE
 * operations (claim, sweep, dead-letter, full pass) on the `bulk` shard —
 * even a rolled-back transaction's row locks make SKIP LOCKED claims in the
 * committing file transiently miss its rows. The shard argument must be the
 * literal 'bulk'; a variable could smuggle 'default' past a static check.
 *
 * The contract's other half — every assertion scoped to rows the file owns,
 * never to shard-wide truth — is not statically checkable and stays prose in
 * the test files themselves.
 */

interface ShardArgumentSpec {
  readonly argIndex: number;
  /** `positional`: the shard IS the argument; `options`: it is a `shard:` property. */
  readonly kind: 'positional' | 'options';
}

const SHARD_WIDE_OPERATIONS = new Map<string, ShardArgumentSpec>([
  ['claimBatch', { argIndex: 1, kind: 'options' }],
  ['sweepCancelRequested', { argIndex: 1, kind: 'positional' }],
  ['deadLetterExhausted', { argIndex: 1, kind: 'positional' }],
  ['runPass', { argIndex: 0, kind: 'positional' }],
]);

const COMMITTING_FILE = 'pass.integration.test.ts';

function isRollbackJobsTestFile(filePath: string): boolean {
  return (
    filePath.includes('apps/api/src/lib/jobs/') &&
    filePath.endsWith('.integration.test.ts') &&
    !filePath.endsWith(`/${COMMITTING_FILE}`)
  );
}

function calleeName(call: CallExpression): string | undefined {
  const expression = call.getExpression();
  if (Node.isIdentifier(expression)) return expression.getText();
  if (Node.isPropertyAccessExpression(expression)) return expression.getName();
  return undefined;
}

function shardArgument(call: CallExpression, spec: ShardArgumentSpec): Node | undefined {
  const argument = call.getArguments()[spec.argIndex];
  if (spec.kind === 'positional') return argument;
  if (argument !== undefined && Node.isObjectLiteralExpression(argument)) {
    const property = argument.getProperty('shard');
    if (property !== undefined && Node.isPropertyAssignment(property)) {
      return property.getInitializer();
    }
  }
  return undefined;
}

function isBulkLiteral(node: Node | undefined): boolean {
  return node !== undefined && Node.isStringLiteral(node) && node.getLiteralText() === 'bulk';
}

function checkSourceFile(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const name = calleeName(call);
    const spec = name === undefined ? undefined : SHARD_WIDE_OPERATIONS.get(name);
    if (spec === undefined || isBulkLiteral(shardArgument(call, spec))) continue;
    violations.push({
      file: filePath,
      line: call.getStartLineNumber(),
      message:
        "Rollback jobs test files must run shard-wide operations on the literal 'bulk' shard — pass.integration.test.ts owns committed 'default'-shard rows, and a 'default'-shard FOR UPDATE here can lock-skip them.",
    });
  }
  return violations;
}

const rule: ArchRule = {
  name: 'jobs-test-shard-isolation',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath().replace(/^\//, '');
      if (!isRollbackJobsTestFile(filePath)) continue;
      violations.push(...checkSourceFile(sourceFile, filePath));
    }
    return violations;
  },
};

export default rule;
