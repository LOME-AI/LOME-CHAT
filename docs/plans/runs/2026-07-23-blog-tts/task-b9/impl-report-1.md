# B9 — Pin the shipped onnxruntime version as a build-time invariant

## Objective

Add one assertion to `scripts/verify-web-bundle.ts`: every `versions:{common:…}` site in
every built script must report the exact `onnxruntime-common` version the repo declares, and
the check must fail rather than pass vacuously when it finds no site at all. Closes B8's C3
raise (nothing in the repo failed if pnpm re-hoisted a different ORT copy).

## Files changed

| path | why |
|---|---|
| `scripts/verify-web-bundle.ts` | New `declaredOrtCommonVersion()` (derivation) + `checkOrtCommonVersion()` (the assertion), wired into `collectWebBundleViolations`; header doc now lists three problem classes instead of two. |
| `scripts/verify-web-bundle.test.ts` | 8 new tests; `beforeEach` now seeds every fixture bundle with one compliant ORT version chunk (see Deviations). |

Nothing else touched. `git status` confirms the two files are the only ones I wrote; both are
still untracked (`??`), i.e. new in this run and uncommitted, as B6 left them.

## Derivation source — `packages/ui`'s declared pin, read at runtime

`declaredOrtCommonVersion()` reads `packages/ui/package.json` (path resolved from
`import.meta.url`) and returns `dependencies['onnxruntime-common']`. No version literal exists
anywhere in the verifier or its tests; the tests that need the value call the same function.

**Why this source and not the upstream chain.** The auditor's caveat offered either. I chose
the declared pin because:

1. **It is the thing the objective names.** B8 established that this pin exists for exactly one
   purpose — to win pnpm's hoist selection, because `@huggingface/transformers` imports
   `onnxruntime-common` as a bare external without depending on it. Asserting "what shipped ==
   what we declared" is literally "resolution accident → build-time invariant".
2. **It still catches upstream drift, transitively.** A built worker chunk carries *two* sites:
   the externally-resolved module (governed by our pin + hoist order) and the copy onnxruntime
   inlines into its own pre-bundled `ort.min.mjs` (governed by whatever
   `@huggingface/transformers` ships). Requiring **all** sites to equal our pin means a
   transformers bump that moves the inlined copy fails the build even though our pin is
   unchanged. So the weaker-looking source loses nothing.
3. **The upstream chain is not readable without hacks.** Verified: both
   `@huggingface/transformers/package.json` and `onnxruntime-web/package.json` are blocked by
   their `exports` maps (`ERR_PACKAGE_PATH_NOT_EXPORTED`), so a two-hop derivation needs either
   a directory walk-up from a resolved entry or hard-coded pnpm store layout — more code,
   more uncoverable failure branches, and coupling to install layout, for no extra detection.

The pin must be **exact**: a range would satisfy the declaration while letting the shipped copy
drift, so a non-exact value fails fast with a clear message instead of being used as the
expectation.

## Handling the minified indirection

The value at a site is either a quoted literal or an identifier the minifier hoisted it into.
Verified against the real current dist — all four shapes occur:

| built chunk | site 1 | site 2 |
|---|---|---|
| `dist/assets/tts.worker-CUsPgzHo.js` (unminified) | `versions: { common: version$1 }` | `versions: { common: gr }` |
| `dist/_astro/tts.worker-D6dVk0ay.js` (minified) | ``versions:{common:`1.22.0-dev.…`}`` | `versions:{common:ve}` |

So the matcher must tolerate arbitrary whitespace, all three quote styles, and identifiers
containing `$`. Implementation:

- **Site regex** — `(?<=versions\s*:\s*\{\s*common\s*:\s*)(?:<quoted>|[A-Za-z_$][\w$]*)`.
  Written as a lookbehind rather than a capture group so the value is `match[0]`, which TS types
  as always present; a capture group would be `string | undefined` and add an unreachable
  branch that could never be covered.
