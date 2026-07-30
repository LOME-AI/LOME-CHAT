# impl-report-1

## Objective

A passthrough argument given to `pnpm test:<pkg>` must take effect on the run that carries
coverage, for `apps/api`, `packages/db` and `packages/realtime`.

## Files changed

- `apps/api/package.json` — `test` script: the two `&&` clauses swapped so the coverage run is last.
- `packages/db/package.json` — same swap.
- `packages/realtime/package.json` — same swap.

Before (all three, identical):

```
tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts && pnpm run test:workers
```

After (all three, identical):

```
pnpm run test:workers && tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts
```

Nothing else was touched. `scripts/run-package-tests.ts` was not read for edit and not modified
(`git diff` over the three files above is the whole change; three one-line hunks).

## Tests added

None, and not by omission: the task's `**Files:**` line is the `test` script in three
`package.json` files and "Nothing else", so there is no file in scope that can hold a test, and
the behaviour under test is a shell-level argument-routing property of a package-manager script.
TDD was executed as a measured RED → GREEN on the configuration itself (below): every RED
observation was taken **before** the edit and every GREEN observation **after** it, with the
override directory path as the discriminator rather than an exit code.

## Self-gate

| Command                                                                      | Result                     |
| ---------------------------------------------------------------------------- | -------------------------- |
| `pnpm exec eslint . --cache …` in `packages/realtime` (after last edit)      | **exit 0**, empty output   |
| `pnpm exec eslint . --cache …` in `packages/db` (after last edit)            | **exit 0**, empty output   |
| `pnpm exec eslint . --cache …` in `apps/api` (after last edit)               | **exit 0**, 0-byte log     |
| `npx prettier --check` on the three changed files                            | **exit 0**                 |
| `pnpm --filter @hushbox/realtime test <args>` (full, both clauses)           | **exit 0**                 |
| `pnpm --filter @hushbox/api test <args>` (narrow selection)                  | exit 0 / exit 1 — see note |
| `pnpm --filter @hushbox/db test <args>` (narrow selection)                   | exit 1 — see note          |
| `npx turbo test --filter=@hushbox/realtime --force` (no args)                | **exit 0**                 |

Lint set derived from `git status`: the changed files are three `package.json` files in three
packages, so three `eslint` runs, each from that package's own directory, each after the final
edit (the final edit was `packages/realtime/package.json`; all three lint runs followed it).
The ESLint flat config carries no `**/*.json` block, so `package.json` is not a linted file in
this repo — the runs are the constraint's package enumeration, not a check of the diff. Prettier
does own `package.json` (it is the formatting gate) and passes.

Typecheck was not run: no TypeScript file changed and no type surface moved.

**Note on the exit 1s** — they are per-file coverage thresholds tripped by the deliberately
narrow test selection I appended, not by the reorder, and both are *evidence for* a criterion
rather than a failure. `apps/api`: `ERROR: Coverage for lines (0%) … for
src/lib/result/from-promise.ts` (I ran only `index.test.ts` in the second pass).
`packages/db`: `ERROR: Coverage for lines (77.41%) … for src/client.ts` (`client.ts` is driven
by `client.integration.test.ts`, which I deliberately excluded — no integration token was taken).
Both cases prove the last clause's failure reaches the script's exit code with the workers run
already executed. `apps/api`'s first pass, with both `src/lib/result/*.test.ts` files appended,
exited **0**.

## Acceptance criteria

### 1. For `apps/api`, `packages/db` and `packages/realtime`, an appended `--coverage.reportsDirectory=<temp path>` demonstrably takes effect — the exact directory created and populated

**Met for the invocation forms that do not inject a literal `--`; NOT met for the forms that do,
for a cause outside this task's files. Read criterion 4 below before treating this as clean.**

