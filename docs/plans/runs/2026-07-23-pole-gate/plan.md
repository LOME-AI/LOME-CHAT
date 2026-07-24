# Run: pole-gate — fail the test suite on a "pole" test file

Tier 1. One implementation task, one auditor. Single file of production code
(`scripts/run-package-tests.ts`) plus its colocated test.

## Problem

A "pole" is a single test file whose duration single-handedly extends a
package's test wall-clock. We want `pnpm test` and every `test:*` variant to
fail when a pole exists; the fix is to split the file. Chokepoint:
`scripts/run-package-tests.ts` already runs vitest via execa, already captures
vitest's jest-shaped JSON report (per-file `startTime`/`endTime`/`name`), and
already returns vitest's exit code. The gate slots in after `exec`.

Verified contract (`vitest@4.1.8` json reporter): `report.testResults[]` entries
are `{ startTime: number, endTime: number, name: string (absolute file path), ... }`,
one entry per test file.

## Global Constraints

- TDD, per repo AGENT-RULES: every new function gets a failing test first.
- 95% line/branch/function coverage maintained (`pnpm test` runs the gate). The
  CLI entry block stays under the existing `/* v8 ignore start/stop */`.
- Explicit return types on all functions; no `any`; follow the existing style in
  `run-package-tests.ts` (pure exported functions + thin `v8 ignore` CLI).
- Do NOT change money/settlement/crypto anything — out of scope.
- Do NOT split, edit, or "fix" any test file identified as a pole. Detection only.
- Match existing surrounding code; no unrelated refactors.

## Task 01 — pole detection gate in run-package-tests.ts

**Objective:** add a pure `detectPoles()` and wire it into `runPackageTests` so a
pole fails the run on every scope, with an actionable message.

**File ownership:** `scripts/run-package-tests.ts`,
`scripts/run-package-tests.test.ts` (both edited in place — evolve, do not move).

**Design context:** the pole definition is the critical-path condition made into
a stable, machine-invariant rule. Per-package wall-clock ≈
`max(longestFile, totalWork/workers)`; splitting a file only helps when that file
dominates. The human fixed the threshold as a strict majority plus an absolute
floor (see constants). Per-package granularity is deliberate — turbo runs each
package's vitest as its own process, so "the suite" for one gate invocation is
that package's files. A huge but balanced package (api, ~2530s total work spread
over hundreds of files) correctly trips nothing; a package dominated by one heavy
file (e.g. crypto/OPAQUE) trips. No allowlist — a pole always fails; the only
resolution is splitting the file.

**Constants (module-level):**
- `POLE_MIN_MS = 15_000` — absolute floor; a file below this is never a pole.
- `POLE_MAJORITY_SHARE = 0.5` — a file must be a strict majority (`> 50%`) of the
  package's total test-work.

**Acceptance criteria:**

1. `VitestJsonReport.testResults[]` type extended to also read
   `name?: string` (the file path), alongside the `startTime`/`endTime` it
   already declares. Existing `sumWorkFromJsonReport` behavior unchanged.

2. New exported pure function with an explicit signature, e.g.:
   ```ts
   export interface Pole { readonly file: string; readonly wallMs: number; readonly share: number; }
   export interface PoleThresholds { readonly minMs: number; readonly majorityShare: number; }
   export function detectPoles(report: VitestJsonReport, thresholds: PoleThresholds): readonly Pole[];
   ```
   Behavior:
   - Per entry, `wallMs = endTime - startTime`; skip entries with a missing/
     non-finite `startTime`, `endTime`, or `name`, or `wallMs <= 0` (mirrors the
     guarding in `sumWorkFromJsonReport`).
   - Aggregate `wallMs` **by file path** (sum across entries that share a `name`)
     before thresholding — a file run under multiple vitest projects appears more
     than once and its total time is the sum.
   - `total` = Σ of all aggregated file wallMs. If `total <= 0`, return `[]`.
   - A file is a pole iff `wallMs >= minMs` AND `wallMs / total > majorityShare`
     (strict `>` for the majority; `>=` for the floor).
   - Return poles sorted by `wallMs` descending; each carries `file`, `wallMs`,
     and `share` (= `wallMs / total`).

