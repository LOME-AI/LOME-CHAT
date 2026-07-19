import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * No external call inside a plain DB transaction (pattern A/D, structurally
 * enforced). A `db.transaction(...)` callback commits domain state; an external
 * call inside it would make the transaction's duration a network round-trip and
 * defeat crash-recovery-by-construction (a killed run between the external
 * effect and commit is exactly what pattern D exists to avoid). Pattern D keeps
 * the external effect OUTSIDE the transaction by construction — `byExternalPreClaim`
 * runs pre-claim → external → finalize as three separate steps — so a correct
 * card-charge never puts the external call in a tx and is never flagged.
 *
 * "External call" is `fetch` (bare `fetch(...)` or `globalThis/self/window.fetch(...)`),
 * the same syntactic definition the admin-op-purity rule uses: every provider /
 * storage / payment / email port bottoms out in `fetch`, so banning `fetch`
 * inside a transaction covers the port surface without a false-positive-prone
 * method-name heuristic.
 *
 * Syntactic only: a `fetch` lexically inside any `.transaction(callback)` in a
 * backend source file (test files excluded) fails the build.
 */

function isFetchCall(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return callee.getText() === 'fetch';
  if (Node.isPropertyAccessExpression(callee)) {
    return (
      callee.getName() === 'fetch' &&
      ['globalThis', 'self', 'window'].includes(callee.getExpression().getText())
    );
  }
  return false;
}

function isTransactionCall(call: CallExpression): boolean {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee) && callee.getName() === 'transaction';
}

const EXTERNAL_IN_TX_MESSAGE =
  'external call (fetch) inside a db.transaction() callback — a plain transaction admits no external calls; keep the external effect outside the tx (pattern D: byExternalPreClaim).';

/** Every `fetch` lexically inside this call's transaction callback (empty when
 * the call is not a `.transaction(callback)`). */
function fetchesInTransaction(call: CallExpression, filePath: string): ArchViolation[] {
  if (!isTransactionCall(call)) return [];
  const callback = call.getArguments()[0];
  if (callback === undefined) return [];
  return callback
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((inner) => isFetchCall(inner))
    .map((inner) => ({
      file: filePath,
      line: inner.getStartLineNumber(),
      message: EXTERNAL_IN_TX_MESSAGE,
    }));
}

const rule: ArchRule = {
  name: 'no-external-call-in-transaction',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath().replace(/^\//, '');
      if (!filePath.includes('apps/api/src/')) continue;
      if (filePath.endsWith('.test.ts')) continue;
      for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        violations.push(...fetchesInTransaction(call, filePath));
      }
    }
    return violations;
  },
};

export default rule;
