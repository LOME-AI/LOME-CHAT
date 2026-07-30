# impl-report-1 — gate runner: void and vacuous results

## Objective

Two concurrent gate runs can never void each other (criterion 1), and a coverage scope that
measures nothing fails loudly instead of exiting 0 (criterion 2).

**Outcome: criterion 1 implemented and behaviourally proven. Criterion 2 NOT implemented — its
factual premise does not reproduce, and I reproduced the exact observation it was built on and
showed it means something else.** Details in §Criterion 2.

## Files changed

- `scripts/run-package-tests.ts` — a per-process default `--coverage.reportsDirectory`, used only
  when the caller supplies none; the defaulted path is printed so it stays findable.
- `scripts/run-package-tests.test.ts` — tests for the new export and the default/explicit
  precedence, plus the two-argument passthrough form; one existing exact-argv assertion updated
  for the injected flag.

No other file touched. `git status` at start showed T1's `scripts/generate-env.{ts,test.ts}`
already modified (concurrent sibling) — untouched by me.

## Criterion 1 — per-process coverage directory: MET

Change: `processCoverageDirectory(packageDir, pid)` → `<packageDir>/coverage/run-<pid>`, injected
as `--coverage.reportsDirectory=…` only when `passthroughArgs` contains neither
`--coverage.reportsDirectory=<v>` nor `--coverage.reportsDirectory <v>`.

The directory stays **inside** the package's conventional `coverage/` tree, deliberately: that is
what keeps `.gitignore:36 coverage/` and `turbo.json:44 outputs: ["coverage/**"]` covering it with
no edit to files this task does not own. Verified: `git check-ignore -v` resolves
`packages/shared/coverage/run-585758/coverage-final.json` to `.gitignore:36`.

### Two overlapping runs — before

`packages/shared`, selection `src/affordability` (57 test files, ~8.6 s isolated),
`--coverage.include='src/affordability/**/*.ts'`, **no** `--coverage.reportsDirectory` (so both
runs used the old default `packages/shared/coverage`), `VITEST_MAX_WORKERS=4` each.

| stagger | run A (t=0) | run B | what the loser printed |
| --- | --- | --- | --- |
| 0 s | **exit 1** | exit 0 | `57 passed`, full coverage table, **0 `FAIL` lines**, then `Unhandled Error: ENOENT … lstat '…/packages/shared/coverage/.tmp'` |
| 4 s (B later) | exit 0 | **exit 1** | `0 FAIL` lines, `Error: Something removed the coverage directory "…/packages/shared/coverage/.tmp" Vitest created earlier. Make sure you are not running multiple Vitests with the same "coverage.reportsDirectory" at the same time.` |

Both stagger directions were run because the collision kills **either** run depending on stagger;
one ordering is not a demonstration. Note the two distinct messages for one cause (shared `.tmp`):
the canonical "Something removed the coverage directory" text appeared only in the staggered pair.

### Two overlapping runs — after

Same command, same package, same selection, same two staggers:

| stagger | A | B | directories | files in `coverage-final.json` |
| --- | --- | --- | --- | --- |
| 0 s | exit 0 | exit 0 | `coverage/run-585758`, `coverage/run-585767` | 48 / 48 |
| 4 s | exit 0 | exit 0 | `coverage/run-588698`, `coverage/run-589019` | 48 / 48 |

Zero `removed the coverage`/`ENOENT` lines in any of the four logs. Both runs' summaries read
`99.85 / 99.29 / 100 / 100`, identical to each other and to the pre-change surviving run — the
instrument reports the same numbers, it just no longer deletes its twin's scratch directory.

### Explicit value still wins

Post-change real run, `packages/shared`, `--coverage.reportsDirectory=/tmp/hb-gate/t2/explicit`:
exit 0, `coverage-final.json` present **in that directory** (1 file), **no** `coverage report →`
line printed, and no new `coverage/run-<pid>` directory for that pid. Unit-pinned in both CLI
forms (`--flag=value` and `--flag value`).

**The two explicit-wins tests were mutation-checked**, because both passed before the feature
existed and a guard that cannot fail is worthless: forcing the injection unconditional
(`if (true || …)`) turned exactly those two red, and only those two. No background suite was
running during that mutation; the source was restored by re-editing the same line, not by git.

### Existing invocation forms

- `@hushbox/scripts` form — `tsx ./with-env.ts tsx ./run-package-tests.ts --passWithNoTests`
  (plus one test file to keep it cheap): parsed and ran, `2 passed`, **0 `FAIL` lines**, coverage
  written to `scripts/coverage/run-591218/coverage-final.json`. Exit 1 — from **616**
  `does not meet … threshold` errors over the package's other files, the arithmetic consequence of
  selecting one test file with no `--coverage.include`, not a form failure.