3. JSON report is captured on **every** scope, not only `full`. Move the
   `--reporter=default --reporter=json --outputFile.json=<tmp>` setup and the temp
   file creation out of the `if (scope === 'full')` guard so a solo run also
   produces a report to inspect. Weight capture (`writeWeight`) stays **full-only**
   — do not change that behavior.

4. After `exec`, read the report and run `detectPoles(report, { minMs: POLE_MIN_MS,
   majorityShare: POLE_MAJORITY_SHARE })` on every scope. If it returns any poles:
   - Print a loud, actionable block (use `deps.warn` / a new `deps.error` sink if
     one is cleaner — implementer's call, but it must be visible on a passing
     vitest run): for each pole, the file path, its wall-time in seconds, its
     share as a percentage, and the instruction to split the file.
   - Return `Math.max(exitCode, 1)` so the package fails even when vitest itself
     exited 0. A real vitest failure (non-zero exit) still propagates.
   - If the report is missing/unreadable, keep current behavior (warn, do not
     invent a pole) — absence of data is not a pole.

5. TDD unit tests for `detectPoles`:
   - empty report / no testResults → `[]`.
   - single file over the floor → that file is a pole (share 100%).
   - one file `> 50%` and over floor, siblings present → exactly that file.
   - a file `> 50%` but **under** the 15s floor → not a pole.
   - a file over the floor but `<= 50%` share → not a pole (incl. the exact-50%
     boundary: two equal files, neither is a pole).
   - entries with missing/non-finite timestamps or missing `name` → skipped.
   - two entries sharing a `name` (multi-project) → summed before thresholding.
   - sort order: multiple qualifying inputs (only possible via the floor/edge
     construction) returned wall-desc — or assert the single-majority invariant.

6. TDD wiring tests in `runPackageTests` (extend the existing dep-injected test
   harness): given a stubbed report with a pole and `exec` resolving 0, the return
   is `1` and the actionable message was emitted; given no pole and `exec` 0, the
   return is `0`; given a pole and `exec` 2, the return is `2` (real failure wins);
   the JSON report is now requested on a **solo** run (assert the reporter/temp-file
   args reach `exec`, or that `readReport` is consulted on solo).

7. Scoped checks pass: `pnpm test:scripts`-equivalent for this file
   (`scripts/run-package-tests.test.ts` via the scripts vitest config), typecheck,
   lint, and coverage for the changed file.

**Scoped checks:** `scripts/**` is covered by the `@hushbox/config`/scripts vitest
project. Run the colocated test file and `pnpm lint` + `pnpm typecheck` for the
scripts scope. `detectPoles` and all new branches must be covered (95%); the CLI
entry stays `v8 ignore`d.

**Sensitive?** No (build/test tooling; no auth/money/crypto/user-data surface).

**Interfaces:**
- Consumes: `VitestJsonReport`, `sumWorkFromJsonReport`, `RunDeps`, `runPackageTests`
  (existing, same file).
- Produces: `detectPoles`, `Pole`, `PoleThresholds`, `POLE_MIN_MS`,
  `POLE_MAJORITY_SHARE` (new exports, same file).

## Task 02 — split the banner pole (inject-renderer approach)

**Objective:** eliminate the `scripts` pole `generate-banner-banners.test.ts` (339s,
67%) by making the two GIF renders land in separate parallel test files, while
keeping ≥95% coverage on `scripts/readme/generate-banner.ts`.

**Chosen approach (human recommendation, Option 1):** add a test seam to
`generateBanners` so its wrapper logic is coverable without a real render, and
move the two real renders into two single-variant files that run on separate
vitest workers.

**File ownership:**
- `scripts/readme/generate-banner.ts` (add the `render` param only — no other change)
- `scripts/readme/generate-banner-banners.test.ts` (rewrite: fast wrapper test)
- `scripts/readme/generate-banner-dark.test.ts` (new: real dark render)
- `scripts/readme/generate-banner-light.test.ts` (new: real light render)
- `scripts/readme/generate-banner-gif.test.ts` (DELETE — its default-seed render is
  subsumed by the dark file below)

