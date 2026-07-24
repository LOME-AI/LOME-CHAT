# Task 02 — split the banner pole (inject-renderer approach)

## Objective

Eliminate the `scripts` pole `generate-banner-banners.test.ts` (a single 339s test that
rendered both banner GIFs) by adding a `render = generateBannerGif` test seam to
`generateBanners`, moving the two real renders into two separate parallel test files, and
keeping ≥95% coverage on `scripts/readme/generate-banner.ts`.

## Files changed

- `scripts/readme/generate-banner.ts` — added a third defaulted parameter
  `render: typeof generateBannerGif = generateBannerGif` to `generateBanners`; the two
  internal calls now go through `render`. No other change; return type stays `void`.
- `scripts/readme/generate-banner-banners.test.ts` — rewritten from a real double-render
  into a fast wrapper test that injects a fake `render` (records calls, writes a stub to
  each output path) and exercises the wrapper wiring in ~1s.
- `scripts/readme/generate-banner-dark.test.ts` — NEW: real `generateBannerGif(darkPath,
  brand.dark)` with NO seed (default-seed branch), asserts > 10 000 bytes, 180 000 ms timeout.
- `scripts/readme/generate-banner-light.test.ts` — NEW: real `generateBannerGif(lightPath,
  brand.light, { seed: 'hushbox-banner-light' })` (explicit-seed branch), asserts > 10 000
  bytes, 180 000 ms timeout.
- `scripts/readme/generate-banner-gif.test.ts` — DELETED (its sole test, a default-seed dark
  render > 10KB, is now the dark file's job).

## Tests added / changed

- `generateBanners renders dark then light through the injected renderer with per-variant
  seeds, defaulting repoRoot to cwd` (wrapper) — drives the new `render` seam, asserts the
  ordered call list (dark path + `hushbox-banner-dark`, light path + `hushbox-banner-light`,
  correct themes), default-repoRoot branch via chdir, and that both outputs were written on a
  cold cache. Covers `mkdirSync`, `registerFonts`, `getBrandColors`, `collectBannerInputs`,
  both paths + seeds (criterion 2).
- `generateBannerGif — dark … default seed` — covers the default-seed branch (criterion 3).
- `generateBannerGif — light … explicit seed` — covers the explicit-seed branch (criterion 4).

## TDD evidence

- RED: rewrote the wrapper test to pass a fake `render` as the 3rd arg, ran it against the
  un-seam'd 2-param `generateBanners` → FAIL `AssertionError: expected [] to deeply equal
  [ {…}, {…} ]` — the 3rd arg was ignored, the fake renderer was never called, `calls` empty.
  Correct RED (seam missing), not a typo/error.
- GREEN: added the `render` param → wrapper test passes (PASS 1 / FAIL 0).
- Variant tests exercise pre-existing `generateBannerGif` behavior, so they pass immediately
  (PASS 2 / FAIL 0), as the plan anticipated.

## Self-gate

- Wrapper test (scripts vitest config) — pass (1/1).
- Variant tests dark+light (real renders, scripts vitest config) — pass (2/2).
- Combined run (banners + dark + light + engine) under coverage — pass (8/8, `success:true`).
- `pnpm typecheck` (scripts, tsgo --noEmit) — pass (exit 0).
- `eslint` on the four changed files — pass ("No issues found").
- Coverage on `scripts/readme/generate-banner.ts` (`--coverage.include='readme/generate-banner.ts'`,
  perFile 95% gate active) — PASS, gate exit 0. Numbers: lines 150/150 = 100%, statements
  158/158 = 100%, functions 14/14 = 100%, branches 24/25 = 96%. ≥95% on every axis.

## Acceptance criteria

1. `generateBanners(outputDir, repoRoot?, render = generateBannerGif)` — met. Third defaulted
   param; internal calls route through `render`; CLI caller `generateBanners(DEFAULT_OUTPUT)`
   and the only production call site (grep-confirmed: sole non-test reference is the v8-ignored
   CLI block) unchanged; return type `void`; no `any`.
2. Wrapper test with injected fake `render`, < a few seconds, asserts default-repoRoot, both
   paths/seeds, cold-cache closure execution — met.
3. Dark file: real default-seed render, > 10 000 bytes, 180 000 ms timeout — met.
4. Light file: real explicit-seed render, > 10 000 bytes, 180 000 ms timeout — met.
5. `generate-banner-gif.test.ts` deleted, no unique coverage lost — met. Coverage run
   EXCLUDING the gif test still reports generate-banner.ts at 100% lines/statements/functions;
   the default-seed branch is covered by the dark file.
6. Net real GIF renders across the readme suite drop 3 → 2, in two separate parallelizable
   files; no new pole introduced — met (see share analysis below).
7. Behavior otherwise unchanged; TDD followed (wrapper drives the seam test-first) — met.

## Post-split share analysis (no new pole)

- Pre-split banner test-work in the `scripts` package: `banners` (339s, double render) plus
  `gif` (~114s, single render) ≈ 453s; `banners` alone was the 339s / 67% pole.
- Post-split: `banners` wrapper ~1s (fake render) + `dark` ~114s + `light` ~114s ≈ 229s.
  Net renders 3 → 2.
- Each new render file's share of the post-split `scripts` total: with `dark ≈ light` and the
  two renders now in SEPARATE files, the package total = `dark + light + R` where `R ≥ 0` is
  all other scripts test-work. Each file's share = `114 / (228 + R) ≤ 50%`, strictly `< 50%`
  for any `R > 0`. A pole requires strict `> 50%` share AND ≥ 15s floor, so neither file can
  be a pole for ANY value of `R`. Expected ~40% (matches the plan's estimate). This is a
  structural guarantee of splitting one ~67% double-render into two roughly-equal siblings,
  not a measured-threshold argument — I did not run the full scripts coverage suite (the two
  variant files are ~114s each under coverage; a full run is unnecessary given the proof).

## Deviations

None.

## Concerns and limitations

- The single uncovered branch on `generate-banner.ts` (24/25 = 96%) is the
  `render = generateBannerGif` default-arg initializer: no covered test calls `generateBanners`
  without the render arg (the only such call is the v8-ignored CLI path). Branch coverage
  remains 96% ≥ 95%, so I did not add a contrived cache-hit test purely to nudge it to 100%
  (Simplicity First). Flagging in case the auditor prefers 100%.
- Pre-existing, untouched: the two web-font woff2 files under `apps/web/public/fonts/` are
  absent in this worktree, so `collectBannerInputs` reports a missing input and `withCache`
  runs the closure but skips `writeHash`. Consequence: the wrapper test does NOT write the
  tracked `.github/readme/.cache/banner.hash` here (working tree stays clean). In an
  environment where the fonts exist, the wrapper test would rewrite that hash exactly as the
  prior real-render test did — identical, pre-existing behavior, not introduced by this change.
- Also pre-existing and out of scope: `.github/readme/.cache/banner.hash` is committed with
  unresolved git merge-conflict markers (`<<<<<<<`/`=======`/`>>>>>>>`). I did not touch it.

## Confidence

High — TDD RED/GREEN observed, all scoped gates green, coverage gate passes at the exact
target file, no-new-pole is a structural proof rather than an estimate, and the only
production call site is grep-confirmed unaffected.