- `@hushbox/config` form — `tsx ../../scripts/run-package-tests.ts --config vitest.package.config.ts`
  (with an include and the `arch/rules` selection): `13 passed`, 0 `FAIL`, coverage at
  `packages/config/coverage/run-591817`. Exit 1 from a single pre-existing 94.39% branch shortfall
  on files this task does not own. The `--config` value was honoured (13 files ran under it), and
  the two-token passthrough form is now unit-pinned.
- Repo-root `pnpm test` and every `pnpm test:<pkg>` **were not executed**: all of them begin
  `pnpm ensure-stack &&`, which rewrites `.env.development`, `.env.scripts` and
  `apps/api/.dev.vars` and would void two in-flight sibling runs. What they invoke per package is
  the package `test` script, which is exactly the two forms above. Judged by inspection plus those
  two forms; stated here rather than claimed as a green run.

### Criterion 4 — no consumer of the conventional `<pkg>/coverage` path

No NEEDS_CONTEXT: nothing reads it.

- Repo-wide grep for `reportsDirectory` outside `docs/` and `node_modules`: **zero** hits, so no
  package config pins a coverage directory that this default could fight.
- `turbo.json:44` declares `outputs: ["coverage/**"]` — a cache-output glob, not a reader, and
  `coverage/**` still matches `coverage/run-<pid>/**`.
- `packages/config/vitest.config.ts:63-70` records that threshold enforcement reads the coverage
  map directly and that "nothing in CI or scripts opens" the coverage output; reporters are
  `['text', 'json']`.
- `.jscpd.json:15` and `packages/config/eslint.config.js:91` ignore `**/coverage/**`, which still
  matches. `.gitignore:36` still ignores it (checked with `git check-ignore`).
- CI (`.github/workflows/ci.yml`) has no coverage-artifact step; its only `coverage` hit is
  `pnpm verify:typecheck-coverage`, unrelated.

## Criterion 2 — NOT implemented; the premise is refuted

The criterion rests on: "Today all three of `src/…/money.ts`, `**/…/money.ts` and a wildcard glob
exit 0, and the first two print a **zero-row table** — a wildcard-free value is silently
unmeasurable." Measured today (vitest 4.1.8), reading `coverage-final.json` as §Known Breakage
instructs rather than the printed table:

| include (from `apps/api`) | selection | exit | files in `coverage-final.json` |
| --- | --- | --- | --- |
| `src/slices/billing/domain/money.ts` (wildcard-free) | `money.test.ts` | **0** | **1 — money.ts, 4/4 statements** |
| `src/slices/billing/domain/money.ts` | `balance.test.ts` | 1 | 1 — money.ts, 0/4 (threshold ERRORs) |
| `**/billing/domain/money.ts` | `balance.test.ts` | 1 | 1 — money.ts |
| `src/slices/billing/domain/*.ts` | `balance.test.ts` | 1 | 22 |
| `src/slices/billing/domain/balance.ts` (wildcard-free) | `balance.test.ts` | 1 | 1 — balance.ts, 3/12 |

Row 1 **reconstructs the plan's form-1 observation exactly** — exit 0 with a zero-row table — and
the JSON shows the wildcard-free include measured the file **completely**. The zero-row table is
the omission anomaly §Known Breakage already records, and its trigger here is the file being at
**100%**, not the shape of the include.

Two more measurements pin that reading:

- The same "exit 0 + zero-row table" symptom appears with a **wildcard-bearing** include:
  `packages/shared`, `--coverage.include='src/comparison*.ts'` with `src/comparison.test.ts` →
  exit 0, zero data rows printed, `coverage-final.json` holds 1 file, summary `100% (1/1)`. So the
  symptom does not discriminate wildcard-free from wildcard-bearing at all.
- The genuinely vacuous case is an include that **matches no file**, and a wildcard gives no
  protection: `packages/shared`, `--coverage.include='src/nope/**/*.ts'` → **exit 0, 0 files
  measured**; `--coverage.include='src/nope/thing.ts'` → **exit 0, 0 files measured**.

**Where my guard lands relative to the three forms: nowhere — I added no include guard**, so all
three behave exactly as tabulated above, unchanged. The specified guard would have been wrong in
both directions: it rejects invocations that measure correctly (rows 1–3, 5) and passes the one
that measures nothing (`src/nope/**/*.ts`). Implementing it would have converted a working
invocation form into a hard failure across every gate in this run, on a false premise — a policy
change for the founder, not a defect fix, so I stopped instead of guessing.

