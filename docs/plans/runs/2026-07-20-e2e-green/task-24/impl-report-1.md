# Task-24 — Phase-4 api coverage top-ups

## Objective

Restore per-file 95% coverage (line/branch/function) on api files this run's changes dropped
below the gate, so `pnpm test:api`'s coverage gate passes. Add real behavioral tests (not
istanbul-ignores) for every this-run regression, including the plan-required single-concrete-model
(width-1) regenerate integration case.

## Measured — before

Full `pnpm test:api` coverage gate failed on exactly two files (attributed to this run):

| File | Before (branches) | Cause (attribution) |
| --- | --- | --- |
| `src/slices/chat/routes.ts` | 94.95% (226/238) | Task-07 resolver removal + Task-18 schema |
| `src/slices/workflows/engine/failures.ts` | 85.71% (6/7) | Task-13 StorageUnavailableError branches |

No other api file measured < 95% for line/branch/function on a this-run cause. (Files showing 0/0/0/0
such as `ports/*` are structurally excluded; `interpreter.ts` 95.81%, `smart-model-execution.ts`
98.58%, `definition.ts` 97.15% are all ≥ 95% — no action, not this task's scope.)

Precise uncovered sites (v8 branch map):

- `failures.ts:68` — `super(message, cause === undefined ? undefined : { cause })`; the
  `cause !== undefined` side never exercised (existing tests only construct with no cause).
- `routes.ts` — 12 uncovered branches. 10 are pre-existing defensive infra-error branches
  (`.isErr()` DB/adapter failure paths at lines 328/355/504/647/658/783/1021/1138/1280,
  the `?? 409` refusal fallback at 410, the mock-disabled `: {}` at 238) — pre-existing debt,
  not chased. The one this-run-attributable, cheaply testable branch is `routes.ts:744-746` —
  the `customInstructions` fold in `regenerateTurnBodyHash` (Task-18 added customInstructions
  to the regenerate dedup body; the present-side branch was untested).

## Files changed

- `apps/api/src/slices/workflows/engine/failures.test.ts` — added two tests for
  `StorageUnavailableError`'s `cause` handling (the Task-13 branch).
- `apps/api/src/slices/chat/routes.integration.test.ts` — added the plan-required width-1
  regenerate case and a regenerate-customInstructions dedup-hash case (the Task-18 branch).

No source files changed — every gap closed with a behavioral test.

## Tests added

- `failures.test.ts` › "attaches the originating storage error as its cause when one is supplied"
  — constructs `new StorageUnavailableError(msg, origin)` and asserts `.cause === origin`.
  Covers the `cause !== undefined` side of `failures.ts:68`.
- `failures.test.ts` › "omits the cause when none is supplied" — asserts `.cause` is undefined
  with no cause arg (pins the other side explicitly).
- `routes.integration.test.ts` › "fans out a width-1 regenerate over a single-model list into one
  sibling (201)" — `models: [MODEL]` through `/chat/regenerate`; asserts 201 and exactly one
  optional, skip-on-error `modelCall` sibling. Closes Task-18's known gap (regenerate's `min(1)`
  models list routing through the multi-model fan-out builder as a width-1 fan-out).
- `routes.integration.test.ts` › "includes custom instructions in the regenerate body hash" —
  two regenerates differing only by `customInstructions` produce different `bodyHash`es. Covers
  `routes.ts:744-746` and pins that instructions scope the regenerate dedup.

## Self-gate

- `pnpm test:api` (with coverage gate) — PASS. 1 task successful, no `ERROR: Coverage …` lines.
  `failures.ts` now 100% branches; `chat/routes.ts` now 95.37% branches (227/238).
- `npx turbo typecheck lint --filter=@hushbox/api` — PASS (2 successful).
- `eslint src/slices/chat/routes.integration.test.ts src/slices/workflows/engine/failures.test.ts`
  from `apps/api` after the last edit — exit 0.
- `pnpm lint:duplication` (jscpd, threshold 2) — PASS (1.06% duplicated, under threshold).

Scoped-run confirmation (reproduces the full-suite per-file number without the whole tree):
`routes.integration.test.ts` + `routes.test.ts` with `--coverage.include=chat/routes.ts` →
95.37% branches (was 94.95%). `failures.test.ts` scoped → 100% branches (was 85.71%).

## Acceptance criteria

1. Identify every this-run api file < 95% — MET. Measured via full `pnpm test:api`: exactly
   `chat/routes.ts` and `workflows/engine/failures.ts`; both attributed to this run.
2. Add tests (not ignores) to bring each ≥ 95%, incl. the width-1 regenerate case — MET.
   Four behavioral tests, zero source changes, zero new istanbul-ignores. Width-1 regenerate
   case included.
3. Tests are real behavioral tests (RED-meaningful), not padding — MET. Each asserts observable
   behavior that would fail under a wrong implementation (cause attached/omitted; exactly one
   width-1 sibling with optional+skip; instructions perturb the dedup hash).
4. Proof: `pnpm test:api` passes incl. coverage gate — MET (foreground run, 8m22s, successful).

## Deviations with reasons

- The width-1 regenerate test and the customInstructions-hash test exercise pre-existing code
  paths, so they pass on first run rather than transitioning RED→GREEN. This is inherent to a
  coverage-restoration task (the behavior exists but lacked a pinning test). They remain
  RED-meaningful: each assertion fails against a wrong implementation. Only the customInstructions
  test moves the coverage number (the width-1 test reuses an already-covered branch at
  `routes.ts:608`); the width-1 test is included because the plan requires it and it closes the
  documented Task-18 behavioral gap.

## Concerns and limitations

- 10 of `chat/routes.ts`'s uncovered branches are pre-existing defensive infra-error paths
  (`.isErr()` DB/adapter failures, the `?? 409` refusal fallback, the mock-disabled body branch)
  — unrelated to this run's changes and left untouched per the attribution instruction. The file
  now clears the 95% gate; these would need adapter-failure fault injection to reach and are
  out of this task's scope.

## Confidence

High — the two failing files were pinpointed by direct measurement, the exact uncovered branches
were identified from the v8 branch map, the fix is test-only (no source risk), and the full
`pnpm test:api` coverage gate plus typecheck/lint/jscpd all pass.
