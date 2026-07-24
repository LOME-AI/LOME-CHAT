# Task 01 — pole detection gate in run-package-tests.ts — impl report 1

## Objective

Add a pure `detectPoles()` to `scripts/run-package-tests.ts` and wire it into
`runPackageTests` so a "pole" test file (wall-time ≥ 15000ms AND a strict
majority > 50% of the package's total test-work) fails the run on every
`HB_TEST_SCOPE`, with an actionable message. Report is now captured on every
scope; weight capture stays full-only.

## Files changed

- `scripts/run-package-tests.ts` — added `POLE_MIN_MS`, `POLE_MAJORITY_SHARE`
  constants; `Pole`/`PoleThresholds` interfaces; exported pure `detectPoles()`;
  two module-private helpers (`toWallEntry`, `aggregateWallByFile`) extracted to
  keep `detectPoles` under the lint complexity ceiling; extended
  `VitestJsonReport.testResults[]` with `name?: string`; moved json-reporter +
  temp-file setup out of the `scope === 'full'` guard so every scope captures a
  report; added the post-exec pole gate returning `Math.max(exitCode, 1)`.
- `scripts/run-package-tests.test.ts` — added the `detectPoles` describe (10
  cases) and 4 new `runPackageTests` wiring cases; updated 3 existing cases that
  assumed solo skips report capture / the old missing-report warn text.

## Tests added (name — behavior — criterion)

detectPoles:
- empty report / no testResults → `[]` — AC5 empty.
- single file over floor → 100%-share pole — AC5 single.
- strict-majority file among siblings → exactly that file — AC5 majority.
- strict-majority but under 15s floor → not a pole — AC5 floor.
- over-floor but ≤50% share → not a pole — AC5 majority.
- exact-50% boundary (two equal files) → neither — AC5 boundary.
- missing/non-finite timestamps, missing name, zero/negative wall → skipped — AC5 skip.
- two entries sharing a name (multi-project) → summed before thresholding — AC5 sum.
- multiple qualifying poles (via `majorityShare: 0`) → sorted wall-desc — AC5 sort.

runPackageTests wiring:
- solo run captures a report (reporter/temp-file args reach `exec`, `readReport`
  consulted) but writes no weight — AC3, AC6.
- pole + `exec` 0 → return 1 and actionable message emitted — AC4, AC6.
- pole + `exec` 2 → return 2 (real failure wins) — AC4, AC6.
- no pole + `exec` 0 → return 0, no warning — AC6.
- missing report → warn + pass exit code through (no invented pole) — AC4.

## Self-gate

- `vitest run run-package-tests.test.ts` — pass — 37/37.
- coverage (`--coverage.include=run-package-tests.ts`) — pass — 100% stmts
  (105/105), branches (63/63), functions (15/15), lines (101/101); ≥95 gate met.
- `pnpm typecheck` (tsgo --noEmit) — pass — exit 0 (re-run after the complexity
  refactor).
- `eslint run-package-tests.ts run-package-tests.test.ts` — pass — exit 0.
  Numeric-separator fixes applied via scoped `eslint --fix` on the two owned
  files only. `detectPoles` initially tripped `complexity`/`sonarjs/cognitive-
  complexity`; resolved by extracting `toWallEntry` + `aggregateWallByFile`
  (no rule disabled).

## Acceptance criteria

1. `VitestJsonReport.testResults[]` extended with `name?: string`;
   `sumWorkFromJsonReport` untouched (its existing tests still green) — met.
2. `detectPoles(report, thresholds)` pure, explicit signature; aggregates wallMs
   by file path, floor `>= minMs`, strict majority `> majorityShare`, `total<=0`
   → `[]`, sorted wall-desc, each pole carries file/wallMs/share — met.
3. Reporter + temp-file setup hoisted out of the full-only guard; solo now
   requests them and reads the report; `writeWeight` stays full-only (asserted) — met.
4. Post-exec gate on every scope: prints a per-pole actionable block via
   `deps.warn` (visible on a passing vitest run), returns `Math.max(exitCode,1)`;
   real non-zero exit propagates; missing report → warn + no invented pole — met.
5. detectPoles unit tests cover every listed case incl. exact-50% boundary and
   multi-project summation — met.
6. Wiring tests extend the dep-injected harness for pole→1, no-pole→0,
   pole+exec2→2, and solo report capture — met.
7. Scoped checks (scripts vitest test, typecheck, lint, coverage) pass; CLI entry
   stays `v8 ignore`d — met.

## Deviations

- Missing-report warn message changed from the old weight-specific text to
  `"[pkg] no json report at <file>: weight capture and pole gate skipped"`, since
  the report now feeds both weight capture and the pole gate on every scope. The
  one existing test asserting the old text was updated. Behavior (warn + pass
  exit code through, no invented pole) is unchanged per AC4.
- Used the existing `deps.warn` sink for the actionable block rather than adding a
  new `deps.error` dep (the plan left this to implementer's call) — keeps the
  `RunDeps` surface minimal.

## Concerns and limitations

- With a strict `> 50%` majority, at most one file can qualify per package, so the
  sort comparator is only reachable via a lowered `majorityShare` in tests; that
  case is exercised to keep the comparator covered. This matches the plan's
  "single-majority invariant".
- Pre-existing lint failure in `scripts/lib/e2e-seeded-image-model.ts`
  (`import/order`) is concurrent work already present in the initial `git status`
  — not mine, not touched. It surfaces on a scripts-wide `pnpm lint` but is
  outside this task's file ownership.

## Confidence

high — pure function fully covered, wiring verified through the injected harness,
all scoped checks green (100% coverage), TDD RED observed before each GREEN.