**Design context:** `generateBanners()` renders both variants in one call, so its
real double-render is inherently a pole; a GIF render is ~114s under coverage.
`generateBannerGif(path, theme, {seed})` is the per-variant renderer. Two branches
of `generateBannerGif` need coverage: default-seed (`options.seed ?? default`, call
with no options) and explicit-seed. Splitting the two real renders across two files
lets vitest parallelize them; a fake renderer lets the wrapper test cover cache /
default-root / path+seed wiring in ~1s.

**Acceptance criteria:**

1. `generate-banner.ts`: `generateBanners(outputDir, repoRoot?, render = generateBannerGif)`
   — a third parameter defaulting to the real renderer; the two internal calls go
   through `render`. No behavior change for the CLI caller (`generateBanners(DEFAULT_OUTPUT)`)
   or any existing production call. Explicit return type unchanged (`void`). No `any`.
2. `generate-banner-banners.test.ts` rewritten to test the WRAPPER with an injected
   fake `render` (records its calls; writes a small stub file to each output path so
   `withCache` sees outputs). It must run without a real render (< a few seconds) and
   assert: (a) the default-repoRoot branch (`repoRoot ?? process.cwd()`) via chdir to
   the repo root and calling with no `repoRoot`, exactly as the current test does;
   (b) `render` is called for both dark and light output paths with seeds
   `hushbox-banner-dark` / `hushbox-banner-light`; (c) `withCache` closure executes on
   a cold cache (fresh temp outputDir). Covers `mkdirSync`, `registerFonts`,
   `getBrandColors`, `collectBannerInputs`, both paths.
3. `generate-banner-dark.test.ts` (new): real `generateBannerGif(darkPath, brandDark)`
   with NO seed (covers the default-seed branch), asserts the GIF is > 10_000 bytes.
   Keep the 180_000 ms per-test timeout. beforeEach/afterEach temp-dir like the
   existing tests.
4. `generate-banner-light.test.ts` (new): real `generateBannerGif(lightPath, brandLight,
   { seed: 'hushbox-banner-light' })` (covers the explicit-seed branch), asserts
   > 10_000 bytes, 180_000 ms timeout.
5. `generate-banner-gif.test.ts` deleted; confirm no unique coverage is lost (its sole
   test — default-seed render > 10KB — is now the dark file's job).
6. Net real GIF renders across the readme suite drop from 3 to 2, and the two remaining
   renders are in separate files (parallelizable). No new pole is introduced (each new
   render file must be < 50% of the post-split `scripts` package test-work — verify by
   reasoning or a scoped run; ~40% expected).
7. Behavior otherwise unchanged: `generateBanners` still writes both GIFs and the cache
   hash exactly as before when run for real (the CLI path). TDD — the wrapper test and
   both variant tests are written test-first (variant tests will pass immediately since
   they exercise existing `generateBannerGif`; the wrapper test drives the new `render`
   seam, so watch it fail against the un-seam'd signature first).

**Scoped checks:** `scripts/**` → run `scripts/readme/generate-banner*.test.ts` via the
scripts vitest config, `pnpm typecheck`, and `pnpm lint` on the changed files. Coverage
on `scripts/readme/generate-banner.ts` stays ≥95% (the wrapper closure is now covered by
the fake-render wrapper test; the render internals by the two variant files). Do NOT run
the full scripts suite under coverage unnecessarily — the two variant files are ~114s each.

**Sensitive?** No (readme asset tooling).

**Interfaces:**
- Consumes: `generateBannerGif`, `generateBanners`, `getBrandColors`, `withCache` (existing).
- Produces: the `render` parameter on `generateBanners` (new, defaulted — additive).

## Related E2E

None. This is CI/test-runner tooling with no user-facing flow; unit tests at the
`run-package-tests` seam fully cover it. (CODE-RULES "When to Write an E2E Test":
no user flow, no critical path, no integration-only seam.)

## Post-implementation deliverable (orchestrator, not a task)

After Task 01 is clean, run the full suite once (`HB_TEST_SCOPE=full`) to collect
every current pole violator across all packages and report the list to the human.
Do NOT split or fix any pole.
