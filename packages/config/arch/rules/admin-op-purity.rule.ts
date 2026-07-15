import path from 'node:path';
import { Node } from 'ts-morph';
import type { ImportDeclaration, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Admin op-body purity (the admin slice's Charter #2, structurally
 * enforced). Two halves:
 *
 * 1. Op-body modules (`slices/admin/domain/operations/`, non-test) may not
 *    value-import infra libraries or adapter modules, may not reach into
 *    another slice's internals (barrel imports only), and may not call
 *    `fetch` — an op body composes published `*WithinTx` helpers on the
 *    engine-owned `SettlementTx` and nothing else. This is also what makes
 *    preview's rollback total: no external side-effect can exist inside the
 *    transaction.
 * 2. Op executions are imported only by the admin registry wiring (files in
 *    `slices/admin/domain/`), sibling op modules, and tests — no other code
 *    can invoke an op around the engine's audit/guardrail/idempotency path.
 */

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Infra packages an op body must never value-import (adapters' territory). */
const INFRA_IMPORT =
  /^(?:drizzle-orm|@hushbox\/db|@neondatabase|@upstash|resend|aws4fetch|cockatiel)(?:\/|$)/;

/** Another slice's internals: any slices/<name>/ path segment past the barrel. */
const CROSS_SLICE_INTERNAL = /\/slices\/(?!admin\/)[^/]+\/(?!index(?:\.[cm]?[jt]s)?$).+/;

function violation(file: SourceFile, node: Node, message: string): ArchViolation {
  return {
    file: file.getFilePath(),
    line: node.getStartLineNumber(),
    message,
  };
}

/** Resolves a relative specifier against the importing file (posix-normalized). */
function resolvedSpecifier(file: SourceFile, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  return path.posix.normalize(path.posix.join(path.posix.dirname(file.getFilePath()), specifier));
}

function checkOpBodyImport(
  file: SourceFile,
  declaration: ImportDeclaration,
  violations: ArchViolation[]
): void {
  if (declaration.isTypeOnly()) return;
  const specifier = declaration.getModuleSpecifierValue();
  if (INFRA_IMPORT.test(specifier)) {
    violations.push(
      violation(file, declaration, `admin op body must not import infra library '${specifier}'`)
    );
    return;
  }
  const resolved = resolvedSpecifier(file, specifier);
  if (resolved.includes('/adapters/')) {
    violations.push(
      violation(file, declaration, `admin op body must not import adapter module '${specifier}'`)
    );
    return;
  }
  if (CROSS_SLICE_INTERNAL.test(resolved)) {
    violations.push(
      violation(
        file,
        declaration,
        `admin op body must not reach into another slice's internals ('${specifier}') — import the slice barrel`
      )
    );
  }
}

function checkOpBodyFetch(file: SourceFile, violations: ArchViolation[]): void {
  file.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    const isBareFetch = Node.isIdentifier(callee) && callee.getText() === 'fetch';
    const isGlobalFetch =
      Node.isPropertyAccessExpression(callee) &&
      callee.getName() === 'fetch' &&
      ['globalThis', 'self', 'window'].includes(callee.getExpression().getText());
    if (isBareFetch || isGlobalFetch) {
      violations.push(
        violation(file, node, 'admin op body must not call fetch (no external calls in op bodies)')
      );
    }
  });
}

function checkOpImporter(file: SourceFile, violations: ArchViolation[]): void {
  const filePath = file.getFilePath();
  // Registry wiring and everything else under the admin domain (the engine,
  // the battery harness) may import ops; so may op siblings and tests.
  if (filePath.includes('apps/api/src/slices/admin/domain/')) return;
  for (const declaration of file.getImportDeclarations()) {
    const resolved = resolvedSpecifier(file, declaration.getModuleSpecifierValue());
    if (
      resolved.includes('apps/api/src/slices/admin/domain/operations/') ||
      resolved.includes('/admin/domain/operations/')
    ) {
      violations.push(
        violation(
          file,
          declaration,
          'admin op executions are imported only by the admin registry wiring (slices/admin/domain), never invoked directly'
        )
      );
    }
  }
}

const rule: ArchRule = {
  name: 'admin-op-purity',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const file of project.getSourceFiles()) {
      const filePath = file.getFilePath();
      if (TEST_FILE.test(filePath)) continue;
      if (filePath.includes('apps/api/src/slices/admin/domain/operations/')) {
        for (const declaration of file.getImportDeclarations()) {
          checkOpBodyImport(file, declaration, violations);
        }
        checkOpBodyFetch(file, violations);
        continue;
      }
      checkOpImporter(file, violations);
    }
    return violations;
  },
};

export default rule;
