# impl-report-1 — BT1 worker-budget wrapper

## Objective
Build `scripts/run-package-tests.ts` per the plan's Worker-budget Contract + BT1: a
duration-weighted, invocation-aware worker-budget wrapper around `vitest run`, with the
allocation and json-report-parsing logic extracted into pure, unit-tested functions.

## Files changed
- `scripts/run-package-tests.ts` (new) — the wrapper. Pure exports: `median`,
  `computeMaxWorkers`, `sumWorkFromJsonReport`, `deriveShortName`, `readWeights`,
  `writeWeight`; orchestration export `runPackageTests(env, deps)`; a v8-ignored CLI entry
  that wires real fs/execa/os.
- `scripts/run-package-tests.test.ts` (new) — colocated unit tests (24 tests).

## Tests added (name — behavior — criterion)
- median: odd middle / even average / throws on empty — median helper — median-fallback support.
- computeMaxWorkers: solo→CORES; full weighted proportional (api .75→9, web .25→3, label 25%);
  tiny-share floored at 1; even-split on empty cache (label `even`); median fallback for a
  package missing from a populated cache, even-count and odd-count median; all-zero weights →
  even share fallback — covers the Contract formula + every fallback branch.
- sumWorkFromJsonReport: sums (endTime−startTime) across testResults; skips entries missing a
  finite timestamp; returns 0 for empty/absent testResults — json-report parse.
- deriveShortName: strips scope; passes unscoped through — pkg-name derivation.
- readWeights: loads conforming files, skips non-json/malformed/non-numeric; missing dir → {}
  — weight-file load with cold-cache + corruption robustness.
- writeWeight: writes `dir/<pkg>.json` with `{totalWorkMs}`, creates dir — weight persistence.
- runPackageTests: solo runs whole box + writes nothing + no report read; forwards passthrough
  args; full run captures weight from report and writes it; derives pkg from cwd package.json
  when HB_PKG_NAME unset/empty; warns + writes nothing when a full run has no report;
  propagates vitest exit code — full orchestration contract.

## Self-gate (from `scripts/`)
- `tsgo --noEmit -p tsconfig.json` — pass (no errors).
- `eslint run-package-tests.ts run-package-tests.test.ts` — pass (0 problems).
- `vitest run run-package-tests.test.ts --coverage` — pass, 24/24 tests, 1 file.
- Coverage (file, `coverage-summary.json`): lines 100% (70/70), branches 100% (42/42),
  functions 100% (11/11), statements 100% (73/73). File is absent from the perFile-gate
  ERROR list. (v8-ignored CLI entry is excluded, matching the repo convention for CLI entries.)

## Acceptance criteria (Contract + BT1)
- Weights cache = per-package `scripts/.cache/test-weights/<pkgShort>.json` = `{totalWorkMs}` —
  MET. `writeWeight` writes exactly this; verified on the ops full run (`ops.json =
  {"totalWorkMs":93.45…}`). Per-package files, no shared-file write.
- Weight = Σ per-file (endTime−startTime) from `--reporter=json` — MET. `sumWorkFromJsonReport`;
  the wrapper injects `--reporter=json --outputFile.json=<tmp>` on full runs (kept
  `--reporter=default` too so failures still print — see Deviations).
- Env contract: `HB_TEST_SCOPE` full|else-solo; `HB_MAX_CONCURRENCY=12` set for the child;
  `HB_PKG_NAME` short name with cwd package.json fallback — MET. Verified: child env carries
  `HB_MAX_CONCURRENCY:'12'` (unit test); the allocation line prints `maxConcurrency=12`.
- Allocation: solo→CORES; full budget=round(CORES×1.5), share=work_p/Σwork, max(1,round(budget×share));
  empty→even split by N; missing-from-populated→median — MET, all pinned by unit tests.
