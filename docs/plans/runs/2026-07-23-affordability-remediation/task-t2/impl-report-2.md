# impl-report-2 — gate runner: vacuous coverage scope + separator strip

## Objective

Finish the task: the corrected criterion 2 (a supplied `--coverage.include` whose resulting
coverage map is empty fails, naming the include) and the criterion routed in from the sibling
task (strip the bare `--` a package manager puts in front of forwarded arguments). Criterion 1
(per-process coverage directory) was delivered and proven in cycle 1 and was not re-done.

**Outcome: both criteria implemented and proven behaviourally. One measured deviation from the
letter of the separator criterion — it is a superset in count and a documented shortfall in
position; see §Deviations and §Concerns.**

## Files changed

- `scripts/run-package-tests.ts` — `dropLeadingSeparators()` on the passthrough args before they
  reach vitest; `vacuousScopeExitCode()` fails a run whose supplied include measured nothing;
  `flagValue()` reads a flag in either CLI form; new `readCoverageMap` dep, wired in the CLI block.
- `scripts/run-package-tests.test.ts` — 9 tests for the two criteria; `baseDeps` gained
  `readCoverageMap`.

No other file touched. `git status` at start showed the sibling tasks' `scripts/generate-env.*`,
`apps/api/package.json`, `packages/db/package.json`, `packages/realtime/package.json` already
modified — all left alone.

## Criterion 2 — empty coverage map ⇒ loud failure: MET

The discrimination question the brief asked to stop on was resolved by measurement, so no
NEEDS_CONTEXT. An include that matches at least one file puts that file in the map **even when no
test exercised it**: `--coverage.include='run-package-test*.ts' --passWithNoTests no-such-file.test.ts`
(zero test files collected) still produced a 1-entry map with the file at 0% and threshold ERRORs.
So with an include supplied, `{}` isolates exactly one cause — the glob matched no file. The only
other way to have no data is **no `coverage-final.json` at all** (a run that died before the
reporter), and that is a distinct observable: the guard treats a missing file as "nothing to judge"
and passes vitest's own code through, pinned by a test and mutation-checked.

### Negative proof — include matching zero files

From `scripts/`, final bytes, `--coverage.include='src/nope/**/*.ts' run-package-tests.test.ts`:

| observation | value |
| --- | --- |
| exit (read from the command, not a harness notice) | **1** |
| tests | 53 passed, 0 failed — so the non-zero exit is the guard, not a test |
| `coverage-final.json` | present, **0 keys** |
| stderr line | `[scripts] EMPTY COVERAGE SCOPE — --coverage.include=src/nope/**/*.ts matched no file, so this run measured nothing; fix the glob (it is relative to the package directory) or drop the flag.` |

The message names the offending include value verbatim, including its wildcard.

### Positive control — wildcard-free include that DOES match

Same command shape, `--coverage.include='run-package-tests.ts'` (no wildcard):
**exit 0**, map holds 1 file (`run-package-tests.ts`), `Statements: 100% (132/132)`. The guard does
not fire on it. This is the invocation shape the refuted original criterion would have hard-failed.

Both directions therefore hold: shape-free judgement, emptiness-only.

## Criterion 3 (routed in) — the bare separator: MET for the leading case, proven end-to-end

**What actually arrives, measured, and it is not what the criterion assumed.** `pnpm run` echoes the
resolved script string, which is the primary evidence:

| invocation | script string pnpm ran | separators |
| --- | --- | --- |
| `pnpm --filter @hushbox/sandbox test -- -- <args>` | `… run-package-tests.ts -- -- --coverage.reportsDirectory=… '--coverage.include=…'` | **two, leading** |
| `pnpm --filter @hushbox/scripts test -- -- <args>` | `… run-package-tests.ts --passWithNoTests -- -- --coverage…` | **two, mid-list** |

