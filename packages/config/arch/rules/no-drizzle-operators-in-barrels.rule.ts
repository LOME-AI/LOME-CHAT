import type { ExportDeclaration, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Closes the operator-laundering hole the ESLint `boundaries/dependencies`
 * boundary cannot see. That boundary forbids slice `domain/` code from importing
 * `drizzle-orm`, but it matches by module *specifier*, not by capability: a
 * package barrel that re-exports Drizzle query operators lets domain code import
 * them from `@hushbox/db` instead, passing the boundary in letter while
 * defeating its intent. ESLint has no view of a barrel's resolved surface; this
 * structural rule does.
 *
 * A barrel (`packages/<pkg>/src/index.ts`) violates the rule when it either:
 *   - re-exports anything from `'drizzle-orm'` (`export * from 'drizzle-orm'` or
 *     `export { … } from 'drizzle-orm'`), or
 *   - surfaces a Drizzle query-operator symbol re-exported through any module
 *     (`export { eq } from './x'`) — matched on the source name, so a benign
 *     alias cannot hide the operator.
 *
 * The check stays syntactic (no `getType()`): it inspects the barrel's own
 * export declarations only. A local `export * from './formatting.js'` is not
 * followed — operators are never defined inside a first-party module, so the two
 * direct routes above are the practical closure. The remedy is to keep operators
 * in adapters, never on a published barrel.
 */

/** Drizzle query operators that must never reach domain code via a barrel. */
const OPERATORS = new Set<string>([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'and',
  'or',
  'not',
  'inArray',
  'notInArray',
  'isNull',
  'isNotNull',
  'like',
  'ilike',
  'between',
  'sql',
  'asc',
  'desc',
]);

const BARREL_PATH = /\/packages\/[^/]+\/src\/index\.ts$/;

const REMEDY =
  're-exporting Drizzle operators from a package barrel launders them into domain/ past the boundaries/dependencies boundary (which matches specifiers, not capabilities) — operators belong in adapters.';

function violationsFor(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const declaration of sourceFile.getExportDeclarations()) {
    violations.push(...declarationViolations(declaration, filePath));
  }
  return violations;
}

function declarationViolations(declaration: ExportDeclaration, filePath: string): ArchViolation[] {
  const line = declaration.getStartLineNumber();
  if (declaration.getModuleSpecifierValue() === 'drizzle-orm') {
    const named = declaration.getNamedExports();
    if (named.length === 0) {
      return [{ file: filePath, line, message: reexportMessage('*') }];
    }
    return named.map((specifier) => ({
      file: filePath,
      line: specifier.getStartLineNumber(),
      message: reexportMessage(specifier.getName()),
    }));
  }

  const violations: ArchViolation[] = [];
  for (const specifier of declaration.getNamedExports()) {
    const sourceName = specifier.getName();
    const outwardName = specifier.getAliasNode()?.getText() ?? sourceName;
    if (OPERATORS.has(sourceName) || OPERATORS.has(outwardName)) {
      violations.push({
        file: filePath,
        line: specifier.getStartLineNumber(),
        message: `Barrel surfaces Drizzle query operator "${sourceName}" — ${REMEDY}`,
      });
    }
  }
  return violations;
}

function reexportMessage(symbol: string): string {
  return `Barrel re-exports "${symbol}" from 'drizzle-orm' — ${REMEDY}`;
}

const rule: ArchRule = {
  name: 'no-drizzle-operators-in-barrels',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath().replace(/^\//, '');
      if (!BARREL_PATH.test('/' + filePath)) continue;
      violations.push(...violationsFor(sourceFile, filePath));
    }
    return violations;
  },
};

export default rule;
