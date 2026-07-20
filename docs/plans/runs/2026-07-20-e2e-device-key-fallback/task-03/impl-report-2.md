# Task-03 — Arch rule: e2e-store isolation — impl-report-2 (fix)

## Objective
Fix two validated audit findings on `e2e-store-isolation.rule.ts`:
1. [Important] Re-exports (`export … from` / `export * from`) of the e2e module passed unflagged — only `getImportDeclarations()` was scanned. Also scan `getExportDeclarations()`, run them through the same specifier matcher, keep the dynamic `import()` exemption intact.
2. [Minor] The bare-specifier early-return branch (`!startsWith('.') && !startsWith('@/')`) was unexercised, leaving the file below GC6's per-file 95%. Add a covering test.

## Files changed
- `packages/config/arch/rules/e2e-store-isolation.rule.ts` — `e2eStoreImportViolations` now merges import + export declarations, filters out specifier-less declarations, and reuses `targetsE2eStore`; message updated to name re-export. Import type `ImportDeclaration` dropped (no longer referenced).
- `packages/config/arch/rules/e2e-store-isolation.rule.test.ts` — 5 new cases (see below).

## ExportDeclaration-scan code added (verbatim)
```ts
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
```
`ExportDeclaration.getModuleSpecifierValue()` returns `string | undefined`; a bare `export { localVar }` yields `undefined` and is filtered out (never crashes, never flagged). Dynamic `import()` is an `ImportExpression`, enumerated by neither `getImportDeclarations()` nor `getExportDeclarations()`, so the gated loader stays exempt by construction.

## Tests added — name — behavior — RED observed
- `flags a named re-export of the e2e store from production code` — `export { storeExportKeyProtected } from './device-key-store.e2e.js'` in a prod file IS flagged (1 violation, file:line 1, message contains `device-key-store.ts`). **RED:** `expected [] to have a length of 1 but got +0` (re-export not scanned).
- `flags a star re-export of the e2e store from production code` — `export * from './device-key-store.e2e.js'` IS flagged. **RED:** `expected [] to have a length of 1 but got +0`.
- `does not flag a bare export with no module specifier` — `export { localVar }` (no `from`) does not crash / is not flagged. Passed pre-fix (no crash) and post-fix (filtered by `specifier !== undefined`).
- `does not flag a production import of a bare/package specifier` — `import { useState } from 'react'` is NOT flagged. Exercises the `targetsE2eStore` bare-specifier early-return branch (finding 2). Passed both pre/post — added purely for the uncovered branch.
- `exempts test files that re-export the e2e store` — `reexport.test.ts` re-exporting the e2e module is NOT flagged (TEST_FILE exemption applies to re-exports too).

All 7 prior cases kept green (static flagged, alias flagged, dynamic exempt, test-file static exempt, module self, unrelated, out-of-tree).

## Self-gate
- `npx tsx scripts/with-env.ts vitest run packages/config/arch/rules/e2e-store-isolation.rule.test.ts` (repo root) — **pass** — 12/12.
- Per-file coverage of `e2e-store-isolation.rule.ts` — **Statements 100% (22/22), Branches 100% (11/11), Functions 100% (8/8), Lines 100% (20/20)** — ≥95% on stmts AND branches. (via `vitest run --coverage --coverage.include='arch/rules/e2e-store-isolation.rule.ts'`.)
- `npx tsx packages/config/arch/run.ts` (== `pnpm arch:check`) — **pass** — `arch:check: OK — 11 rule(s) over 1811 file(s)`, exit 0. New ExportDeclaration scan flags nothing real (no production re-export of the e2e module exists today).
- `npx eslint arch/rules/e2e-store-isolation.rule.ts arch/rules/e2e-store-isolation.rule.test.ts` (from packages/config) — **pass** — exit 0 after final edit (2 prettier issues auto-fixed, re-verified clean).
- `npx turbo typecheck --filter=@hushbox/config` — **pass** — tsgo `--noEmit` clean.

## Acceptance criteria
1. Re-exports flagged with same file:line + invariant message — **met** (both named and star re-export tests green; message updated to name re-export).
2. Dynamic `import()` exemption intact — **met** (dynamic-import test still green; ImportExpression enumerated by neither collector).
3. Bare export with no specifier not crashed / not flagged — **met**.
4. Per-file ≥95% stmts AND branches — **met** (100%/100%).
5. Real `arch:check` still exit 0 — **met**.

## Deviations
None.

## Concerns and limitations
None.

## Confidence
high — both findings fixed test-first with observed RED for the re-export cases, per-file coverage at 100%/100%, and all five self-gates green including real-repo arch:check.