- **Identifier resolution** — for an identifier bound, scan the *same chunk* for
  `(?<=(?<![\w$])<ident>\s*=\s*)<quoted>` and collect the distinct values. Exactly one distinct
  value resolves; zero or several means the local being read is not the one holding the version,
  which is reported as its own violation ("the built output no longer has the shape this check
  reads") rather than silently skipped. `$` is escaped when interpolating the identifier — it is
  the only regex-special character an identifier can contain — and the `version$1` case from the
  real dist proves that path.
- **The backtick alternative is spelled out, not escaped**: `` \` `` is an invalid identity
  escape under the `u` flag.

**Vacuity guard:** a violation is raised when *zero* sites are found across the whole dist. The
guard is dist-wide, not per-file (a per-file rule would flag every non-ORT chunk, and a
"skip files without an ORT marker" rule would just relocate the silent-skip). The real dist has
4 sites, so it passes on evidence, not by absence.

## Tests added

All in `scripts/verify-web-bundle.test.ts`. RED proof is per-round below.

| test | behavior | criterion |
|---|---|---|
| `accepts a chunk whose ORT version reaches versions.common through a local` | whitespace-loose site + `$` identifier + resolution ⇒ no violation | matching chunk passes |
| `reports a chunk carrying an onnxruntime-common version other than the pin` | mismatch ⇒ 1 violation naming file, found, expected | mismatch fails |
| `reports a chunk carrying two different onnxruntime-common versions` | one site = pin (via local), one = `1.26.0` ⇒ 1 violation | the pre-existing split |
| `reports a bundle in which no ORT version site was found at all` | baseline chunk removed ⇒ 1 violation | no vacuous pass |
| `reports a version bound to a local it cannot resolve` | unresolvable identifier ⇒ 1 violation naming it | matcher-stale detection |
| `reads the exact onnxruntime-common pin packages/ui declares` | derivation returns the declared pin (read independently in the test) | derive, never hardcode |
| `rejects a manifest that declares no onnxruntime-common pin` | fail fast | derivation precondition |
| `rejects a range where an exact onnxruntime-common pin is required` | fail fast on `^1.22.0` | exactness precondition |

### RED, watched, twice

**Round 1 (derivation).** Wrote the three `declaredOrtCommonVersion` tests first:

```
FAIL verify-web-bundle.test.ts > declaredOrtCommonVersion > reads the exact … pin
TypeError: declaredOrtCommonVersion is not a function
Tests  3 failed | 14 passed (17)
```

Failed because the function did not exist; the 14 pre-existing tests stayed green. Implemented →
17 passed.

**Round 2 (the assertion).** Wrote the five bundle tests and the `beforeEach` baseline before
any check existed:

```
× reports a chunk carrying an onnxruntime-common version other than the pin
× reports a chunk carrying two different onnxruntime-common versions
× reports a bundle in which no ORT version site was found at all
× reports a version bound to a local it cannot resolve
AssertionError: expected [] to have a length of 1 but got +0   (×4)
Tests  4 failed | 18 passed (22)
```

All four failed for the intended reason — the collector returned no violations because the check
did not exist yet, not because of a typo or an error. Implemented → 22 passed.

## Verified against the real dist

`collectWebBundleViolations({ distributionDir: 'apps/web/dist' })` on the already-built merged
dist:

```
expected onnxruntime-common: 1.22.0-dev.20250409-89f8206ba4
violations: 0
```

Non-vacuous: the site census over the same dist finds 4 sites (2 per worker chunk, listed in the
table above); had the matcher found none, the vacuity guard would have failed the run.

**Teeth proved on real bundler output, not only on synthetic fixtures.** Copying the real
minified `_astro/tts.worker-D6dVk0ay.js` into a scratch dist and mutating it (scratchpad only —
no 4 MB fixture committed):

- every version literal → `1.26.0`: **2 violations**, one per site.
- only the identifier-bound site (`` ve=`…` ``) → `1.26.0`, literal site left at the pin — i.e.
  the exact historic 1.26.0-external / 1.22.0-dev-inlined split: **1 violation**:

```
shipped onnxruntime-common version is 1.26.0, expected 1.22.0-dev.20250409-89f8206ba4:
assets/tts.worker-real.js — pnpm hoisted a copy other than the one packages/ui pins
(a dependency bump or a hoist-order change does this silently)
```

That is the bug B8 found by hand; this check now finds it at build time.

## Self-gate

| command | result |
|---|---|
| `pnpm exec vitest run verify-web-bundle` (from `scripts/`) | pass — 22 tests |
| `pnpm exec vitest run verify-web-bundle build-web-bundle` | pass — 37 tests (the verifier's only caller) |
| `pnpm exec vitest run verify-web-bundle --coverage --coverage.include='verify-web-bundle.ts'` | **100% statements / branches / functions / lines** (87/87, 40/40, 23/23, 82/82) — above the scripts project's per-file 95 gate |
| `npx turbo typecheck --filter=@hushbox/scripts --force` | pass — 1 successful, 0 errors |
| `pnpm exec eslint verify-web-bundle.ts verify-web-bundle.test.ts` (from `scripts/`, after the final edit) | exit 0 |
| `npx turbo lint --filter=@hushbox/scripts --force` | pass — 1 successful |
| `pnpm exec jscpd --threshold 2` on both owned files | `Found 0 clones` |
| `pnpm exec vitest run` (whole `scripts` package) | 1844/1845 tests pass; 4 failing files, all ambient (below) |

One lint red appeared on the first pass and was fixed, not suppressed:
`unicorn/prefer-string-raw` on the site regex (`[\\w$]` in a plain template) → rewritten as
`String.raw`. Tests re-run green after that edit, and eslint was re-run last.

### Ambient failures, attributed out (not mine, not fixed)

- `generate-env.test.ts > … all backend secret keys` — the VAPID drift named in the brief.
- `refresh-catalog-run.test.ts`, `seed-run.test.ts` — collection errors from the stale
  `scripts/node_modules/.vite` artifact named in the brief
  (`Cannot find module …/deps_ssr/@hushbox_db.js&v=ce1e6bc1`).
- `verify-db-objects.integration.test.ts` — `DATABASE_URL environment variable is required for
  integration tests`. Not brief-listed, but not a repo red either: I invoked `vitest` directly,
  while the package's `test` script runs through `tsx ./with-env.ts`, which supplies it. An
  artifact of my invocation.

None of the four touches `verify-web-bundle.ts`; all four reproduce on files I never opened.

## Acceptance criteria

**(1) Every `versions:{common:…}` occurrence in each built chunk equals the expected
onnxruntime-common version — MET.** `checkOrtCommonVersion` walks every `.js` file in the dist,
resolves each site (literal or identifier), and raises a violation per non-matching site. Proved
on the real minified chunk (above) and by the mismatch/split tests.

**(2) The expected version is derived at runtime, never hardcoded — MET.** `grep` for the
version string over both owned files returns nothing; the value comes from
`packages/ui/package.json` on every run. Derivation source and reasoning documented above.

**(3) The check cannot silently pass by matching zero sites — MET.** Zero sites across the dist
is itself a violation, covered by `reports a bundle in which no ORT version site was found at
all`. Additionally, an unresolvable identifier bind is a violation rather than a skip.

**(4) The four required test cases exist and were watched RED — MET.** Match / mismatch /
two-different-versions / no-site, plus the unresolvable-bind and three derivation tests. RED
transcripts above.

**(5) The verifier passes against the real `apps/web/dist` — MET.** 0 violations, 4 sites found.

**(6) Failure message is actionable — MET.** It names the file, what was found, what was
expected, and the likely cause in one line ("pnpm hoisted a copy other than the one packages/ui
pins (a dependency bump or a hoist-order change does this silently)").

## Deviations and reasons

**D1 — `beforeEach` in the existing test file now writes one compliant ORT version chunk into
every fixture dist.** Unavoidable and correct: the dist-wide "at least one site" rule changes
what a *compliant* fixture bundle is, and without it all eleven pre-existing tests that assert
exact violation counts would have failed on the new violation. The alternative — scoping the
rule to files carrying some ORT marker — would reintroduce exactly the silent-skip the rule
exists to prevent. The chunk's version comes from `declaredOrtCommonVersion()`, so no literal is
mirrored, and **no existing test body or assertion was edited** — the only change to
pre-existing test code is the `beforeEach` addition plus the new import.

**D2 — the real-chunk teeth experiment lives in the scratchpad, not in the test suite.** It
needs a 4 MB real worker chunk; committing that as a fixture would bloat the repo and pin the
test to one build's hash-named file. The committed tests cover the same shapes synthetically;
the real-chunk run is reported as evidence.

## Concerns and limitations

**C1 — the check reads text, so it is only as good as the shapes it recognizes.** A future
bundler could emit `versions:{ "common": … }` or bind the version through a call rather than an
identifier, and the matcher would stop recognizing it. That failure is *loud*, not silent: if it
stops recognizing every site, the vacuity guard fails the build; if it recognizes the site but
cannot resolve the bind, that is its own violation. Only a partial-recognition case (some sites
still matched, a new one not) would degrade quietly.

**C2 — the assertion cannot distinguish "wrong copy hoisted" from "pin is stale".** Both surface
as the same mismatch. The message leads with the hoist cause because that is the common one; a
transformers bump presents as the *inlined* site mismatching, which the wording does not call
out separately.

**C3 — the dist is re-read.** `checkBundledRuntimeReferences` and `checkOrtCommonVersion` each
read all `.js` files (867 files / 36 MiB in the current dist). Merging them into one pass would
change the order violations are returned in and thereby churn existing tests, for a saving that
is noise next to the build itself. Deliberately not done.

**C4 — I did not run a build.** The dist I verified against is the one already on disk from B8's
build; per the brief I did not rebuild, and `pnpm install` was never run in any form.

## Confidence

**High.** The assertion is proved on real bundler output in both directions — 0 violations on the
untouched dist, and the exact historic two-version split caught from the real minified chunk,
including through the minifier's identifier indirection. Coverage is 100/100/100/100 on the file,
typecheck, lint, and jscpd are clean, the derivation contains no copied literal, and every
remaining failure in the package reproduces on files I never touched.
