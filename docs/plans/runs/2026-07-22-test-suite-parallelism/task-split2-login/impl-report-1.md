# impl-report-1 — split2-login

## Objective

Split the ~177s coverage-pole `routes-login-session.integration.test.ts` (37 tests, 7
describes) into 2 cohesive sibling files importing the UNCHANGED
`./routes.integration.setup.ts`, to parallelize. Behavior-preserving: every test survives
verbatim; coverage unchanged.

## Files changed

- `apps/api/src/slices/identity/routes-login-session.integration.test.ts` — reduced in
  place to the login-centric half: describes `login` (13), `logout` (3), `billing-only
  session lifecycle` (1), `billing-portal token login` (6) = 23 tests. Test bodies
  moved verbatim; import list trimmed to only symbols these describes use (type import
  last).
- `apps/api/src/slices/identity/routes-revocation.integration.test.ts` — new sibling
  holding the session/revocation half: describes `revocation across every authenticated
  route class` (it.each matrix, 9), `/me bootstrap` (4), `principal guards` (1) = 14
  tests. `it.each` matrix moved verbatim; imports scoped to only what these describes
  use (type imports last).

Split axis: the 7 describes divided into 2 balanced files (23 / 14), each describe kept
whole. No test text altered.

## Tests added

None — this is a behavior-preserving split. All 37 existing tests preserved, distributed
across the two files. No test dropped, none rewritten.

## Self-gate

- `pnpm exec eslint <both files>` — pass (exit 0).
- `pnpm run typecheck` (whole-package) — fails, but 0 errors attributed to my two files
  (`grep -E "routes-login-session|routes-revocation"` over typecheck output = no match).
  All failures are in `routes-2fa.integration.test.ts` (`Cannot find name
  'createOpaqueClient'`, `stepUpKe3`, etc.) — a sibling file under concurrent split work
  (see Attribution). Not fixed (out of BOUNDS).
- Clean run: `pnpm ensure-stack` then
  `pnpm exec tsx scripts/with-env.ts vitest run --root apps/api <both files>` →
  `Test Files 2 passed (2)`, `Tests 37 passed (37)`, 24.09s. Sums to 37.
- Per-file counts: login-session 23 `it()`; revocation 5 `it()` + `it.each` matrix (3×3
  = 9) = 14. 23 + 14 = 37.

## Attribution of typecheck failure (out of scope)

`git status` at task start showed the identity dir clean. During my work, concurrent
sibling split work landed: `routes-2fa.integration.test.ts` is `M` (imports stripped) and
untracked `routes-2fa-disable.integration.test.ts`, `routes-timing-store.integration.test.ts`
appeared — none mine, all out of BOUNDS. Every typecheck error is in `routes-2fa`; none
reference my two files. The brief also pre-attributes a `pipeline-bindings.ts`
ExecutionContext error to other work. I fixed neither.

## Acceptance criteria

- Split into 2 cohesive sibling files importing unchanged setup — met. Both import
  `./routes.integration.setup.js`; setup file untouched (git shows it unmodified).
- Each describe kept whole, ~balanced — met (23 / 14; login-heavy origin makes exact
  18/18 impossible without splitting a describe, which the axis forbids).
- Behavior-preserving, every test survives, coverage unchanged — met. Bodies moved
  verbatim; 37/37 green on a clean run summing to 37.
- Original removed if name reused — met. Name `routes-login-session` reused for File A
  (edited in place); nothing dropped.
- Durable cohesive names — met (`routes-login-session` + `routes-revocation`).
- Clean imports, no unused, type imports last — met (eslint exit 0; type imports placed
  last in both files).

## Deviations

None.

## Concerns and limitations

- Whole-package typecheck/lint cannot go green while concurrent sibling splits are
  mid-flight; my files are individually clean (direct eslint pass; zero typecheck errors
  attributed to them). Re-run the package gate once all sibling split tasks land.

## Confidence

high — verbatim move, both files green on a clean 37-test run, my files lint-clean and
carry zero typecheck errors; the only red is concurrent out-of-bounds work.
