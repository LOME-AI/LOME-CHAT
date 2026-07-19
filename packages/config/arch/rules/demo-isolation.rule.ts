import type { ImportDeclaration, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Pins the interactive product demo out of the production main chunk (audit fix
 * F-15). The demo boots the real app with a faked logged-in session and a
 * global network shim (`demo/seed-session`, `demo/mock-backend/fetch-shim`); it
 * is isolated only by `main.tsx`'s `isDemoPath`-gated DYNAMIC `import()`, which
 * code-splits the whole `demo/**` tree into a lazy chunk that never loads for
 * real users. Nothing structural stops a future refactor from adding a STATIC
 * `import … from '.../demo/…'` in production code and silently bundling the
 * fake-auth bypass into the main chunk. This rule makes that leak an error.
 *
 * Static vs dynamic is a syntactic distinction with no type resolution: a static
 * `import … from '…'` is an `ImportDeclaration`; a dynamic `import('…')` is an
 * `ImportExpression` (a call form). Iterating `getImportDeclarations()` sees only
 * the former, so `main.tsx`'s dynamic demo import is passed by construction —
 * never enumerated, never flagged.
 *
 * Scope (production web code) excludes:
 *   - demo-internal files (`apps/web/src/demo/**`) — a demo file importing
 *     another demo file is the intended shape, already inside the lazy chunk.
 *   - test files — they import demo internals to test them in isolation.
 *   - everything outside `apps/web/src/`.
 * The `is-demo-path` helper (`apps/web/src/lib/is-demo-path.ts`) is NOT the demo
 * directory: a specifier targets the demo tree only when a whole path segment is
 * exactly `demo`, so `@/lib/is-demo-path` (segment `is-demo-path`) never matches.
 */

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const WEB_SRC = 'apps/web/src/';
const DEMO_DIR = 'apps/web/src/demo/';

/** Production web code: inside apps/web/src, not a demo-internal or test file. */
function isProductionWebFile(filePath: string): boolean {
  return filePath.includes(WEB_SRC) && !filePath.includes(DEMO_DIR) && !TEST_FILE.test(filePath);
}

/**
 * A relative (`.`) or `@/`-alias specifier whose path resolves into the demo
 * directory — identified by a whole `demo` path segment, so `is-demo-path`
 * (segment `is-demo-path`) is excluded.
 */
function targetsDemoDirectory(specifier: string): boolean {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return false;
  return specifier.split('/').includes('demo');
}

function demoImportViolations(sourceFile: SourceFile): ArchViolation[] {
  const filePath = sourceFile.getFilePath();
  return sourceFile
    .getImportDeclarations()
    .filter((decl: ImportDeclaration) => targetsDemoDirectory(decl.getModuleSpecifierValue()))
    .map((decl) => ({
      file: filePath,
      line: decl.getStartLineNumber(),
      message:
        'Production code must not statically import the demo tree (apps/web/src/demo/**) — ' +
        "it loads only via main.tsx's dynamic import() so the fake-session bypass stays out " +
        'of the production bundle (audit fix F-15).',
    }));
}

const rule: ArchRule = {
  name: 'demo-isolation',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      if (!isProductionWebFile(sourceFile.getFilePath())) continue;
      violations.push(...demoImportViolations(sourceFile));
    }
    return violations;
  },
};

export default rule;
