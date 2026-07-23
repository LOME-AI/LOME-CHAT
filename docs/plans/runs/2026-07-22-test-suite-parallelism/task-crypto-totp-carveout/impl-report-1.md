# impl-report-1 — optimizer carve-out for crypto totp test

## Objective

Keep `deps.optimizer.ssr` enabled globally for `packages/crypto`, but run the single file
`src/totp.test.ts` in a dedicated project with the SSR optimizer OFF (its
`vi.importActual('otplib')` of an external ESM dep breaks under the optimizer's URL
rewriting → `ERR_MODULE_NOT_FOUND`, failing even on a fresh cache). The file must execute
exactly once; the optimizer stays on for every other crypto test.

## Files changed

- `packages/crypto/vitest.config.ts` — converted from a single `defineProject` to a
  `defineConfig` with a `test.projects` array. Main project `crypto` (node env,
  `testTimeout: 30_000`, as before) now excludes `OPTIMIZER_OFF_FILES`; new `crypto-noopt`
  project (`extends: true`, node env, `testTimeout: 30_000`, `include: OPTIMIZER_OFF_FILES`,
  `deps.optimizer.ssr.enabled: false`) runs only that file. Added the explanatory comment on
  the const and the noopt project, mirroring the api precedent.

## Design decisions

- One `const OPTIMIZER_OFF_FILES = ['src/totp.test.ts']` referenced by both the noopt
  `include` and the main `exclude` — no duplicated path literals (One-Implementation-Shared).
- Main project `exclude` mirrors the verified api precedent’s minimal form
  (`['**/dist/**', '**/node_modules/**', ...OPTIMIZER_OFF_FILES]`). Verified crypto has no
  `*.workers.test.ts`, `__test-fixtures-*__`, or `e2e/` files under `src/`, so the root
  exclude’s special entries match nothing here — dropping them changes no collected set.
- Switched `defineProject` → `defineConfig` because a `test.projects` array is a
  root/workspace-level construct (`defineProject` cannot host nested projects); this is
  exactly the shape the api config uses and it is already matched by the same
  `apps|packages/*/vitest.config.ts` workspace glob.
- Crypto main sets no `globals` (tests import `describe/it/expect/vi` from `vitest`
  directly — `src/totp.test.ts:1`), so neither project sets `globals`.

## Self-gate

- `pnpm ensure-stack` — pass (Stack ready).
- `pnpm exec tsx scripts/with-env.ts vitest run --root packages/crypto src/totp.test.ts`
  — pass: `Test Files 1 passed (1)`, `Tests 28 passed (28)`.
- Optimizer-off-took-effect proof (throwaway config with the optimizer ON, since deleted):
  same file fails `1 failed | 27 passed`, `Serialized Error: { code: 'ERR_MODULE_NOT_FOUND' }`
  + `Failed to resolve dependency: @hushbox/db, present in ssr 'optimizeDeps.include'`. Green
  under the carve-out therefore proves the per-project optimizer-off is what fixes it.
- `pnpm exec turbo typecheck lint --filter=@hushbox/crypto --force` — pass: 2 successful,
  2 total (forced, cache bypassed, so the new config was actually linted/typechecked).

## No-double-run evidence

`vitest list --root packages/crypto` (grep for `totp.test.ts`):

- `--project crypto` — 0 lines for `totp.test.ts` (excluded from main).
- `--project crypto-noopt` — lists `src/totp.test.ts` (28 cases).
- across all projects — `28 [crypto-noopt] src/totp.test.ts`, and no other project.

Conclusion: `src/totp.test.ts` resolves to exactly one project (`crypto-noopt`); no double-run.

## Acceptance criteria

- Config converted to `test.projects` with main `crypto` project (existing settings) — met.
- New `crypto-noopt` project, optimizer off, includes only `src/totp.test.ts` — met.
- `src/totp.test.ts` excluded from main so it runs exactly once — met (list evidence).
- Single `OPTIMIZER_OFF_FILES` const referenced by both include and exclude — met.
- One-line explanatory comment mirroring api — met.
- Optimizer NOT disabled package-wide (only this file) — met (main project keeps root
  optimizer on).
- `totp.test.ts` green; typecheck + lint clean — met.

## Deviations

- None.

## Concerns and limitations

- None. Change is confined to `packages/crypto/vitest.config.ts`.

## Confidence

high — verified green run, direct negative proof of the failure mode with the optimizer on,
per-project list confirms single assignment, forced typecheck+lint clean.