The discriminator throughout is the **explicit** path, never a default, so the proof survives
whatever T2 does to the default (asserted per the task's own instruction).

RED, measured before the edit:

- `packages/realtime`, full end-to-end, override only:
  `pnpm --filter @hushbox/realtime test --coverage.reportsDirectory=/tmp/hb-gate/t3/red-realtime-pure/cov`
  → **GATE_EXIT=0**, `OVERRIDE_DIR_EXISTS=no`. Both clauses ran (12 node files / 365 tests, then
  2 workers files / 24 tests). This reproduces the recorded trap exactly: success reported,
  nothing changed.
- `packages/realtime`, override + a narrowing file filter:
  same command plus `--coverage.include='src/do-identity*.ts' src/do-identity.test.ts`
  → **GATE_EXIT=1**, `OVERRIDE_DIR_EXISTS=no`, and the log's second run says
  `No test files found, exiting with code 1`. The coverage clause still ran all 12 files, i.e. it
  saw none of the appended arguments; the workers clause received them and died on the filter.
  This pins the routing directly rather than by absence.
- `apps/api` and `packages/db`: the clause that received the appended argument was probed on its
  own, because the RED chain's *first* clause is the full package suite (for `apps/api` that is
  179 integration files and no token was held).
  `pnpm --filter @hushbox/api run test:workers --coverage.reportsDirectory=/tmp/hb-gate/t3/red-api-workers/cov`
  → exit 0, 1 file / 6 tests, `OVERRIDE_DIR_EXISTS=no`.
  `pnpm --filter @hushbox/db run test:workers --coverage.reportsDirectory=/tmp/hb-gate/t3/red-db-workers/cov`
  → exit 0, 2 files / 2 tests, `OVERRIDE_DIR_EXISTS=no`.
  Composed with the measured append semantics (next bullet), that is the full RED statement for
  both packages: the argument reaches only the last clause, and the last clause creates no
  coverage directory whatever it is handed.
- Append semantics, measured in an isolated throwaway package under `/tmp` (no repo file
  involved): for a script `A && B`, `pnpm run <script> -- ARG` produces the literal command
  `A && B -- ARG`; clause A's `process.argv.slice(2)` is `[]` and clause B's is
  `["--","ARG"]`. So the appended argument reaches **only** the final clause — and pnpm
  inserts a literal `--` ahead of it when the caller uses the `--` separator.

GREEN, measured after the edit. Exact paths passed, and what was found at them:

| Package             | Exact `--coverage.reportsDirectory` passed | Created | Contents               |
| ------------------- | ------------------------------------------ | ------- | ---------------------- |
| `packages/realtime` | `/tmp/hb-gate/t3/green-realtime/cov`       | yes     | `coverage-final.json`, 1785 B |
| `packages/db`       | `/tmp/hb-gate/t3/green-db/cov`             | yes     | `coverage-final.json`, 7973 B |
| `apps/api`          | `/tmp/hb-gate/t3/green-api/cov`            | yes     | `coverage-final.json`, 649 B  |

Populated, not merely created: `/tmp/hb-gate/t3/green-realtime/cov/coverage-final.json` parses to
exactly one key — the absolute path of `packages/realtime/src/do-identity.ts` — with 7 statement
entries, i.e. the file the appended `--coverage.include` named. The invocation form was
`pnpm --filter <name> test --coverage.reportsDirectory=<path> --coverage.include='<wildcard glob>' <test file(s)>`
with `VITEST_MAX_WORKERS=8`.

Re-verified against the current tree after `scripts/run-package-tests.ts` changed underneath me
(see Concerns): `/tmp/hb-gate/t3/green2-{realtime,api,db}/cov` were all created and all hold
`coverage-final.json`.

### 2. Both the coverage run and the workers run still execute, and the command exits non-zero if either fails

**Met.**

Both execute — the reordered script string is echoed by pnpm at the top of every run, e.g.

```
> pnpm run test:workers && tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts --coverage.reportsDirectory=/tmp/hb-gate/t3/green-realtime/cov '--coverage.include=src/do-identity*.ts' src/do-identity.test.ts
```

and each GREEN log contains **two** vitest summary blocks: `packages/realtime` 2 files/24 tests
(workers) then 1 file/3 tests (coverage); `packages/db` 2/2 then 1 file/10 tests; `apps/api`
1 file/6 tests then 2 files/8 tests. The `[<pkg>] scope=solo · work-share=solo · workers=24`
banner from the wrapper appears after the workers block, which is the ordering made visible.
The second-pass runs each show two summary blocks as well.

Non-zero on a **last-clause** failure — induced, not reasoned: the two threshold exits in the
self-gate table above (`apps/api` 0% on `from-promise.ts`, `packages/db` 77.41% on `client.ts`)
each produced `GATE_EXIT=1` from a script whose workers clause had already completed
successfully, with `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` naming the reordered string.

Non-zero on a **first-clause** failure — induced on the real chain, in `packages/realtime`, by
handing the workers clause a filter matching nothing and running the exact reordered string
through `sh -c`:

```
pnpm run test:workers src/workers-validation/no-such-file.workers.test.ts && tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts --coverage.reportsDirectory=/tmp/hb-gate/t3/fail-first/cov …
```