The shape that would close the real hole, offered rather than built: after the run, when
`--coverage.include` was supplied, read the coverage map from the effective reports directory and
fail naming the include when it measured **zero files**. That catches typos, moved files and
stale globs regardless of wildcards, and cannot reject a working invocation.

## Self-gate

Commands run from `scripts/`. Gate exit read from a file, never from a harness notice.

| command | result |
| --- | --- |
| protocol gate — `run-package-tests.test.ts`, `--coverage.include='run-package-test*.ts'`, `--coverage.reportsDirectory=/tmp/hb-gate/t2/cov2`, `VITEST_MAX_WORKERS=8` | **GATE_EXIT=0** — 44 tests, 1 file, no `POLE` line |
| coverage of `scripts/run-package-tests.ts` from `cov2/coverage-final.json` | statements 112/112, branches 67/67, functions 18/18 |
| `pnpm exec tsgo --noEmit` (package typecheck) | exit 0 |
| `pnpm exec eslint run-package-tests.ts run-package-tests.test.ts` — **after the final edit** | exit 0 (first run was exit 1: 4 prettier/unicorn errors, fixed by hand, then re-run) |

The gate was re-run after the lint fix, so the green above sits on the final bytes.

## Tests added

| test | behaviour | criterion |
| --- | --- | --- |
| `processCoverageDirectory` › keeps the default output under the package coverage directory | default path is `<pkg>/coverage/run-<pid>` | 1, 4 |
| `processCoverageDirectory` › gives two live processes non-overlapping directories | distinct pids ⇒ distinct paths | 1 |
| `runPackageTests` › sends coverage output to the per-process directory when the caller supplies none | the flag is injected | 1 |
| `runPackageTests` › names the defaulted coverage directory in its output | the relocated default stays findable | 1 |
| `runPackageTests` › leaves an explicitly supplied coverage directory in force | `--flag=value` wins; no default appended | 1 |
| `runPackageTests` › leaves a coverage directory supplied as two arguments in force | `--flag value` wins | 1 |
| `runPackageTests` › forwards a two-argument flag value untouched | `--config vitest.package.config.ts` survives verbatim | 3 |

## Deviations

- Criterion 2 not implemented (above). This is the whole of the deviation.
- One existing test (`runs solo at one worker per core…`) asserts the exact argv array and was
  updated to include the injected flag. Position: after the passthrough args, before the json
  reporter flags.
- A second log line is printed when the directory defaults. Not asked for, but the default no
  longer lands where a reader would look, and it is asserted rather than incidental.

## Concerns and limitations

- **Nothing sweeps `coverage/run-<pid>` directories.** Each distinct pid leaves one behind, where
  the old single `coverage/` was overwritten every run; `scripts/clean.ts` targets only
  `node_modules` and `turbo clean`, and there is no coverage cleaner anywhere. Gitignored, so it
  is disk hygiene, not a red gate. I did not add a sweeper: any age-based cleaner would delete
  another live process's output, which is the failure class this change removes.
- **The unique default is not what the gate protocol relies on** — the protocol passes an explicit
  `--coverage.reportsDirectory`, which still wins. The default protects `pnpm test:<pkg>` and
  ad-hoc runs, i.e. exactly the case that lost F4's `pnpm test:web` run.
- **Two doc statements are now wrong** (reported, not edited — `.md` outside my report is
  read-only): §Known Breakage's "A LITERAL single-file `--coverage.include` MEASURES NOTHING AND
  EXITS 0" and the conclusion drawn from it, "any per-file coverage evidence in this run taken with
  a literal path was vacuous". Both are refuted by the table above; the vacuity risk that is real
  is an include matching zero files.
- Coverage litter I created while probing: `run-<pid>` directories under `packages/shared/coverage`,
  `scripts/coverage`, `packages/config/coverage`, and pre-change leftovers directly in
  `packages/shared/coverage`. Left in place deliberately — deleting a sibling package's coverage
  tree could destroy a concurrent agent's in-flight `.tmp`.

## Confidence

**High** on criterion 1: the fix is proven by two overlapping runs in both stagger directions with
before/after logs, the explicit-precedence tests were mutation-checked rather than trusted, and the
post-change coverage numbers match the isolated baseline.

**High** on the criterion-2 refutation: the plan's own form-1 observation was reproduced exactly
(exit 0, zero-row table) and shown to sit on a fully measured file, and the real zero-measurement
case was measured with a wildcard present.
