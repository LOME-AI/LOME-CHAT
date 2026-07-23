# impl-report-1 — optimizer carve-out for 2 api test files

## Objective

Keep `deps.optimizer.ssr` enabled globally in `apps/api/vitest.config.ts`, but run
`src/lib/resilience/policies.test.ts` and `src/slices/models/adapters/video-adapter.test.ts`
in a dedicated project with the SSR optimizer OFF (their `vi.importActual` /
factory-`importOriginal` of external ESM deps breaks under the optimizer's URL rewriting,
failing even on a fresh cache). Each file must execute exactly once.

## Files changed

- `apps/api/vitest.config.ts` — added `OPTIMIZER_OFF_FILES` const (2 paths, single source);
  added the paths to the `api` project's `test.exclude`; added a new `api-noopt` project
  (`extends: true`, node env, `include: OPTIMIZER_OFF_FILES`,
  `deps.optimizer.ssr.enabled: false`); added the explanatory comment on the const and the
  project. Followed the analyst's verified `carveout2.config.ts` shape; deliberately did
  NOT copy its scratchpad `cacheDir` (test-isolation artifact) and kept the real `smoke`
  project.

## Design decisions

- One `const OPTIMIZER_OFF_FILES` referenced by both the `api-noopt` include and the `api`
  exclude — no duplicated path literals (One-Implementation-Shared).
- `smoke` left untouched: its `include: ['src/smoke/**/*.smoke.test.ts']` already narrows it
  to the smoke set, which cannot match the 2 non-`src/smoke` carve-out files. Confirmed by
  `vitest list --project smoke` listing neither. No exclusion needed there.

## Self-gate

- `pnpm ensure-stack` — pass (stack ready).
- `pnpm exec tsx scripts/with-env.ts vitest run --root apps/api src/lib/resilience/policies.test.ts src/slices/models/adapters/video-adapter.test.ts`
  — pass: `Test Files 2 passed (2)`, `Tests 42 passed (42)`. These fail on a fresh cache
  WITHOUT the carve-out, so green proves the per-project optimizer-off took effect.
- `pnpm exec turbo typecheck lint --filter=@hushbox/api` — pass: 2 successful, 2 total.
  No stale-eslint-cache ENOENT appeared.

## No-double-run evidence

`vitest list` per project (grep for the two filenames):

- `--project api` — lists only `video-adapter.integration.test.ts` (a distinct file, NOT in
  the carve-out, correctly still under `api`); neither `resilience/policies.test.ts` nor the
  unit `video-adapter.test.ts` appear.
- `--project api-noopt` — lists both `resilience/policies.test.ts` and `video-adapter.test.ts`
  (all 42 test cases).
- `--project smoke` — lists neither.

Conclusion: each carve-out file resolves to exactly one project (`api-noopt`); no double-run.

## Acceptance criteria

- `api-noopt` project added alongside `api` and `smoke` with optimizer off — met.
- 2 files run exactly once (excluded from `api`; smoke already excludes them) — met (list evidence).
- Concise explanatory comment present — met.
- Single const, referenced in both include and exclude — met.
- Both files green with optimizer effectively off — met.
- typecheck + lint clean — met.

## Deviations

- Omitted the reference config's `cacheDir` scratchpad override (analyst's isolation
  artifact, not part of the real config) and kept the real `smoke` project. Intentional and
  in scope.

## Concerns and limitations

- None. Change is confined to `apps/api/vitest.config.ts`.

## Confidence

high — verified green run, per-project list confirms single assignment, typecheck+lint clean.
