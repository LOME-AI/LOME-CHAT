# impl-report-1

## Objective

Env-file generation becomes a no-op when the content is unchanged, and atomic when it is not
— for `.env.development`, `.env.scripts` and `apps/api/.dev.vars` only. The wrangler-toml and
workflow writers stay untouched (explicitly out of scope).

## Files changed

- `scripts/generate-env.ts` — one new private `writeGeneratedFile(rootDir, relativePath, content)`
  helper (read-compare-return, else temp-write + `renameSync`), and the three in-scope
  `writeFileSync` call sites routed through it. `renameSync` added to the existing `node:fs`
  import.
- `scripts/generate-env.test.ts` — four tests pinning the write behaviour, plus fixture
  teardown that restores revoked permissions and `TMPDIR`.

Not touched, deliberately: `updateWranglerToml`'s write (`apps/api/wrangler.toml`) and
`updateWorkflows`' write (`.github/workflows/*.yml`). Both are the same class and both are
declared out of scope; neither is on the `ensure-stack` no-op path this task exists to fix.

## Tests added

All four live in `describe('generateEnvFiles') > describe('write behaviour')`.

| Test                                                                     | Behaviour                                                                                             | Criterion                 |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------- |
| `attempts no write at all when the generated content already matches disk` | Second invocation over unchanged content performs zero writes                                          | no-op-when-unchanged      |
| `replaces a changed file without writing through the existing one`         | A changed write does not truncate the existing file; the target's inode is replaced                    | atomic-when-changed       |
| `builds its temporary file outside the system temp directory`              | The temp is not taken from `os.tmpdir()` — the property that keeps `rename` same-filesystem            | atomic-when-changed       |
| `leaves no temporary file behind`                                         | Both fixture directories hold exactly their expected entries after a changed write                     | atomic-when-changed       |

### The negative-write proof, and why it can fail

**What is asserted:** after one generation, the test revokes write permission on all three
generated files (`chmod 0o444`) **and** on both directories that contain them
(`chmod 0o555` on the fixture root and on `apps/api`), then asserts the second
`generateEnvFiles` call **does not throw**. `apps/api/wrangler.toml` is left at `0o644`
because its unconditional rewrite is out of scope and must keep working — a truncating write
of an already-writable file succeeds inside a non-writable directory, so that write is
unaffected by the revocation.

**Why it discriminates.** The two directory-permission bits close both write shapes at once:

- a truncate-in-place `writeFileSync` needs the **file** writable → `EACCES`;
- a temp-then-rename needs the **directory** writable, both to create the temp and to install
  the rename → `EACCES`.

So the only way the call can complete is by attempting no write on those three paths at all.
This is not an argument — it is the observed RED. Before the implementation existed the test
failed with:

```
AssertionError: expected [Function] to not throw an error but 'Error: EACCES: permission denied, ope…' was thrown
"Error: EACCES: permission denied, open '…/scripts/__test-fixtures-env__/.env.development'"
```

(`/tmp/hb-gate/t1/red1.log`, `/tmp/hb-gate/t1/red2.log`; both exit 1.) That failure also
establishes the enforcement precondition empirically — the working tree is on a `fuseblk`
mount and the test process runs as uid 1000, so mode bits are honoured here. If they were
not, the test would have gone green at RED time and I would have had no proof.

**How it fails if the behaviour regresses:** restoring any bare `writeFileSync` on those three
paths reintroduces exactly the `EACCES` above. The regression cannot pass by coincidence, and
the assertion has no way to be satisfied by absence (the file, the directory and the call are
all still there).

**Why I did not assert the weaker forms.** Content-equality afterwards proves nothing (the
criterion says so). Inode+mtime is what the criterion offers as the alternative, and I measured
its weakness before choosing against it: this filesystem reports `mtimeNs` with roughly
millisecond granularity plus a constant-looking suffix (two rewrites read
`1785363208416162122` / `1785363208421162276`), so an mtime assertion rests on the two calls
landing in different milliseconds. The inode half is sound but couples the no-op proof to the
atomic implementation. The permission proof is independent of both.

**Spying on the write function was not available**, and this is worth recording because the
criterion offers it as the primary option: `vi.spyOn(fsModule, 'renameSync')` fails in this
suite with `TypeError: Cannot spy on export "renameSync". Module namespace is not configurable
in ESM` (`/tmp/hb-gate/t1/red1.log`). Any call-count-based proof in this package needs
`vi.mock`, which §Known Breakage already records misbehaving in this suite. The permission
proof replaces it.

### Same-directory temp — confirmation and reason

**By construction:** `writeGeneratedFile` computes `filePath = path.resolve(rootDir,
relativePath)` and then `temporaryPath = ${filePath}.${process.pid}.tmp` (lines 209 and 215).
The temp path is the resolved absolute target path plus a suffix, so
`path.dirname(temporaryPath) === path.dirname(filePath)` holds textually — there is no
directory choice to get wrong.

