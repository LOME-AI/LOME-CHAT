# impl-report-3 — gate runner: the bare separator is dropped at every position

## Objective

One change: generalise the bare-separator strip from leading-only to every position, per the
retraction of the criterion sentence that forbade it. The per-process coverage directory
(cycle 1) and the empty-coverage-map guard (cycle 2) were not revisited and are unchanged;
their proofs stand in `impl-report-1.md` and `impl-report-2.md`.

## Files changed

- `scripts/run-package-tests.ts` — `dropLeadingSeparators()` (a leading `while` walk) becomes
  `dropSeparators()`, a filter removing every token equal to `--`; its docstring now records
  why position cannot discriminate. One call site renamed. Nothing else in the file touched.
- `scripts/run-package-tests.test.ts` — the test pinning "a non-leading `--` is forwarded
  verbatim" is inverted (not deleted) into one that fails if a mid-list separator is ever
  forwarded again, and one test added pinning that a `--`-prefixed token longer than the
  separator is undamaged.

Net source delta is two lines of logic:

```
-function dropLeadingSeparators(args: readonly string[]): readonly string[] {
-  let first = 0;
-  while (args[first] === ARGUMENT_SEPARATOR) { first += 1; }
-  return first === 0 ? args : args.slice(first);
+function dropSeparators(args: readonly string[]): readonly string[] {
+  return args.filter((argument) => argument !== ARGUMENT_SEPARATOR);
 }
```

## Acceptance criterion (separator, as ruled) — MET

### Mid-list packages: the override directory is now created and populated

Both runs from the package directory, `VITEST_MAX_WORKERS=6`, exit status captured on the
command itself. Directory contents read from `coverage-final.json`, never the printed table.

| package | `test` script's own args (why the separators land mid-list) | exit | override dir | map |
| --- | --- | --- | --- | --- |
| `@hushbox/crypto` | `--passWithNoTests` | 0 | **created** | 1 entry — `packages/crypto/src/compression.ts`, 1 900 B |
| `@hushbox/config` | `--config vitest.package.config.ts` | 0 | **created** | 1 entry — `eslint-extensions/rules/fee-seams.mjs`, 11 046 B |

Commands (the `-- --` form the criterion requires):

```
pnpm --filter @hushbox/crypto test -- -- --coverage.reportsDirectory=$G/crypto-cov \
  --coverage.include='src/compression*.ts' src/compression.test.ts
pnpm --filter @hushbox/config test -- -- --coverage.reportsDirectory=$G/config-cov \
  --coverage.include='eslint-extensions/rules/fee-seam*.mjs' eslint-extensions/rules/fee-seams.test.mjs
```