pnpm re-inserts a separator of its own on top of the one it consumed, so the `-- --` form arrives as
**two**; and for a package whose `test` script carries its own arguments they land **after** those
arguments, not first. Stripping one leading token would therefore not have satisfied this
criterion's own required proof. The implementation strips **every leading** separator.

### The `-- --` form now creates and populates the override directory

Identical command, before and after the fix, on `@hushbox/sandbox` (its `test` script ends at the
runner, so the separators are leading):

| | exit | override dir | contents | test files run |
| --- | --- | --- | --- | --- |
| before | 0 | **never created** | — | 18 (filter discarded) |
| after | 0 | created | `coverage-final.json`, 35 807 bytes, **15 files** | 18 |
| after, with a positional filter and a narrow include | 0 | created | 1 file (`config.ts`), 1 988 bytes | **1** |

Exit 0 is not the evidence — exit 0 is the failing behaviour. The evidence is the directory existing
with a populated map, and the third row additionally shows the positional filter and the include
surviving, which the pre-fix run dropped.

### A later separator is not swallowed

`['--passWithNoTests', '--', 'some.test.ts']` reaches vitest with the separator still in place
(asserted on the exec argv, in order). Mutation-checked: making the strip filter every occurrence
turns that test red. Only index-0 runs are consumed.

### Verified fact behind the mechanism

`vitest list run-package-tests.test.ts` lists 52 tests for the one file; `vitest list -- run-package-tests.test.ts`
and `vitest list -- -- …` both discard the filter and collect the whole package (exit 1). Confirms
independently that a bare `--` is not merely ignored — it voids everything after it.

## Criterion 4 — existing invocations unchanged

The strip is a no-op unless `args[0] === '--'`, and the vacuity guard is inert unless
`--coverage.include` is supplied, which no package `test` script does. Verified by running real
package scripts on final bytes rather than by inspection:

- `pnpm --filter @hushbox/config test` (the `--config` form): exit 0, 32 test files,
  `[config] coverage report → …/packages/config/coverage/run-630210` — the per-process default from
  cycle 1 still applies, no EMPTY COVERAGE line.
- `pnpm --filter @hushbox/scripts test -- -- …` (the `--passWithNoTests` form): ran, 1857 tests
  passed; 5 files failed at **collection** — see §Attribution.
- `pnpm --filter @hushbox/sandbox test …` ×3 (bare-ending form), exit 0 each.

Repo-root `pnpm test` and `pnpm test:<pkg>` were again **not** executed: they begin with
`pnpm ensure-stack`, which rewrites `.env.development`, `.env.scripts` and `apps/api/.dev.vars` and
would void concurrent sibling runs. Stated, not claimed green.

