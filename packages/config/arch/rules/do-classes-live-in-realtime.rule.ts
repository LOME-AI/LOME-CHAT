import { Node } from 'ts-morph';
import type { Expression, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Seed of the thin-shell Durable Object rule family (the thin-shell DO is the
 * default pattern, enforced by an arch rule).
 *
 * This is the checkable ownership half: DO classes are platform glue owned
 * by `packages/realtime` — a class extending DurableObject must never be
 * declared inside a slice (slices contribute behavior the DO hosts, not the
 * class itself). The family grows body-shape ("platform glue only") checks
 * once the backend's own DO classes exist.
 *
 * Detection resolves local aliases syntactically (the harness stays
 * type-checker-free): a named-import alias of DurableObject, a namespace
 * member access ending in .DurableObject, and same-file `const X = <alias>`
 * chains all count as DurableObject — the bare name alone would be trivially
 * evadable via `import { DurableObject as DO }`.
 */

/** Matches `anything.DurableObject` (namespace or re-exported member access). */
function isDurableObjectMember(expression: Expression): boolean {
  return Node.isPropertyAccessExpression(expression) && expression.getName() === 'DurableObject';
}

function namedImportAliases(sourceFile: SourceFile, names: Set<string>): void {
  for (const importDeclaration of sourceFile.getImportDeclarations()) {
    for (const specifier of importDeclaration.getNamedImports()) {
      if (specifier.getName() === 'DurableObject') {
        names.add((specifier.getAliasNode() ?? specifier.getNameNode()).getText());
      }
    }
  }
}

/** Fixed point over `const X = <known alias | ns.DurableObject>` chains. */
function variableAliases(sourceFile: SourceFile, names: Set<string>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of sourceFile.getVariableDeclarations()) {
      const initializer = declaration.getInitializer();
      if (!initializer || names.has(declaration.getName())) continue;
      if (
        (Node.isIdentifier(initializer) && names.has(initializer.getText())) ||
        isDurableObjectMember(initializer)
      ) {
        names.add(declaration.getName());
        changed = true;
      }
    }
  }
}

/** Every local name bound to DurableObject, including the bare global name. */
function durableObjectLocalNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>(['DurableObject']);
  namedImportAliases(sourceFile, names);
  variableAliases(sourceFile, names);
  return names;
}

function extendsDurableObject(expression: Expression, localNames: Set<string>): boolean {
  return (
    (Node.isIdentifier(expression) && localNames.has(expression.getText())) ||
    isDurableObjectMember(expression)
  );
}

const rule: ArchRule = {
  name: 'do-classes-live-in-realtime',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath().replace(/^\//, '');
      if (!filePath.includes('src/slices/')) continue;
      const localNames = durableObjectLocalNames(sourceFile);
      for (const classDeclaration of sourceFile.getClasses()) {
        const extendsExpression = classDeclaration.getExtends()?.getExpression();
        if (extendsExpression && extendsDurableObject(extendsExpression, localNames)) {
          violations.push({
            file: filePath,
            line: classDeclaration.getStartLineNumber(),
            message:
              'DurableObject classes are platform glue owned by packages/realtime — slices must not declare them.',
          });
        }
      }
    }
    return violations;
  },
};

export default rule;