**Reason it is required:** `rename(2)` is atomic only within one filesystem. A temp on another
mount cannot be renamed into place at all (`EXDEV`), and any copy-based fallback would
reintroduce the partial-read window this task removes. That reason is recorded in the
function's doc comment.

**Behaviourally pinned two ways**, so the construction is not the only guard:

1. `builds its temporary file outside the system temp directory` points `TMPDIR` at a
   non-existent path before a changed write and requires the write to succeed. An
   `os.tmpdir()`-based temp fails there (`ENOENT`, or `EXDEV` on a cross-device tmpdir).
2. `leaves no temporary file behind` enumerates both directories after a changed write, so a
   temp that is created and not installed is visible.

**Both of those pass on unmodified code** (there is no temp at all yet), so I proved they
discriminate rather than assuming it: with the implementation deliberately inverted to
`${tmpdir()}/${path.basename(filePath)}.…`, **all four** write-behaviour tests fail
(`/tmp/hb-gate/t1/discriminate.log`, exit 1) with
`EXDEV: cross-device link not permitted, rename '/tmp/.env.development.576319.tmp' -> '…/__test-fixtures-env__/.env.development'`.
The source was restored from a byte-exact copy taken beforehand and verified by hash
(`f92470050fcf0c6ccb841265e9bd8a86437bcc793af34408b6e039126fd96af5` before the inversion and
after the restore). No background suite was in flight during that window.

The `EXDEV` in that log is also the independent corroboration that the shipped temp is on the
target's filesystem: the fixture sits under `scripts/` on device 54 while `/tmp` is device 61
on this machine, so a tmpdir temp cannot even be renamed here. I did not build a test on that
device layout, because it is ambient and would be vacuous on a machine where `/tmp` shares the
mount.

## Byte-identical content comparison — all four modes

The task must change *when and how* bytes are written, never *which* bytes, so I took the
comparison across the change rather than asserting it.