→ `CHAIN_EXIT=1`, log contains `No test files found, exiting with code 1`, and the coverage
clause did not run (no `scope=solo` banner, `/tmp/hb-gate/t3/fail-first/cov` never created).
Independently, the `/tmp` probe showed a first clause exiting 3 yields script exit 3 with the
second clause skipped. Short-circuit semantics are unchanged and neither run is silently dropped
— the ordering of *which* one is skipped is the change, recorded under Concerns.

### 3. Repo-root `pnpm test` and `turbo test --filter=<each package>` behave as before

**Met for what I could execute; two invocations I could not run, named rather than assumed.**

- `npx turbo test --filter=<name> --dry=json` for all three packages reports the task command as
  `pnpm run test:workers && tsx ../../scripts/with-env.ts tsx ../../scripts/run-package-tests.ts`
  — i.e. the string CI executes is the reordered one, for each of the three, with no other task
  field disturbed (`outputs` stays `["coverage/**"]`).
- `VITEST_MAX_WORKERS=8 npx turbo test --filter=@hushbox/realtime --force` (no passthrough args)
  → **exit 0**, `1 successful, 1 total`, `0 cached`, and both clauses ran (2 workers files, then
  12 node files). Argument-free behaviour is a pure ordering change, which is what this
  invocation demonstrates.
- Turbo passthrough, single separator:
  `npx turbo test --filter=@hushbox/realtime --force -- --coverage.reportsDirectory=/tmp/hb-gate/t3/turbo-passthrough/cov --coverage.include='src/do-identity*.ts' src/do-identity.test.ts`
  → exit 0, directory **created** with `coverage-final.json`, coverage run narrowed to 1 file.
  Turbo consumes its own `--` and appends the remaining arguments **without** re-inserting one,
  so this path is fully fixed.
