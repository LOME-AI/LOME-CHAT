# impl-report-2 — BT1 fix: authoritative cold-cache N

## Objective
Apply the validated Critical audit finding: `packagesInRun` (N) must be derived
authoritatively from the pnpm workspace (packages whose package.json has a `test` script),
never from `weightFiles ∪ self`. On a cold cache the old derivation collapsed to N=1, so
the even-split path returned the full oversubscribed budget to every concurrently-running
package (box oversubscription / OOM). Weight files continue to supply only the shares; the
pure `computeMaxWorkers` is unchanged.

## Files changed
- `scripts/run-package-tests.ts` — added `listTestPackages: () => readonly string[]` to
  `RunDeps` (injected, unit-testable); changed the `packagesInRun` derivation in
  `runPackageTests` to `scope === 'full' ? [...new Set([...deps.listTestPackages(), packageName])] : [packageName]`;
  added the real default impl in the v8-ignored CLI entry (enumerates the workspace via
  `discoverWorkspaces(repoRoot)` from `./workspaces.js`, keeping packages whose
  package.json has a `scripts.test`). `computeMaxWorkers` and all other pure functions
  untouched.
- `scripts/run-package-tests.test.ts` — added `listTestPackages` to `baseDeps` (default
  `() => ['ops']`); injected `['api','web']` into the existing weight-capture test so its
  share denominator is unchanged; added the cold-cache regression test.

## Tests added (name — behavior — criterion)
- `runPackageTests even-splits across the authoritative workspace N on a cold cache, never
  the whole budget` — empty weights + `listTestPackages` returning 15 packages, cores 8
  (budget 12) → prints `workers=1` (round(12/15)), NOT the full budget of 12 — directly
  pins the audit finding.

## Self-gate
- `pnpm run typecheck` (tsgo --noEmit) — pass (exit 0). Caught and fixed a TS4111
  (index-signature access → `manifest.scripts?.['test']`).
- `eslint run-package-tests.ts run-package-tests.test.ts` — pass, 0 problems. Caught and
  fixed one `unicorn/prevent-abbreviations` (`pkg` → `manifest`).
- `vitest run run-package-tests.test.ts` — pass, 25/25 tests (was 24; +1 cold-cache test).
- Coverage (file, from `coverage-final.json`): statements 73/73 = 100%, functions
  11/11 = 100%, branches 44/44 = 100% (branch count 42→44: the new `scope === 'full'`
  ternary; full branch covered by cold-cache/weight tests, solo branch by the solo tests).
  v8-ignored CLI entry excluded as before.

## RED evidence
Wired the new dep + failing test with the OLD derivation still in place; the cold-cache
test failed for the right reason:
`expected '…workers=1…' … Received '…workers=12…'` (the oversubscription bug present).
Then flipped the derivation → GREEN.

## Acceptance criteria
- N authoritative from the workspace, never from weight files — MET. `listTestPackages()`
  enumerates the workspace; weights only feed shares.
- Injected + unit-testable; default impl does real enumeration — MET. `RunDeps.listTestPackages`
  injected; CLI default uses `discoverWorkspaces`.
- Cold-cache unit test (empty weights + N=15 → round(budget/N), not full budget), watched
  fail first — MET.
- `computeMaxWorkers` and its passing tests intact; 100% file coverage; weight-capture /
  passthrough / HB_MAX_CONCURRENCY / print behavior unchanged — MET (all 24 prior tests
  still green; `computeMaxWorkers` body untouched).
- Full suite NOT run; no commit — MET.

## End-to-end verification (@hushbox/ops, real wrapper)
Cold cache (weights dir empty). Ran the CLI entry from `ops/` with `HB_TEST_SCOPE=full`:
printed `[ops] scope=full · work-share=even · workers=2 · maxConcurrency=12`. Box has 20
cores → budget round(20×1.5)=30; workers=2 ⟹ N≈15 (workspace-derived), i.e. the box is NOT
oversubscribed to 30. Before the fix this line would read `workers=30`. Removed the
resulting gitignored `ops.json` afterward to restore the cold-cache state (dir was empty
before the run).

## Deviations
- Solo runs skip `listTestPackages()` entirely (`packagesInRun = [packageName]`), matching
  the Contract's "on solo runs, packagesInRun = [thisPkg]"; a solo run is the whole box
  regardless of N, so no enumeration is needed.
- Kept the union with `packageName` (`[...new Set([...listTestPackages(), packageName])]`)
  as a belt-and-suspenders guarantee that the running package is always counted, even
  though a package running its own `test` script is by definition in the enumerated set.

## Concerns and limitations
- The real `listTestPackages` impl lives in the v8-ignored CLI entry (repo convention for
  CLI wiring), so its enumeration is validated by the end-to-end ops run (N≈15 observed),
  not by a unit test. The injected seam is unit-tested.

## Confidence
High — the cold-cache regression is pinned, watched-red-then-green; typecheck/lint/coverage
all clean; the real ops full run confirms workspace-derived N bounds the allocation.
