import { SyntaxKind } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Keeps E2E-only module variants (`*.e2e.ts`, e.g. the localStorage export-key
 * fallback `device-key-store.e2e.ts`) out of production web code entirely. That
 * store deliberately persists the OPAQUE export key as base64 in localStorage
 * so Playwright `storageState` can capture it — a plaintext-key path that must
 * never ship to real users.
 *
 * No source-level reference is permitted, static OR dynamic:
 *   - A static `import`/`export … from` would bundle the fallback into the
 *     production chunk.
 *   - A runtime dynamic `import()` is a cancellable network fetch; on the
 *     auth-bootstrap path a racing navigation aborts the chunk request, the
 *     import() rejects uncaught, and the router's CatchBoundary blanks the
 *     page. The variant is selected at BUILD time instead: the Vite resolver
 *     plugin (apps/web vite config + device-key-store-e2e-resolution) swaps the
 *     module id when the build bakes `VITE_E2E`, so the e2e build inlines the
 *     variant into the entry chunk and the production build never references it.
 *
 * Scope (production web code) excludes:
 *   - `*.e2e.*` module files themselves — sibling imports stay inside the
 *     isolated variant tier.
 *   - test files — they import e2e modules to test them in isolation.
 *   - everything outside `apps/web/src/`.
 */

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const WEB_SRC = 'apps/web/src/';
const E2E_MODULE_FILE = /\.e2e\.[cm]?[jt]sx?$/;

/** An e2e module reference: a relative/alias specifier whose basename ends in
 * `.e2e`, with an optional `.js`/`.ts` extension. */
const E2E_MODULE_SPECIFIER = /(^|\/)[^/]+\.e2e(\.[jt]s)?$/;

const MESSAGE =
  'Production code must not reference an E2E module variant (*.e2e) — neither a static ' +
  'import/re-export (which bundles it into the production chunk) nor a runtime dynamic ' +
  'import() (a cancellable chunk fetch that a racing navigation turns into an uncaught ' +
  'rejection). The variant is selected at build time by the Vite resolver plugin gated on ' +
  'the baked VITE_E2E env (see apps/web vite config), which is the only sanctioned path.';

/** Production web code: inside apps/web/src, not an e2e module or a test file. */
function isProductionWebFile(filePath: string): boolean {
  return filePath.includes(WEB_SRC) && !E2E_MODULE_FILE.test(filePath) && !TEST_FILE.test(filePath);
}

/** A relative (`.`) or `@/`-alias specifier resolving to an e2e module. */
function targetsE2eModule(specifier: string): boolean {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return false;
  return E2E_MODULE_SPECIFIER.test(specifier);
}

function e2eStoreImportViolations(sourceFile: SourceFile): ArchViolation[] {
  const filePath = sourceFile.getFilePath();
  // Static `import … from '…'` (ImportDeclaration) and static
  // `export … from '…'` / `export * from '…'` (ExportDeclaration) statically
  // bundle their target. A bare `export { x }` re-exporting a local binding has
  // no module specifier (getModuleSpecifierValue() is undefined) — skip it.
  const specifiers: { specifier: string | undefined; line: number }[] = [
    ...sourceFile.getImportDeclarations().map((decl) => ({
      specifier: decl.getModuleSpecifierValue(),
      line: decl.getStartLineNumber(),
    })),
    ...sourceFile.getExportDeclarations().map((decl) => ({
      specifier: decl.getModuleSpecifierValue(),
      line: decl.getStartLineNumber(),
    })),
    // Dynamic `import('…')` is a CallExpression whose callee is the `import`
    // keyword. Only string-literal arguments are checkable; a computed
    // specifier cannot target a co-located e2e module without also tripping
    // bundler resolution, so non-literals are skipped rather than guessed at.
    ...sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getKind() === SyntaxKind.ImportKeyword)
      .map((call) => ({
        specifier: call.getArguments()[0]?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue(),
        line: call.getStartLineNumber(),
      })),
  ];
  return specifiers
    .filter((s) => s.specifier !== undefined && targetsE2eModule(s.specifier))
    .map((s) => ({ file: filePath, line: s.line, message: MESSAGE }));
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
