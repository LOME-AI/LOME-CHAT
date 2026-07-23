# impl-report-1 — split-banner

## Objective

Split `scripts/readme/generate-banner.test.ts` (the whole-suite critical-path pole,
~278s local / ~326s CI under coverage; 8 tests, 3 of which render full GIFs) into 3
sibling files so the heavy renders parallelize across workers, MERGE the two redundant
2-GIF render tests into one, and keep `generate-banner.ts` coverage unchanged.
Behavior-preserving; no production change.

## Files changed

- `scripts/readme/generate-banner.test.ts` — **deleted** (split into the three below).
- `scripts/readme/generate-banner-engine.test.ts` — **new.** The fast, canvas-free tests
  moved verbatim: `patchCryptoWithSeed` (×2) + `countPlacedReveals` (×3).
- `scripts/readme/generate-banner-banners.test.ts` — **new.** The single merged
  `generateBanners` render test (see "Merged-test shape"). Local `mkdtemp`/`rmSync`
  setup duplicated inline.
- `scripts/readme/generate-banner-gif.test.ts` — **new.** `generateBannerGif` "no options"
  (#8) moved verbatim, with its `mkdtemp`/`rmSync` setup duplicated inline.

No shared `readme/*.ts` helper was extracted (the scripts coverage config
`include: ['readme/**/*.ts']` with `perFile` thresholds would demand 95% coverage of such
a helper). The ~5-line temp-dir setup is duplicated inline in the banners and gif files.

## Tests

Original 8 → 7 after the merge.

- `generate-banner-engine.test.ts` (5): `patchCryptoWithSeed` deterministic-for-seed;
  different-seeds-differ; `countPlacedReveals` deterministic-for-seed; keeps-placing;
  full-default-duration. Moved verbatim.
- `generate-banner-banners.test.ts` (1, merged): see below.
- `generate-banner-gif.test.ts` (1): renders non-trivial GIF with default seed. Moved verbatim.

### Merged-test shape (banners file)

One test replaces original #3 ("creates both banner-dark.gif and banner-light.gif with
non-trivial size", explicit `repoRoot`) and #4 ("defaults the repo root to the process cwd
when omitted"). The merged test:

- runs in an `mkdtemp` temp dir;
- `process.chdir(repoRoot)` (restored in `finally`), as #4 did;
- calls `generateBanners(temporaryDir)` with **no `repoRoot` argument**, exercising the
  `repoRoot ?? process.cwd()` default branch at `generate-banner.ts:388` that #4 covered;
- asserts BOTH `banner-dark.gif` and `banner-light.gif` exist AND both are `> 10_000` bytes
  (#3's full assertion set).

Thus every assertion of both originals is preserved and one redundant 2-GIF render is
eliminated. The delicate case flagged in the brief (losing the `process.cwd()` default-branch
coverage) does not arise — see coverage evidence: the merged single test alone reproduces
generate-banner.ts's branch coverage exactly, so keeping two tests was unnecessary.

## Self-gate

- `vitest run` (3 files, no coverage): **pass** — 3 files, 7 tests. Wall 23.58s.
  Per-file/per-test durations (verbose reporter):
  - engine: 5 tests, each ≤5ms.
  - gif: `generateBannerGif` no-options — 12029ms (1 GIF).
  - banners: merged test — 22963ms (2 GIFs; the biggest, as expected).
  The two heavy files run on separate workers, so the critical path is ~max(23s, 12s) ≈ 23s
  rather than the original serial ~269s single-file wall.
- Coverage on `generate-banner.ts` — **unchanged**, measured both ways:
  - BEFORE (reconstructed original single file, 8 tests): Stmts 100 / Branch 95.83 /
    Funcs 100 / Lines 100; uncovered line #s: 306. Single-file wall 269.47s.
  - AFTER (3 new files, 7 tests): Stmts 100 / Branch 95.83 / Funcs 100 / Lines 100;
    uncovered line #s: 306. Identical.
  - Line 306 is the pre-existing `if (target)` partial branch inside `generateBannerGif`
    (target is always defined in practice) — unrelated to this change and uncovered before
    and after. The `?? process.cwd()` branch is fully covered by the merged test.
  - (The coverage gate reports failures for OTHER readme/lib files — `cache.ts`, `brand.ts`,
    `is-main.ts`, `idle-killer.ts`, `cipher-wall-engine.ts` — because only the banner tests
    ran in this scoped invocation; those are not exercised by the split-banner tests and are
    out of this task's scope. `generate-banner.ts` itself meets the gate.)
- `eslint` (from scripts dir, 3 files): **pass**, 0 warnings.
- `tsgo --noEmit` (scripts package): **pass**, 0 errors.

## Acceptance criteria

- Split into 3 sibling files with durable, cohesive `generate-banner-<topic>.test.ts` names —
  **met** (engine / banners / gif).
- Heavy renders parallelize — **met** (gif and banners run on separate workers; wall ~23s).
- Merge the two redundant render tests into one preserving all assertions + the cwd default
  branch — **met** (see Merged-test shape; coverage identical).
- Coverage on `generate-banner.ts` unchanged (same branches hit) — **met** (before == after,
  byte-identical row incl. uncovered line 306).
- Original file removed, no test dropped — **met** (8 → 7, only the #3/#4 redundant render
  merged away; every assertion retained).
- No production change; typecheck + lint clean — **met**.

## Deviations

None.

## Concerns and limitations

- The banners merged test still runs ~23s (2 GIFs via `generateBanners`, which always renders
  both dark and light through `withCache`). This is the irreducible floor for that file — the
  merge removed the second, redundant 2-GIF render (#3 explicit-repoRoot) that a single call
  cannot avoid otherwise. It is now the largest of the three and defines the file's critical
  path, as anticipated in the brief.
- Whole-suite critical-path improvement depends on the runner scheduling the gif and banners
  files onto different workers; within a single file they were serial. That is the intent of
  the split and is confirmed by the 23.58s wall vs 35.01s summed test time.

## Confidence

**High** — before/after coverage measured directly and is byte-identical on
`generate-banner.ts`; all 7 tests green; lint and typecheck clean; the merged test provably
covers both originals' assertions and the `process.cwd()` default branch.