- **Not run, and why:** repo-root `pnpm test`, `pnpm test:api`, `pnpm test:db`,
  `pnpm test:realtime`. Every root `test*` script begins `pnpm ensure-stack &&`, and the brief
  forbids running `ensure-stack` (it rewrites `.env.development`, `.env.scripts` and
  `apps/api/.dev.vars` and would void siblings' in-flight runs); `pnpm test` additionally runs
  the whole monorepo suite. What that leaves unverified is precisely `ensure-stack`'s own step,
  which is upstream of and independent from the arg routing; the rest of each root script is
  `tsx scripts/with-env.ts turbo test --filter=<name>`, whose behaviour I measured directly
  above. `pnpm test` differs from the per-package form only by `HB_TEST_SCOPE=full` and the
  absence of `--filter`; `HB_TEST_SCOPE` is read inside `run-package-tests.ts` (weight capture,
  worker share) and is not affected by clause order.
- **CI-relevant consequence I did check:** the `test` script text is part of turbo's task hash,
  so the first CI run after this lands is a guaranteed cache miss for these three packages. That
  is the intended and only cache effect; no `turbo.json` change was needed.

### 4. Discovered while proving criterion 1 — a SECOND, independent cause that the reorder cannot fix

The recorded diagnosis ("the override lands on the workers run, which carries no coverage") is
correct but **not the only cause**. There are two, in series:

1. **Routing** — fixed here. The appended argument now reaches the coverage run.
2. **A literal `--` neutralises it at the vitest CLI.** pnpm's passthrough inserts `--` ahead of
   the appended arguments, `run-package-tests.ts` forwards `process.argv.slice(2)` verbatim, and
   **vitest 4.1.8 discards everything after a bare `--`** — measured directly, not inferred:
   `vitest run --coverage --maxWorkers=8 -- --coverage.reportsDirectory=P --coverage.include='src/do-identity*.ts' src/do-identity.test.ts`
   in `packages/realtime` exits **0**, runs all **12** files (so the positional filter was
   discarded too, not merely the flags), and never creates `P`. Dropping the `--` from the same
   command creates `P` with `coverage-final.json` and runs **1** file.

So after the fix:

| Invocation                                             | Override takes effect     |
| ------------------------------------------------------ | ------------------------- |
| `pnpm --filter <pkg> test --coverage.reportsDirectory=…` (no separator) | **yes** — proven for all three packages |
| `turbo test --filter=<pkg> -- --coverage.reportsDirectory=…`            | **yes** — proven on realtime            |
| `pnpm --filter <pkg> test -- --coverage.reportsDirectory=…`             | **no** — exit 0, dir never created      |
| `pnpm test:<pkg> -- -- --coverage.reportsDirectory=…` (the form the plan names) | **no** — exit 0, dir never created |

Both "no" rows were measured, not deduced. The fourth was measured in its turbo-equivalent form
(`npx turbo test --filter=@hushbox/realtime --force -- -- <args>`, which is exactly what the root
script produces once pnpm appends its own `--`): the wrapper received
`… run-package-tests.ts -- --coverage.reportsDirectory=…`, the coverage run executed all 12 files,
exit 0, `/tmp/hb-gate/t3/turbo-double-dash/cov` never created. The reorder *is* visible in that
log — the arguments reach the right clause now — and it still changes nothing observable, which
is the failure shape this run treats as the worst available.

The remedy is one line and it is **out of bounds**: strip a leading `--` from `passthroughArgs`
before building `vitestArgs` in `scripts/run-package-tests.ts` (T2's file, and the brief forbids
reaching into it). I did not attempt a package.json-only workaround because none exists: pnpm's
append is textual, the appended tokens become literal arguments to the final command, and there
is no `"$@"` to filter — any filtering needs a wrapper, which is a file this task may not add.

## Deviations

- **No test file added.** The task's file list admits none (see Tests added). The red-first
  discipline was satisfied by measurement against the explicit override path, before and after
  the edit.
- **`apps/api` and `packages/db` RED was proven in two composed parts** rather than one
  end-to-end run: the append semantics (measured, isolated) plus the receiving clause's inability
  to create a coverage directory (measured, real). An end-to-end RED for `apps/api` requires the
  full 179-integration-file suite and an integration token, which I did not request because the
  same fact was obtainable without it. `packages/realtime`'s RED *was* end-to-end.
- **Verification used narrow, non-integration selections only.** No `*.integration.test.ts` file
  was run; no integration token was requested or held. `packages/db`'s workers clause
  (`src/workers-validation/**`, 2 files) does write through a DO to the shared Postgres and is
  unavoidable — it is the first clause of the script under test — but it is not an
  `*.integration.test.ts` file and each run took seconds.

## Concerns and limitations

- **The `--`-separator gap above is the one thing a reader must not miss.** Criterion 1 is
  satisfiable and satisfied, but an agent who types the plan's own recipe
  `pnpm test:<pkg> -- -- --coverage.reportsDirectory=X` still gets a silent no-op. If the intent
  behind this task was "the documented recipe works", the task is not finished by the file it was
  given, and the completion belongs in T2's file or a micro-task.
- **Which failure a developer now sees first has inverted.** Previously the node/coverage suite
  ran first and a failure there skipped the workers run; now a workers failure short-circuits the
  entire coverage run, so for that package there is no coverage table at all until the workers
  suite is green. The workers suites are tiny (`apps/api` 1 file/6 tests, `packages/db` 2 files/2
  tests, `packages/realtime` 2 files/24 tests) and fast, so in practice this is fail-fast on the
  cheap suite; but it is a real change in diagnostic order and it stacks with the recorded trap
  that a red run suppresses the coverage report. Incidentally in the other direction: the
  standing `apps/api` `template-html` failure lives in the node suite, which is now second, so it
  no longer suppresses the workers run.
- **`scripts/run-package-tests.ts` changed underneath me mid-task** (mtime 18:25:36; my first
  GREEN measurements were 18:19–18:20, so they ran against the pre-change version). Per the
  brief this is the concurrent task, and I did not investigate it. I re-ran all three GREEN cases
  afterwards against the current tree and all three still create and populate the explicit
  override directory; every include glob I passed carried a wildcard, so a wildcard fail-fast
  landing in that file cannot have flattered my results. No behaviour I attribute to my change
  rests on a single pre-change observation.
- **Not verified:** repo-root `pnpm test` and the `pnpm test:<pkg>` root scripts end-to-end
  (`ensure-stack` forbidden — see criterion 3); the turbo passthrough path on `apps/api` and
  `packages/db` specifically, since running it means their full suites. For those two I have the
  dry-run command string and the per-package `pnpm --filter` runs, and the passthrough mechanism
  itself is package-independent (it is turbo's, not the package's).
- Both packages' narrow-selection exits of 1 are coverage thresholds from my own selection. I did
  not attempt to make them exit 0, because the criterion under test is where the argument lands,
  not whether an arbitrary subset meets a 95% floor.

## Confidence

**High** on what the change does: every claim above is a measured observation with the explicit
override path as the discriminator, RED and GREEN both taken, and the routing visible in the
echoed command string rather than inferred from an exit code.

**Medium** on the task being *complete in intent*: the two invocation forms that inject a literal
`--` — including the one the plan names verbatim — remain silent no-ops for a reason that lives
in a file this task may not touch, and I could not verify the repo-root scripts end-to-end
because running them is forbidden here.