Exit 0 is not the evidence — cycle 2 measured exit 0 with **no directory** as the failing
behaviour on these same packages (90 files collected on `@hushbox/scripts`). The evidence is
the directory existing with a populated map, plus a third independent signal in the same runs:
the **positional filter survived** (1 test file collected, not the package's 36 / 32), which the
pre-fix form discarded.

`@hushbox/config` is additionally the `--config` invocation form the "existing invocations keep
working" criterion names, so that form is covered by the same measurement.

### The counterfactual, taken independently of this file

That a mid-list bare `--` voids everything after it is a property of vitest, provable without
this wrapper. From `packages/crypto`:

```
pnpm exec vitest run --passWithNoTests -- --coverage --coverage.reportsDirectory=$G/raw-vitest src/compression.test.ts
```

exit **0** · reports directory **never created** · **36 files / 495 tests** collected — the
positional filter discarded. That is the exact void-green shape, reproduced on a code path that
never loads `run-package-tests.ts`. It is why forwarding a bare separator can only ever harm.

### A `--`-prefixed token longer than two characters is never damaged

Pinned by `leaves a flag whose own name begins with the separator intact`:
`['--', '--coverage.include=lib/**/*.ts', '--passWithNoTests']` reaches vitest with both flags
present and no `--`. This test passed on first run, so it is worth nothing until something makes
it fail — mutation below. It is also corroborated behaviourally: every real run in this report
carried `--coverage.include=…`, `--coverage.reportsDirectory=…` and (for crypto/scripts)
`--passWithNoTests` through the strip intact.

## Previously-passing forms still work

| form | package | result |
| --- | --- | --- |
| leading separators (`test` script ends at the runner) | `@hushbox/sandbox`, `-- --` | exit 0, override dir created, 1 map entry (`src/config.ts`), filter honoured (1 file / 6 tests) |
| **no** separator at all | `@hushbox/crypto` | exit 0, override dir created, 1 map entry, 1 file / 10 tests |
| `--config` form | `@hushbox/config` | exit 0 — see the mid-list table |
| `--passWithNoTests` form | `@hushbox/crypto`, `@hushbox/scripts` | exit 0 (crypto); scripts' own suite is the gate below |

Repo-root `pnpm test` and `pnpm test:<pkg>` were again **not** executed, on instruction: they
run `ensure-stack`, which rewrites the env files and would void concurrent sibling runs. Stated,
not claimed green.

## The cycle-2 concern about the injected default: now CLOSED

Cycle 2 recorded that the wrapper appends its own
`--coverage.reportsDirectory=<per-process default>` **after** the passthrough args, so in the
`-- --` form vitest discarded the wrapper's own default too — criterion 1's collision
protection was itself void in that form, and runs wrote into the shared `<pkg>/coverage`.
Measured after this change, on `@hushbox/crypto` with **no** explicit directory:

```
> … run-package-tests.ts --passWithNoTests -- -- '--coverage.include=src/compression*.ts' src/compression.test.ts
[crypto] coverage report → …/packages/crypto/coverage/run-651574
```

`coverage/run-651574/coverage-final.json` exists with 1 entry. The per-process default takes
effect in the `-- --` form for mid-list packages, which it previously did not. (That directory
was removed afterwards; it is gitignored litter, and the unswept-litter note from cycle 2 is
otherwise unchanged.)

## The inverted test and its mutation

Removed (it pinned the now-wrong behaviour):
`keeps a separator that is not the first argument` — asserted `['--passWithNoTests', '--', 'some.test.ts']`
reached vitest with the separator in place.

Its replacement:
`drops a separator sitting between a script own arguments and the forwarded ones` — input
`['--passWithNoTests', '--', '--', 'some.test.ts']` (the real mid-list shape: a script argument,
then the two separators pnpm produces), asserting no `--` reaches vitest **and** that the
surrounding tokens survive adjacent and in order.

**Watched red before the change**, against the leading-only implementation — which is precisely
the mutation "forward a mid-list separator":

```
FAIL … > drops a separator sitting between a script own arguments and the forwarded ones
AssertionError: expected [ 'run', '--coverage', …(9) ] to not include '--'
```

**Mutation for the non-damage test** (`argument !== '--'` → `!argument.startsWith('--')`):

```
mutation ACTIVE:  FAIL … leaves a flag whose own name begins with the separator intact
                  AssertionError: expected [ 'run', '--coverage', …(5) ] to include '--coverage.include=lib/**/*.ts'
mutation INERT:   1 passed
```

The mutation was env-gated (`HB_MUT_PREFIX`) so it was inert for any concurrent agent's gate
run, then removed by hand; `grep -rn HB_MUT` over both owned files returns nothing (exit 1).

## Self-gate

All from `scripts/`, exit status captured on the command itself; `../../` corrected to `./` for
this package's depth.

| command | result |
| --- | --- |
| gate — `./with-env.ts` → `./run-package-tests.ts`, `run-package-tests.test.ts`, `--coverage.include='run-package-test*.ts'`, `--coverage.reportsDirectory=/tmp/hb-gate/t2c/cov`, `VITEST_MAX_WORKERS=6` | **GATE_EXIT=0** — 54 tests passed, no `POLE` line |
| per-file coverage from `cov/coverage-final.json` | `run-package-tests.ts` — statements **132/132**, branches **79/79**, functions **22/22** |
| `pnpm exec tsgo --noEmit` (whole package) | exit 0 |
| `pnpm exec eslint run-package-tests.ts run-package-tests.test.ts` — **after the final source edit** | **exit 0**, first attempt |

The statement/branch counts moved from cycle 2's 134/81 to 132/79 because the `while` walk
became a `filter`; both remain fully covered.

`turbo typecheck lint --filter=@hushbox/scripts` was again not used for lint: its lint task is
`eslint .` over the whole package, which includes the sibling task's in-flight `generate-env.*`.
`tsgo --noEmit` above covers the typecheck half for the whole package.

Tree-broken windows: **none**. Every intermediate state compiled; the mutation compiled and was
inert without its env var; the red-first state was the pre-existing implementation.

## Attribution — failures I did not cause

The five `@hushbox/scripts` collection failures (`seed*`, `refresh-catalog*`,
`lib/e2e-seeded-image-model`) from the stale vite pre-bundle race were not encountered this
cycle because the gate is file-scoped; they were confirmed in cycle 2 to reproduce under a plain
`vitest list` that never loads this file. Not chased.

## Deviations

None. The change matches the ruled criterion exactly: a standalone `--` is dropped wherever it
appears; a longer `--`-prefixed token is untouched.

## Concerns and limitations

- **A small factual correction to the seven-package list, verified from the `test` scripts.**
  Six carry their own arguments and are genuinely mid-list: `@hushbox/{scripts,shared,crypto,config}`,
  `apps/marketing`, `ops`. **`ads` does not** — its script is `tsx ../scripts/run-package-tests.ts`
  with no arguments, so its separators are leading and it was already working after cycle 2. This
  changes nothing about the fix (both classes are now covered), only the count.
- The strip means a bare `--` can never be forwarded to vitest through this wrapper. That is the
  ruling, and it is safe only for as long as vitest's bare-`--` semantics stay "discard
  everything after"; a future vitest that gives `--` meaning (e.g. as a positional escape) would
  need this revisited. The docstring records the measured basis rather than asserting a
  guarantee.
- Litter is unchanged from cycle 2: per-process `coverage/run-<pid>` directories accumulate and
  nothing sweeps them. All gitignored. No sweeper added, as instructed.

## Confidence

**High.** The change is a two-line logic substitution; the criterion's own required proof was
taken on two mid-list packages on final bytes with three independent signals each (directory
exists, map non-empty, positional filter honoured); the counterfactual was taken on a code path
that does not include this file; the inverted test was watched red against the old
implementation and the non-damage test was mutation-checked; the runner's own coverage is
complete on all three axes and lint/typecheck are exit 0 after the last edit.
