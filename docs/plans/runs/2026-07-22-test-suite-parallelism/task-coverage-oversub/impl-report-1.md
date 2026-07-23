# impl-report-1 — coverage-oversub

## Objective

Remove the solo-run worker oversubscription (the wrapper always runs vitest under
`--coverage`, a CPU-bound workload, so `round(cores × 1.25)` = 25 on a 20-core box
oversubscribes → CPU-bound poles inflate and 3 tests cross the 15s `testTimeout`), and add
coverage-aware `testTimeout` headroom.

## Files changed

- `scripts/run-package-tests.ts` — `OVERSUB_SOLO` 1.25 → 1 (solo now `round(cores × 1)` =
  cores, no oversubscription). Rationale comment on the constant and the two docstrings
  updated to state the coverage-is-CPU-bound reason. FULL factor (1.5) untouched.
- `scripts/run-package-tests.test.ts` — solo expectations updated to the 100% value
  (cores 16 → 16; runPackageTests cores 8 → maxWorkers 8, log line `workers=8`); two solo
  test names re-worded off the "125%" language.
- `packages/config/vitest.config.ts` — `testTimeout` made coverage-aware:
  `process.argv.includes('--coverage') ? 30000 : 15000`, mirroring the existing
  `coverageWorkerCap` branch. One-line rationale comment added. Everything else identical.

## Note on `1.0` vs `1`

Brief specified factor `1.0`; ESLint `unicorn/no-zero-fractions` rejects a zero fraction, so
the constant is `1` (numerically identical, `cores × 1` = cores). Recorded as a deviation
below.

## Tests

TDD followed: updated the three solo expectations first, ran the suite, watched exactly
those 3 fail for the right reason (received `--maxWorkers=10` / `20`, expected `8` / `16`),
then changed the source and watched all 25 pass.

- `computeMaxWorkers` › "gives a solo run one worker per core…" — cores 16 → 16, label `solo`.
- `runPackageTests` › "runs solo at one worker per core…" — exec called with
  `--maxWorkers=8`, log `[ops] scope=solo · work-share=solo · workers=8`.
- `runPackageTests` › "forwards passthrough args…" — exec called with `--maxWorkers=8`.

## Self-gate

- `pnpm test:watch scripts/run-package-tests.test.ts` — pass (25/25).
- vitest run with `--coverage` on `scripts/run-package-tests.ts` — pass; coverage 100%
  stmts (72/72), branches (44/44), funcs (11/11), lines (69/69). Intact.
- `tsgo --noEmit` (scripts pkg) — pass (exit 0).
- `tsgo --noEmit` (packages/config) — pass (exit 0).
- eslint `run-package-tests.ts run-package-tests.test.ts` (from scripts dir) — pass (exit 0)
  after the `1.0`→`1` fix.
- eslint `vitest.config.ts` (from config dir) — no errors; file is eslint-ignored by the
  `*.config.*` ignore pattern (warning only, expected for config files).

## Acceptance criteria

- Solo oversubscription removed → met. On this 20-core box solo now yields
  `round(20 × 1)` = 20 (was 25). Verified via `os.availableParallelism()` = 20 and the
  pure formula.
- FULL factor unchanged → met. `OVERSUB_FULL` still 1.5; the full-run tests
  (budget `round(cores × 1.5)`) all still green, untouched.
- Coverage timeout headroom → met. `testTimeout` resolves 30000 with `--coverage` in argv,
  15000 without (verified by evaluating the exact branch expression; real vitest also
  loaded the config successfully in both modes during the runs above).

## Deviations

- Factor written as `1` not `1.0` — `unicorn/no-zero-fractions` lint rule; numerically
  identical.

## Concerns and limitations

- Did not run the full api suite (per brief; orchestrator will re-measure). The claim that
  the CPU-bound poles stop inflating and the 3 timeouts clear is inferred from the
  oversubscription arithmetic (25→20 on this box) + the 30s coverage timeout, not measured
  here.
- The config-load sanity used a direct evaluation of the branch expression; a dynamic
  `import()` of the full vitest config through tsx hit an unrelated esbuild TransformError,
  but the config file is proven-loadable because real vitest ran against it in both the
  coverage and non-coverage runs above.

## Confidence

high — mechanical two-value change, TDD red→green observed, all scoped gates green, coverage
100% intact.
