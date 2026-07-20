import type { SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Keeps the E2E localStorage export-key fallback (`device-key-store.e2e.ts`) out
 * of the production main chunk. That module deliberately persists the OPAQUE
 * export key as base64 in localStorage so Playwright `storageState` can capture
 * it — a plaintext-key path that must never ship to real users. Its only
 * production reachability is the `env.isE2E`-gated DYNAMIC `import()` inside
 * `device-key-store.ts`, which code-splits it into a lazy chunk. Nothing
 * structural stops a future refactor from adding a STATIC
 * `import … from '.../device-key-store.e2e'` and silently bundling the fallback
 * into production. This rule makes that leak an error.
 *
 * Static vs dynamic is a syntactic distinction needing no type resolution: a
 * static `import … from '…'` is an `ImportDeclaration`; a dynamic `import('…')`
 * is an `ImportExpression` (a call form). Iterating `getImportDeclarations()`
 * sees only the former, so the gated dynamic loader in `device-key-store.ts` is
 * passed by construction — never enumerated, never flagged.
 *
 * Scope (production web code) excludes:
 *   - the e2e module itself (`device-key-store.e2e.*`) — its own sibling imports
 *     are already inside the isolated module.
 *   - test files — they import the e2e module to test it in isolation.
 *   - everything outside `apps/web/src/`.
 */

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const WEB_SRC = 'apps/web/src/';
const E2E_MODULE_FILE = /device-key-store\.e2e\.[cm]?[jt]sx?$/;

/** The e2e store module reference: a relative/alias specifier whose basename is
 * `device-key-store.e2e`, with an optional `.js`/`.ts` extension. */
const E2E_MODULE_SPECIFIER = /(^|\/)device-key-store\.e2e(\.[jt]s)?$/;

/** Production web code: inside apps/web/src, not the e2e module or a test file. */
function isProductionWebFile(filePath: string): boolean {
  return filePath.includes(WEB_SRC) && !E2E_MODULE_FILE.test(filePath) && !TEST_FILE.test(filePath);
}

/** A relative (`.`) or `@/`-alias specifier resolving to the e2e store module. */
function targetsE2eStore(specifier: string): boolean {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return false;
  return E2E_MODULE_SPECIFIER.test(specifier);
}

function e2eStoreImportViolations(sourceFile: SourceFile): ArchViolation[] {
  const filePath = sourceFile.getFilePath();
  // Both static `import … from '…'` (ImportDeclaration) and static
  // `export … from '…'` / `export * from '…'` (ExportDeclaration) statically
  // bundle their target. A bare `export { x }` re-exporting a local binding has
  // no module specifier (getModuleSpecifierValue() is undefined) — skip it.
  // Dynamic `import('…')` is an ImportExpression, enumerated by neither, so the
  // gated loader in device-key-store.ts stays exempt by construction.
  const specifiers: { specifier: string | undefined; line: number }[] = [
    ...sourceFile.getImportDeclarations().map((decl) => ({
      specifier: decl.getModuleSpecifierValue(),
      line: decl.getStartLineNumber(),
    })),
    ...sourceFile.getExportDeclarations().map((decl) => ({
      specifier: decl.getModuleSpecifierValue(),
      line: decl.getStartLineNumber(),
    })),
  ];
  return specifiers
    .filter((s) => s.specifier !== undefined && targetsE2eStore(s.specifier))
    .map((s) => ({
      file: filePath,
      line: s.line,
      message:
        'Production code must not statically import or re-export the E2E export-key store ' +
        '(apps/web/src/lib/device-key-store.e2e) — it may only be reached via the ' +
        'env.isE2E-gated dynamic import() in device-key-store.ts. A static import or re-export ' +
        'would bundle the plaintext-key localStorage fallback into the production chunk.',
    }));
}

const rule: ArchRule = {
  name: 'e2e-store-isolation',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      if (!isProductionWebFile(sourceFile.getFilePath())) continue;
      violations.push(...e2eStoreImportViolations(sourceFile));
    }
    return violations;
  },
};

export default rule;
