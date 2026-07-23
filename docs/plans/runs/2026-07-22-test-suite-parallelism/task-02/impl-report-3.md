# impl-report-3 — BT1 CLEANUP: drop dead HB_MAX_CONCURRENCY child-env var

## Objective
Spec amended: the design DROPPED `HB_MAX_CONCURRENCY`; `maxConcurrency` stays hardcoded at
12 in the shared vitest config, so the wrapper setting `HB_MAX_CONCURRENCY=12` in the child
env is dead code (nothing reads it). Remove the assignment and the test assertion(s) that
check for it. Change nothing else.

## Files changed
- `scripts/run-package-tests.ts` — removed the `const childEnv = { ...env, HB_MAX_CONCURRENCY:
  String(MAX_CONCURRENCY) }` line; `deps.exec(vitestArgs, ...)` now receives `env` directly.
  The `MAX_CONCURRENCY` constant remains (still used in the print line's `maxConcurrency=...`
  label, unchanged). `computeMaxWorkers`, `listTestPackages`, weight capture, `--maxWorkers`
  injection, passthrough, print line, exit-code propagation all untouched.
- `scripts/run-package-tests.test.ts` — the solo test's exec assertion changed from
  `expect.objectContaining({ HB_MAX_CONCURRENCY: '12' })` to
  `expect.objectContaining({ HB_TEST_SCOPE: 'solo' })`, so it still pins that `env` is
  forwarded to the child unmodified, now via a key that actually appears in the passed env.

## Self-gate
- `grep -rn HB_MAX_CONCURRENCY` on both files — no matches (exit 1). Confirmed gone.
- scripts-project typecheck (`pnpm run typecheck` in `scripts/` → `tsgo --noEmit`) — pass
  (exit 0).
- `eslint run-package-tests.ts run-package-tests.test.ts` (from `scripts/`) — pass, 0 issues.
- `vitest run run-package-tests.test.ts --coverage` — pass, 25/25 tests, success:true.
- File coverage (from `coverage/coverage-final.json`): statements 72/72, functions 11/11,
  branches 44/44 = 100%. Statement count 73→72 (removed the childEnv assignment); no branch
  added or left uncovered, so no test adjustment was needed for coverage.

## Root repo-wide `pnpm run typecheck` note
Fails, but NOT from this change: `apps/api/src/middleware/pipeline-bindings.ts(59,29): error
TS2304: Cannot find name 'ExecutionContext'` — a file outside my ownership that I never
touched (my pre-edit `git status` showed only `scripts/run-package-tests.ts`,
`scripts/run-package-tests.test.ts`, `scripts/e2e/` under scripts; `pipeline-bindings.ts` is
in `apps/api` and unmodified by me). The `scripts` project — which is what typechecks my two
files — is clean in isolation. Attributed to concurrent work, not this task.

## Acceptance criteria
- `HB_MAX_CONCURRENCY` assignment removed from the child-process env — MET.
- Colocated test assertion(s) checking for it removed/adjusted to match new behavior — MET.
- Nothing else changed (`computeMaxWorkers`, `listTestPackages`, weight capture,
  `--maxWorkers` injection, passthrough, print line, exit-code propagation) — MET; only the
  two lines above differ from prior state.
- Full suite NOT run; no commit — MET.

## Deviations
None.

## Concerns and limitations
None. The `MAX_CONCURRENCY` constant is deliberately retained: it still feeds the printed
`maxConcurrency=12` allocation label, which the brief lists as staying exactly as-is.

## Confidence
High — a two-line dead-code removal; grep confirms the var is gone, typecheck/lint/coverage
all clean, 25/25 tests green, coverage stays 100% with no uncovered branch.
