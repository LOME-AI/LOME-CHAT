# impl-report-1: coverage-setup-exclude

## Objective

Exclude test-setup modules from coverage instrumentation so the shared TEST-SETUP file
`apps/api/src/slices/identity/routes.integration.setup.ts` (extracted during the identity
split) no longer fails the per-file branch threshold (88.09% < 95%). Restores pre-split
behavior: those helpers were coverage-exempt when inline in the `.test.ts` file.

## Step 1 — setup-file enumeration and classification

`find . -name '*.setup.ts' -not -path '*/node_modules/*'` and the hyphen-variant search:

| File | Classification | Coverage status |
| --- | --- | --- |
| `e2e/auth.setup.ts` | Playwright auth-project setup — test infra | Already excluded via root `e2e/**` |
| `apps/api/src/slices/identity/routes.integration.setup.ts` | Test helpers / port doubles / fixtures — test infra | The failing target; instrumented via api `src/slices/**/*.ts` include |
| `legacy/apps/api/src/legacy/services/ai/integration-setup.ts` | Legacy quarantine | Outside all gates (`/legacy/`) |
| `apps/api/src/slices/models/adapters/integration-setup.ts` (hyphen variant) | AI-integration harness — test infra | Already explicitly excluded in `apps/api/vitest.config.ts` line 114 |

Confirmed: NO `.setup.ts` (dot) file anywhere in the repo is production code. The hyphen
variant `integration-setup.ts` in `models/adapters` is already coverage-exempt by an
explicit path entry in the api config (it is not green under coverage — it is excluded),
so leaving the dot pattern narrow to `.setup.ts` does not disturb it.

## Files changed

- `packages/config/vitest.config.ts` — added `'**/*.setup.ts'` to `coverage.exclude`
  (the shared base). Placed alongside the existing global test-file exclude
  (`**/*.{test,spec}...`) with a one-line comment.

## Exact exclude added + placement

In `packages/config/vitest.config.ts`, inside `test.coverage.exclude`, immediately after
`'**/*.{test,spec}.?(c|m)[jt]s?(x)'`:

```ts
// Test-setup modules are test infrastructure (excluded like test files;
// their helpers were coverage-exempt inline pre-split).
'**/*.setup.ts',
```

Placement rationale: `apps/api/vitest.config.ts` sets its own `coverage.exclude`, but
vitest `mergeConfig` concatenates array keys, so the root exclude still applies to the api
project (the api config's own comment at line 84 states this: "Root-config excludes still
apply after `include`"). Adding to the shared base is the global patch and restores
pre-split behavior monorepo-wide, matching where the other global test-file exclude lives.
`**/*.setup.ts` is the narrowest pattern that captures `routes.integration.setup.ts`; step
1 confirmed no production `.setup.ts` exists, so the glob is safe.

No threshold lowered; nothing else excluded.

## Self-gate

- `pnpm test:api` — pass. Run 1 (cold): wall Time `3m12.517s`, `Tasks: 1 successful`.
  Run 2 (cache replay, turbo caches only successful tasks): `Test Files 444 passed | 1
  skipped (445)`, `Tests 6048 passed | 2 skipped (6050)`, `Duration 190.97s`, exit 0.
  No `Coverage for branches ... does not meet threshold` line; no
  `routes.integration.setup.ts` line in the coverage-summary grep — the file is no longer
  instrumented.

## Acceptance criteria

- Setup files enumerated and confirmed test-infra (none production) — met (Step 1 table).
- Coverage exclude added covering `routes.integration.setup.ts`, narrowest safe pattern,
  placed where it takes effect for api — met (`**/*.setup.ts` in shared base;
  mergeConfig concatenation confirmed).
- No threshold lowered, nothing else excluded — met (single line added).
- `pnpm test:api` exits 0, all tests pass, no coverage-threshold error — met.
- No other file dropped below threshold — met (the task succeeds; turbo fails the task on
  any per-file shortfall, and it reports `1 successful`).

## Deviations

None.

## Concerns and limitations

None. The pattern is scoped to the `.setup.ts` naming convention, which universally
denotes test setup in this repo; the hyphen-variant harness stays governed by its existing
explicit exclude.

## Confidence

High — the failing gate is gone, all 6048 tests pass, and the exclude sits where vitest
config merge semantics guarantee it applies to the api project.
