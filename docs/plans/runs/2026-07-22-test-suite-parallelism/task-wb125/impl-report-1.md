# impl-report-1 — Task WB125 (worker-budget solo runs → 125% cores)

## Objective
Solo (single-package) test runs allocate `round(cores × 1.25)` workers to use idle CPU on
I/O-bound suites; full-suite budget stays `round(cores × 1.5)`. File ownership:
`scripts/run-package-tests.ts` + colocated `run-package-tests.test.ts`.

## Files changed
- `scripts/run-package-tests.ts` — added `OVERSUB_SOLO = 1.25` constant; solo branch of
  `computeMaxWorkers` now returns `Math.max(1, Math.round(cores * OVERSUB_SOLO))` (was bare
  `cores`); full branch untouched. Updated two stale doc comments that said solo → "the whole
  box".
- `scripts/run-package-tests.test.ts` — updated the three solo expectations TDD-style:
  `computeMaxWorkers` solo (cores 16 → 20), `runPackageTests` solo maxWorkers/log (cores 8 →
  10), and the passthrough-args solo assertion (`--maxWorkers=8` → `--maxWorkers=10`). Renamed
  the two solo test titles to describe the new 125% behavior.

## Tests added / changed
- `gives a solo run 125% of cores to soak up idle CPU on I/O-bound suites` — pins
  `computeMaxWorkers` solo = round(cores×1.25); cores 16 → 20. Covers AC solo formula.
- `runs solo at 125% of cores and captures no weights` — pins `runPackageTests` solo path:
  `--maxWorkers=10` at cores 8, log line `workers=10`, no weight capture. Covers AC solo wiring.
- `forwards passthrough args to vitest` — solo maxWorkers updated to 10 (no behavior added).
No new test cases were needed; the existing solo cases already exercised the branch.

## Self-gate
- `pnpm test:watch scripts/run-package-tests.test.ts` — pass, 25/25 (1 file). Watched RED
  first: 3 failed for the expected reason (`expected 20 to be 16`, `--maxWorkers=10` vs `=8`),
  then GREEN after the impl edit.
- File coverage (from `coverage/coverage-final.json`, authoritative — the text table's summary
  omitted the row under RTK): `run-package-tests.ts` = statements 73/73, functions 11/11,
  branches 44/44, uncovered lines none = **100%** preserved.
- `pnpm typecheck` (scripts pkg, tsgo) — pass, no errors.
- `npx eslint run-package-tests.ts run-package-tests.test.ts` (from scripts/) — pass, exit 0,
  no warnings.

## Acceptance criteria
- solo branch returns `Math.max(1, Math.round(cores × 1.25))` — MET. Code:
  `return { maxWorkers: Math.max(1, Math.round(cores * OVERSUB_SOLO)), shareLabel: 'solo' };`.
- full branch UNCHANGED (`round(cores × 1.5)` budget) — MET. `OVERSUB_FULL = 1.5` and the full
  branch body are byte-identical to before; the four full-run tests pass unchanged.
- Colocated test updated TDD-style (new expectation fails first) — MET; RED observed before
  GREEN (see self-gate).
- 100% file coverage preserved — MET (100% per the JSON coverage map).
- On a 20-core box: solo → 25, full → 30 — MET. Verified live: `os.availableParallelism()`=20
  on this box; the scripts run printed `[scripts] scope=solo · work-share=solo · workers=25`
  (round(20×1.25)=25). Full = round(20×1.5)=30 by the unchanged full formula.

## Deviations
None.

## Concerns and limitations
- Running the whole `scripts` package suite (`pnpm test` in scripts/, which self-invokes the
  wrapper at the new 25-worker solo budget) hung under contention with many unrelated files
  failing (merge-marketing-into-web, generate-headers, etc.). This is the documented
  flaky-red state (plan §"LANDED but NOT SAFE": `sequence.concurrent: true`), outside this
  task's file ownership. The heavier solo oversubscription (20→25 workers) may aggravate that
  contention on the local box, but the mechanism is the pre-existing global concurrency
  change, not this task. My file's own colocated suite runs clean at 25 workers. Raised to the
  orchestrator.

## Confidence
High — the change is a two-line formula tweak plus a constant, fully pinned by the colocated
tests (RED→GREEN observed), 100% file coverage, clean typecheck/lint, and the live 20-core
box confirmed the exact 25/30 split.