Consumer sweep (`-a`, binary-inclusive per the plan's `ugrep` rule): every reference to
`run-package-tests` outside the file itself is a `package.json` `test` script (13 packages plus
`ops/` and `ads/`); the only TS importer is its own test file. The new required `RunDeps` member
therefore breaks no other caller.

## Criterion 5 — no consumer of the conventional path

Unchanged from cycle 1 and unaffected by this cycle: nothing reads `<pkg>/coverage`
(zero non-doc hits for `reportsDirectory`; `turbo.json:44 outputs: ["coverage/**"]` is a cache-output
glob that still matches). No relocation, nothing to stop for.

## Self-gate

All from `scripts/`; exit status captured on the command itself, gate exit read from its file.

| command | result |
| --- | --- |
| protocol gate — `run-package-tests.test.ts`, `--coverage.include='run-package-test*.ts'`, `--coverage.reportsDirectory=/tmp/hb-gate/t2b/cov`, `VITEST_MAX_WORKERS=6` | **GATE_EXIT=0** — 53 tests passed, no `POLE` line |
| per-file coverage from `cov/coverage-final.json` (never the printed table) | `run-package-tests.ts` — statements 134/134, branches 81/81, functions 21/21 |
| `pnpm exec tsgo --noEmit` (whole-package typecheck) | exit 0 |
| `pnpm exec eslint run-package-tests.ts run-package-tests.test.ts` — **after the final edit** | exit 0 |

The first lint run was exit 1: three prettier violations **and a real one** —
`complexity 12 > 10` on `runPackageTests`. Fixed by moving the reports-directory resolution inside
`vacuousScopeExitCode` (which needed it anyway) so the caller gained no branch, not by a disable
comment. The gate, the negative proof and the `-- --` proof were all **re-run after** that
refactor, so every green above sits on the final bytes.

`turbo typecheck lint --filter=@hushbox/scripts` was deliberately not used for lint: its lint task
is `eslint .` over the whole package, which includes the sibling task's in-flight
`generate-env.*`. The typecheck half is covered in full by `tsgo --noEmit` above (whole package).

## Tests added

| test | behaviour | criterion |
| --- | --- | --- |
| drops the bare separator a package-manager passthrough puts in front of the args | a leading `--` is consumed; the explicit override behind it takes effect | separator |
| drops every separator stacked in front of the args, not just the first | the two-separator reality of `pnpm run … -- --` | separator |
| keeps a separator that is not the first argument | a non-leading `--` is forwarded verbatim | separator |
| fails a run whose supplied coverage include matched no file | empty map ⇒ exit 1, message names the include | vacuity |
| fails on an empty coverage map for an include supplied as two arguments | `--coverage.include X` form | vacuity |
| passes a run whose supplied coverage include measured at least one file | non-empty map ⇒ untouched | vacuity (positive control) |
| reads the coverage map from the reports directory actually in force | default dir, and an explicitly supplied one | vacuity |
| does not judge the scope of a run that wrote no coverage map at all | missing ≠ empty | vacuity |
| leaves an empty coverage map alone when no include was supplied | guard is opt-in | vacuity |

### TDD record

Four of these were watched red for the right reason before any implementation existed
(`expected +0 to be 1` twice, `expected "vi.fn()" to be called with ['/pkg/coverage/run-1']`,
`expected [ 'run', '--coverage', …(6) ] to not include '--'`). The two-separator test was written
**after** I had already widened the strip — the violation is recorded rather than hidden: I reverted
the widening to the single-token form, watched that test fail (`to not include '--'`), then restored
it and watched it pass.

The four tests that passed on first run are guards, so each was mutation-checked — a test that
passes immediately is evidence of nothing until something makes it fail:

| mutation | test that turned red |
| --- | --- |
| always vacuous once an include is supplied | positive control (and 3 others) |
| treat a missing coverage map as empty | "no coverage map at all" |
| ignore whether an include was supplied | "no include supplied" |
| strip every `--`, not just leading | "keeps a separator that is not the first argument" |

Each mutation was gated behind its own env var so it was **inert** for any concurrent agent's gate
run (the file compiled and behaved identically without the var). After the checks all four were
removed by hand and the file `diff`ed byte-for-byte against a pre-mutation copy: identical, and
`grep HB_MUT` over both owned files returns nothing. No state-writing git command was used.

## Attribution — a failure I did not cause

The full `@hushbox/scripts` suite showed **5 collection failures** (0 test failures):
`seed.test.ts`, `seed-run.test.ts`, `refresh-catalog.test.ts`, `refresh-catalog-run.test.ts`,
`lib/e2e-seeded-image-model.test.ts`. All five die on
`ERR_MODULE_NOT_FOUND … scripts/node_modules/.vite/vitest/<hash>/deps_ssr/@hushbox_db.js&v=8a56db6e`
surfaced as a `vi.mock` hoisting error — the stale vite pre-bundle race already recorded in
§Known Breakage. Evidence it is independent of my change: the identical error reproduces under a
plain `vitest list` of the package, a code path that never loads `run-package-tests.ts`; my two
owned files import neither `@hushbox/db` nor `apps/api`. Not chased, not "fixed".

## Deviations

- **The separator strip is a superset of the criterion's letter in count** (every leading separator,
  not one) because two arrive; the criterion's required proof is unreachable with a single-token
  strip. The prohibition it pairs with — do not swallow a non-leading `--` — is honoured exactly,
  and pinned by a mutation-checked test.