- Mandatory printed line `[<pkg>] scope=… · work-share=… · workers=… · maxConcurrency=12` — MET.
  Observed full: `[ops] scope=full · work-share=even · workers=30 · maxConcurrency=12`;
  solo: `[ops] scope=solo · work-share=solo · workers=20 · maxConcurrency=12` (box has 20 cores).
- Weights written only on full runs — MET. Full run wrote `ops.json`; solo run wrote nothing
  (verified dir empty afterward).
- Wrapper execs vitest in cwd, works with/without with-env, forwards passthrough args — MET.
  Ran directly (no with-env) in `ops/` with `--passWithNoTests` forwarded; 58 tests passed, exit 0.
- PURE allocation + weight-parse functions unit-tested; verified end-to-end on @hushbox/ops,
  not the full suite — MET.

## Verification evidence (end-to-end, @hushbox/ops)
- `--maxWorkers` and `--outputFile.<reporter>` are recognized vitest 4.1.8 flags (from
  `vitest --help`; the help documents the exact `--outputFile.json=…` dot-notation used).
- Full run: printed allocation line above; wrote `scripts/.cache/test-weights/ops.json`
  (gitignored) — the weight file's existence proves vitest accepted the injected reporter
  flags and produced a parseable json report. Exit 0.
- Solo run: printed line above; no weight file. Exit 0.

## Deviations (with reasons)
- **Reporter flags on full runs**: Contract says add `--reporter=json --outputFile=<tmp>`. I
  add `--reporter=default --reporter=json --outputFile.json=<tmp>` instead. A bare
  `--reporter=json` replaces all reporters, so a full `pnpm test` would lose per-test console
  output (including failures) — a real regression. Keeping `default` preserves console output
  while json (targeted via `--outputFile.json`) captures durations to the file. Within file
  ownership; behavior otherwise identical. BT2 wiring is unaffected.
- **`computeMaxWorkers` returns `{maxWorkers, shareLabel}`** rather than a bare number. The
  brief's unit cases assert `.maxWorkers`. Returning the label alongside avoids a second
  function that would have to re-derive the same branch (even vs %) — a would-be sync smell.
- **Solo `work-share` label = `solo`.** The Contract's line placeholder lists `<x%|even>` but
  gives no solo example; `scope=solo` already distinguishes the case and `solo` is the honest
  label. Minor interpretation.
- **`median` exported.** Exported so its empty-input guard branch is directly testable (the
  project lints forbid both `as` casts and `!` assertions, so the noUncheckedIndexedAccess
  undefined had to be handled by a real, covered guard rather than an assertion).

## Concerns and limitations
- **`packagesInRun` on a cold cache (RAISED).** The pure function takes `packagesInRun`
  explicitly and is fully correct given it. The CLI derives it as
  `keys(weightsByPkg) ∪ {thisPkg}` because BT1's spec says "read scope + weight files" — it
  does not authorize enumerating the workspace. Consequence: on a fully cold cache (no weight
  files yet) a package sees only itself, so the even-split denominator N=1 and it claims the
  whole full-budget (`round(CORES×1.5)`) — several packages doing this concurrently
  oversubscribe on that first cold full run. This self-corrects after one full run (every
  package then has a weight file, so all packages are counted). If the orchestrator wants the
  cold run bounded too, the CLI needs an authoritative package set (e.g. from turbo/workspace)
  — a spec decision, not something I invented here.
- `--maxWorkers` reaching vitest is asserted by unit test (exact args array) and corroborated
  by the successful e2e run; I did not intercept vitest's received argv directly because
  execa `preferLocal` shadows any PATH-injected fake `vitest` with the real local binary.

## Confidence
High — every Contract branch is unit-tested at 100% coverage, typecheck+lint clean, and the
end-to-end ops run confirms the full-vs-solo weight-write behavior and the printed allocation.
The one open item (cold-cache `packagesInRun` source) is a spec gap I've raised, not a defect
in the implemented behavior.
