# Task-03 — Arch rule: e2e-store isolation — impl-report-1

## Objective
Add a structural arch rule that forbids production `apps/web/src` code from **statically** importing the E2E localStorage export-key fallback module (`device-key-store.e2e`), while allowing the gated **dynamic** `import()` in `device-key-store.ts` to pass by construction. Mirror `demo-isolation.rule.ts`.

## Files changed (both new)
- `packages/config/arch/rules/e2e-store-isolation.rule.ts` — the rule: default-exported `ArchRule { name: 'e2e-store-isolation', check }`, syntactic only (no `getType()`).
- `packages/config/arch/rules/e2e-store-isolation.rule.test.ts` — co-located in-memory ts-morph unit test (7 cases).

## Matching logic / AST distinction
- **AST distinction (the crux):** a static `import … from '…'` is an `ImportDeclaration`; a dynamic `import('…')` is an `ImportExpression` (call form). The rule iterates only `sourceFile.getImportDeclarations()`, so dynamic imports are never enumerated → never flagged. This is exactly why Task-02's `env.isE2E`-gated `await import('./device-key-store.e2e.js')` passes without any special-casing.
- **Scope (`isProductionWebFile`):** path includes `apps/web/src/`, AND is not the e2e module itself (`/device-key-store\.e2e\.[cm]?[jt]sx?$/`), AND is not a test file (`/\.(test|spec)\.[cm]?[jt]sx?$/`).
- **Specifier match (`targetsE2eStore`):** specifier must start with `.` or `@/` (relative/alias, mirroring demo), AND match `/(^|\/)device-key-store\.e2e(\.[jt]s)?$/` — i.e. basename `device-key-store.e2e` with optional `.js`/`.ts` extension.
- **Violation message:** names file:line (from `decl.getStartLineNumber()`) and states the invariant — the E2E store may only be reached via the `env.isE2E`-gated dynamic import in `device-key-store.ts`; a static import would bundle the plaintext-key localStorage fallback into the production chunk.

## Tests added (name — behavior — RED observed)
Initial RED for the whole suite: `Cannot find module './e2e-store-isolation.rule.js'` (rule not yet implemented) — verified before writing the rule.
- `flags a static import of the e2e store from production code` — static `ImportDeclaration` in a prod file IS flagged (1 violation, correct file:line, message mentions `device-key-store.ts`). Covers criterion 1 (flag) + 2 (message).
- `flags a static import of the e2e store via the @/ alias` — `@/lib/device-key-store.e2e` (no extension) IS flagged.
- `passes the gated dynamic import of the e2e store (the loader in device-key-store.ts)` — `await import('./device-key-store.e2e.js')` is NOT flagged. Covers criterion 1 (dynamic exemption).
- `exempts test files that statically import the e2e store` — a `*.test.ts` static importer is NOT flagged. Covers criterion 3 (test exemption).
- `does not flag the e2e module importing its own siblings` — the module itself is out of scope.
- `does not flag an unrelated import` — `@/lib/env` not flagged.
- `ignores files outside the apps/web/src tree` — an `apps/api` importer not flagged.

After implementing the rule: all 7 pass (GREEN).

## Self-gate
- `npx vitest run arch/rules/e2e-store-isolation.rule.test.ts` (from packages/config) — **pass** — 7/7.
- `npx eslint arch/rules/e2e-store-isolation.rule.{ts,test.ts}` (from packages/config) — **pass** — exit 0 after final edit (3 prettier issues auto-fixed, re-verified clean).
- `npx turbo typecheck --filter=@hushbox/config` — **pass** — tsgo `--noEmit` clean.
- `npx tsx packages/config/arch/run.ts` (== `pnpm arch:check`) against the real repo — **pass** — `arch:check: OK — 11 rule(s) over 1811 file(s)`, exit 0. My rule is included (11 vs the prior 10) and flags nothing real: no production static importer exists (Task-02 not yet landed / uses dynamic import), and the e2e module's own test static import is exempt.

## Acceptance criteria
1. Rule mirrors `demo-isolation.rule.ts`, `ArchRule { name, check }`, syntactic only, static flagged / dynamic exempt — **met** (see matching logic; dynamic-import test green).
2. Message names file:line + isolation invariant — **met**.
3. Co-located in-memory ts-morph test: static prod flagged, dynamic not flagged, test-file static not flagged — **met** (plus alias / out-of-tree / unrelated / module-self coverage).
4. Default-exported, harness-discovered, real `arch:check` passes — **met** (11 rules, exit 0).

## Deviations
None.

## Concerns and limitations
- The specifier matcher requires a `.`/`@/` prefix (mirrors demo-isolation). A bare-package specifier like `apps/web/src/lib/device-key-store.e2e` would not match, but web code imports the module only via relative or `@/` alias, so this matches the real import surface.
- Extension match covers `.js`/`.ts` (per brief); a hypothetical `.jsx`/`.tsx` specifier for this `.ts` module would not match, which is a non-case.

## Confidence
high — rule mirrors the proven demo-isolation template, all four self-gates pass including the real-repo `arch:check`, and the ImportDeclaration-vs-ImportExpression distinction guaranteeing Task-02's dynamic loader passes is directly test-pinned.