- **The criterion's required proof is met for the packages the routing task named** (`apps/api`,
  `packages/db`, `packages/realtime`) and for `apps/{admin,web,sandbox,crawler-view}`,
  `packages/ui` — every package whose `test` script ends at the runner. It is **not** met for the
  five whose script carries its own arguments; see §Concerns.
- Proven with `pnpm --filter <pkg> test -- -- <flag>` (the package script directly), never the
  repo-root `pnpm test:<pkg>` wrapper, which would have run `ensure-stack`.

## Concerns and limitations

- **The `-- --` form is still a silent no-op for five packages, and closing it needs a ruling.**
  `@hushbox/{scripts,shared,crypto,config}`, `apps/marketing` (plus `ops/`, `ads/`) carry their own
  arguments in the `test` script, so pnpm's separators land mid-list and a leading-only strip cannot
  reach them: measured on `@hushbox/scripts`, all 90 test files ran and the override directory was
  never created. Dropping bare `--` **anywhere** would close it and appears behaviourally safe —
  vitest 4.1.8 gives a bare separator no meaning except discarding everything after it (verified
  above), so a surviving one can only void a run — but that contradicts the criterion's final
  sentence, so it is not mine to decide.
- **A second thing the separator was voiding, not previously recorded:** the wrapper appends its own
  injected `--coverage.reportsDirectory=<default>` *after* the passthrough args, so in the `-- --`
  form vitest discarded the injected default too. The pre-fix probe runs wrote into the shared
  `<pkg>/coverage` (`apps/sandbox/coverage/coverage-final.json` is the residue) — i.e. criterion 1's
  collision protection was itself void in that form. The strip repairs that as a side effect.
- **Litter: unchanged by this cycle, and nothing sweeps it.** The per-process default still leaves a
  `coverage/run-<pid>` directory per run; `scripts/clean.ts` covers only `node_modules` and
  `turbo clean`. Present now: `packages/shared/coverage/run-{585758,585767,588698,589019}` and
  `packages/config/coverage/run-{591817,630210}` — five predate this cycle, `run-630210` is mine
  (from the `--config` verification), plus flat `apps/sandbox/coverage/` from the two pre-fix probes.
  All gitignored (`.gitignore:36 coverage/`). One observation worth a nuance: `scripts/coverage/run-591218`,
  recorded in cycle 1, is **gone** without my having removed it — `turbo.json`'s
  `outputs: ["coverage/**"]` replaces the whole directory on a cache hit, so turbo-mediated runs do
  clear some litter. No sweeper added, as instructed.
- The guard reads the coverage map from the reports directory in force; if a future caller passes
  `--coverage.reporter` without `json`, `coverage-final.json` will be absent and the guard silently
  abstains rather than misfiring. That is the intended fail-open direction, but it means the guard is
  only as good as the repo's `reporter: ['text','json']` default.
- Tree-broken windows: none behavioural. The four env-gated mutations sat in the file for roughly
  three minutes, inert without their env vars; the single-token revert for the red-first check lasted
  one ~15 s vitest run and is the pre-existing behaviour of that line.

## Confidence

**High** on both criteria. The negative proof, the positive control and the `-- --`
directory-population proof were all taken behaviourally on the final bytes, before/after on the same
command; the four guard tests were mutation-checked; the runner's own coverage is 134/134 statements,
81/81 branches, 21/21 functions.

**High** on the mid-list separator shortfall being real rather than a testing artifact: it is pnpm's
echoed script string, on two different packages, with the outcome (90 files collected, no directory)
matching.