**Method.** A harness outside the repo (`/tmp/hb-gate/t1/probe.mts`, deliberately not in
`scripts/` so no sibling agent's lint or typecheck sees it) imports `generateEnvFiles` by
absolute path and, for each of `development`, `ciVitest`, `ciE2E`, `production`, builds a fresh
fixture tree (with `.git` so worktree resolution is deterministic slot 0, and a stub
`apps/api/wrangler.toml`), generates into it, and copies out the three generated files. Every
secret any of the four modes demands is seeded from the registry itself
(`resolveRaw` + `isSecret` over `envConfig`) with fixed `dummy-<NAME>` values, so no real
credential is involved and the bytes are deterministic.

**Run 1 was taken before my first edit** to `generate-env.ts` (`probe-before.log`, exit 0 →
`/tmp/hb-gate/t1/before/`, 12 files). **Run 2 after** (`probe-after.log`, exit 0 →
`/tmp/hb-gate/t1/after/`). Three independent comparisons, all agreeing:

1. `sha256sum` over all 12 files in each tree, then `diff` of the two hash lists → no output.
2. `cmp` per file, 12 invocations, each printed `same` (4 modes × `.env.development`,
   `.env.scripts`, `.dev.vars`).
3. `diff -r before after` → exit 0, no output.

Baseline hashes are kept at `/tmp/hb-gate/t1/before.sha256`. The shipped `generate-env.ts`
hashes identically to the copy used for run 2
(`f92470050fcf0c6ccb841265e9bd8a86437bcc793af34408b6e039126fd96af5`), so the comparison
applies to the final source and not to an intermediate state.

## Self-gate

Run from `scripts/` with the run's gate command, `VITEST_MAX_WORKERS=8`, and my own coverage
directory `/tmp/hb-gate/t1/cov`.

| Command                                                                                             | Result                                                     |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| gate: `run-package-tests.ts --coverage.reportsDirectory=$G/cov --coverage.include='generate-env*.ts' generate-env.test.ts` | **pass** — `GATE_EXIT=0`, 121/121 tests, 1 test file        |
| coverage, read from `$G/cov/coverage-final.json`                                                    | `generate-env.ts` statements 100.00, functions 100.00, branch 97.65 |
| `npx tsgo --noEmit` (the package's declared typecheck)                                               | **pass** — exit 0, zero `error TS` lines                    |
| `npx eslint generate-env.ts generate-env.test.ts` (from `scripts/`, after the last edit)             | **pass** — exit 0                                           |
| `pnpm verify:env --mode=development`                                                                 | **pass** — exit 0                                           |
| sibling suites that touch the generator or the stack (`generate-headers`, `ensure-stack`, `ensure-stack-cli`, `verify-env`) | **pass** — exit 0, 166/166                                 |

Gate exit was read from `$G/gate2.exit`, never from a harness notice; coverage was read from
`coverage-final.json`, never from a printed table. The `--coverage.include` glob carries a
wildcard and measured exactly one file (`files measured: 1`, non-zero rows), so the gate is not
vacuous.

**The two uncovered branches are pre-existing and not in my code.** `coverage-final.json`
locates them at lines 446 and 486 — the `else if (typeof raw === 'string')` fallbacks in
`generateOpsEnv` and `generateBuildEnv`. `writeGeneratedFile` has no uncovered statement or
branch: the `existsSync(...) && readFileSync(...) === content` guard is exercised on all three
paths (file absent on every fixture's first generation; present-and-equal by the no-write test;
present-and-different by the other three).

**A transient failure I observed and did not touch.** At 18:22 a whole-package
`turbo typecheck lint --filter=@hushbox/scripts --force` reported `TS2741:
'defaultReportsDirectory' is missing in type … RunDeps` at `run-package-tests.ts:406` plus nine
lint errors in the same file. That file is another task's ownership, mid-edit. Re-running
`tsgo --noEmit` at 18:25 was clean (exit 0, zero errors), so the state resolved on its own. I
made no edit there. Per-file lint over my own two files at the same moment reported exactly the
five errors that were mine, which is how I attributed the split.

**`pnpm verify:env` without `--mode` exits 1 printing its usage line** — it requires the flag,
independent of this change. Of the four modes, `development` and `production` exit 0;
`ciVitest` and `ciE2E` exit 1 complaining that the on-disk `.env.development` yields
`isCI=false` / `isE2E=false`. That is the verifier comparing a CI-mode expectation against
files the orchestrator generated in **development** mode, not a regression: the verifier only
reads, and the bytes it reads are proven byte-identical across this change, so its verdict
cannot have moved. Bringing those two modes green would require regenerating the shared env
files in a CI mode, which the coordination constraints forbid while sibling tasks are running.
The mode matching the tree's actual state passes.

## Acceptance criteria

1. **No write at all when content is unchanged, for each of the three files** — **met.** The
   permission-revocation test above covers all three paths in one assertion and was watched
   RED with `EACCES` on `.env.development` before the fix. It is strictly stronger than the
   inode/mtime alternative the criterion permits, and it is not an
   "assert content is equal afterwards" test.
2. **Atomic when content differs: temp in the same directory, `renameSync` into place** —
   **met.** `writeGeneratedFile` writes `${filePath}.${pid}.tmp` (a sibling by construction)
   and calls `renameSync(temporaryPath, filePath)`. Pinned by the no-truncate + inode-replaced
   test, the `TMPDIR` test, and the no-leftovers test; all three were proven to move under a
   deliberately wrong temp location.
3. **Generated content byte-identical for `development`, `ciVitest`, `ciE2E`, `production`** —
   **met**, by the three-way before/after comparison above, all 12 files.
4. **`pnpm verify:env` still passes; `ensure-stack` otherwise untouched** — **met** for the mode
   matching the tree (`--mode=development`, exit 0; `--mode=production`, exit 0), with the
   `ciVitest`/`ciE2E` mode-mismatch explained above. `ensure-stack.ts` and `ensure-stack-cli.ts`
   are unmodified; their suites plus `verify-env`'s pass (166/166). `generateEnvFiles`'
   signature, return type, throw behaviour on missing secrets, and per-file log lines in the
   changed case are unchanged.

## Deviations

- **The log line differs in the no-op case.** The three sites previously always printed
  `  Generated <path>`; they now print `  Unchanged <path>` when nothing was written, and the
  byte-identical `  Generated <path>` when it was. I checked first that no code, workflow, or
  doc parses this output (only the four `console.log` calls in `generate-env.ts` itself match).
  Rationale: a line asserting it generated a file it did not touch is precisely the false
  harness signal this lane exists to remove, and the branch is covered in both directions.
  Flagging it because it is an observable output change the criteria did not ask for.
- **No `try/finally` unlink of the temp on a failed rename.** A same-directory rename following
  a successful write has no realistic failure mode, and the handler would be an uncovered
  branch against the 95% gate. The no-leftovers test guards the path that exists.

## Concerns and limitations

- **Verified only on this filesystem.** The negative-write proof depends on POSIX mode bits
  being enforced for the test user. That holds here (`fuseblk`, uid 1000, RED observed) and on
  ordinary CI Linux runners, but the test would go silently green — proving nothing — on a
  filesystem mounted with permissions ignored, or if the suite ever ran as root. There is no
  in-test guard against that; naming it here is the mitigation I can offer.
- **The two out-of-scope writers remain destructive.** `apps/api/wrangler.toml` and the four
  workflow files are still truncate-rewritten unconditionally on every `generateEnvFiles` call
  with `skipBackend` false — which is every `ensure-stack` invocation. The blast radius is
  smaller (no suite reads them mid-run) but the class is identical. Out of scope by explicit
  instruction; recorded so it is not mistaken for having been fixed.
- **The concurrency win is partial while those two remain.** Two agents running a test command
  no longer void each other through the three env files, but they still both rewrite
  `wrangler.toml` and the workflow YAMLs in the same window.

## Confidence

**High.** Every criterion is pinned by a test watched failing for the stated reason, the two
tests that could not go RED before the implementation existed were proven to discriminate by
deliberate inversion, and the no-behaviour-change claim rests on a three-way byte comparison
across all four modes rather than on inspection.
