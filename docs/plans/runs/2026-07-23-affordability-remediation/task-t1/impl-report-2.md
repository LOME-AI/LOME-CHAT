# impl-report-2

## Objective

Fix two validated findings, both about tests that do not discriminate. Production behaviour in
`scripts/generate-env.ts` was correct and passed, and is unchanged by this cycle:

1. The no-op proof failed open — its only assertion was `not.toThrow()` after revoking mode bits, so as
   root or on a permission-ignoring mount it passed with the no-op check deleted.
2. The same-directory placement of the temporary file was pinned by nothing — the audit's cross-directory
   mutant passed all four write-behaviour tests.

## Files changed

- `scripts/generate-env.test.ts` — one test strengthened, one test added, `utimesSync` imported.
- `scripts/generate-env.ts` — **no net change.** Mutated twice for the mutation evidence below and
  restored by hand each time; sha256 verified identical to the cycle-start baseline (below).

## What the fix actually is, and why it is not the obvious one

The audit's direction for finding 1 was `expect(identity(relative)).toEqual(before[index])`, on the
measurement that `mtimeNs` is ns-resolution here (`…416162122` vs `…421162276`). **Measured this cycle,
that reading is wrong and a bare mtime comparison would have shipped a second fail-open test** — a
timing-dependent one instead of an identity-dependent one:

```
node /tmp/hb-gate/t1b/fsprobe.mjs   (fixture fs = fuseblk, and /tmp = btrfs for comparison)
file rewrite identical bytes: ino same = true | mtimeNs moved = false
  mtimeNs a = 1785365167169022630  b = 1785365167169022630     <- two writes, ONE timestamp
dir entry create+unlink: mtimeNs moved = true | delta = 3000093 ns
```

The distinct ns tails in the earlier measurement are a fixed sub-millisecond offset on an
approximately 1 ms clock, not resolution. Two writes inside one tick share an `mtimeNs` exactly, on
both filesystems tested. A mutant that rewrites unchanged bytes fast enough is therefore invisible to
a raw before/after mtime compare — the same species of false green as the mode-bit gate, keyed on
clock speed instead of process identity.

**The fix that removes both dependencies: backdate the target before the observed invocation.**

```ts
const backdate = (relative: string): void => {
  const aged = new Date(Date.now() - 60_000);
  utimesSync(path.join(TEST_DIR_ENV, relative), aged, aged);
};
```

Any write at all resets mtime to now, so the assertion has a 60-second detection margin instead of a
one-tick one, and the margin is computed at runtime rather than hardcoded. Verified on the fixture
filesystem (`fsprobe2.log`): backdating takes; `chmod` does not move mtime (ctime only); `readFileSync`
does not move mtime; an identical-bytes rewrite is detected with `delta ms = 60002`; directory entry
churn is detected with `delta ms = 60003`.

For finding 2 the same primitive supplies the mode-bit-independent half. A directory's mtime tracks
entry creation and removal whatever identity the process runs as, so a temporary file built in the tree
root rather than beside `apps/api/.dev.vars` is visible in the root's mtime even where the read-only
root cannot stop it.

## Tests added and strengthened

Both live in `describe('generateEnvFiles') > describe('write behaviour')`.

| Test                                                                       | Change      | Criterion                      |
| -------------------------------------------------------------------------- | ----------- | ------------------------------ |
| `attempts no write at all when the generated content already matches disk`  | strengthened | no-op-when-unchanged (tightened) |
| `builds its temporary file beside the target rather than in the tree root`  | new         | same-directory placement       |

The strengthened test keeps the permission revocation as an additional signal (the criterion permits
that) and adds `expect(identity(relative)).toEqual(before[index])` over all three paths, against
backdated mtimes.

The new test's scenario is chosen so that exactly one write is in play: after a first generation, only
`apps/api/.dev.vars` is made stale, so the two root files are no-ops and the run's single write belongs
to `apps/api`. The root is then `0o555` while `apps/api` stays writable — a root temp `EACCES`es where a
sibling temp succeeds — and the root's backdated `(ino, mtimeNs)` must be untouched afterwards.

## Mutation evidence — the RED for each assertion

Production code is already correct, so the RED comes from mutants. Two mutants, each run twice: as
uid 1000 through the real vitest suite, and as uid 0 through a standalone replication of the same two
scenarios (`/tmp/hb-gate/t1b/rootprobe.mts`), because running vitest itself as root would leave
root-owned cache files in a repository concurrent agents are writing to. Verified afterwards: `find . -user root` outside `node_modules` returns nothing.

### Mutant B — the audit's exact cross-directory mutant

```ts
const temporaryPath = path.resolve(rootDir, `.cross-dir-${path.basename(filePath)}.tmp`);
```

Real suite, uid 1000 (`/tmp/hb-gate/t1b/mutB.log`, `GATE_EXIT=1`) — `Tests 1 failed | 121 passed (122)`:

```
✓ attempts no write at all when the generated content already matches disk 13ms
✓ replaces a changed file without writing through the existing one 13ms
✓ builds its temporary file outside the system temp directory 12ms
× builds its temporary file beside the target rather than in the tree root 25ms
✓ leaves no temporary file behind 17ms
```

```
AssertionError: expected [Function] to not throw an error but 'Error: EACCES: permission denied, ope…' was thrown
+ Received: "Error: EACCES: permission denied, open '…/__test-fixtures-env__/.cross-dir-.dev.vars.tmp'"
 ❯ generate-env.test.ts:587:14
```

This reproduces the finding exactly — the four pre-existing write-behaviour tests all pass under the
mutant that the criterion names, and the new test is the only thing that moves.

Same mutant, uid 0 (`probe-root-mutB.log`):

```
running as uid=0
S2 permission-revocation signal: no throw            <- the EACCES signal is gone as root
S2 .dev.vars regenerated: true
S2 root-directory assertion (ino+mtime unchanged): false   <- this is what catches it
```

### Mutant A — the no-op check deleted (`if (existsSync … === content) return;` removed)

Real suite, uid 1000 (`mutA.log`, `GATE_EXIT=1`) — `Tests 2 failed | 120 passed (122)`:

```
× attempts no write at all when the generated content already matches disk 23ms
× builds its temporary file beside the target rather than in the tree root 16ms
```

Same mutant, uid 0 (`probe-root-mutA.log`):

```
running as uid=0
S1 permission-revocation signal: no throw            <- fails open, exactly as the finding said
S1 identity assertion (ino+mtime unchanged on all three): false   <- this is what catches it
S2 root-directory assertion (ino+mtime unchanged): false
```

(The second line is a correct incidental catch: with the no-op check gone, the two root files are also
rewritten via temp-and-rename, which churns entries in the root.)

### Control — correct code, uid 0 (`probe-root-correct.log`)

```
running as uid=0
S1 permission-revocation signal: no throw
S1 identity assertion (ino+mtime unchanged on all three): true
S2 permission-revocation signal: no throw
S2 .dev.vars regenerated: true
S2 root-directory assertion (ino+mtime unchanged): true
```

**Explicit confirmation, established rather than reasoned:** as root both permission-revocation signals
go silent while the code is correct *and* while either mutant is in place — the revocation is vacuous
for that identity, precisely as the audit said. The two new assertions separate correct code (`true`,
`true`) from both mutants (`false`) at uid 0. That is the discrimination, and it does not rest on mode
bits or on the machine's clock. It does not rest on device layout either: no assertion in either test
depends on two paths being on different filesystems, which was the defect in the cycle-1 `os.tmpdir()`
inversion.

The root replication runs on btrfs while the vitest fixture is on fuseblk; the two properties it relies
on (chmod does not move mtime, directory mtime tracks entry churn) were measured true on **both**
filesystems (`fsprobe-fuseblk.log`, `fsprobe-btrfs.log`), and the claim under test is about identity,
not about the filesystem.

## Production behaviour unchanged — confirmation

`sha256sum scripts/generate-env.ts`, taken as the first action of this cycle before any edit, and again
after the last mutant was reverted by hand:

```
cycle start : f92470050fcf0c6ccb841265e9bd8a86437bcc793af34408b6e039126fd96af5
cycle end   : f92470050fcf0c6ccb841265e9bd8a86437bcc793af34408b6e039126fd96af5
```

No mutant survives, and no behavioural change was made to the generator this cycle. `git status` still
shows the file modified relative to `HEAD` — that is cycle 1's approved production change, untouched.
The cycle-1 byte-identical-content comparison across all four modes therefore still stands unaltered;
it was not re-run, because the bytes it compared cannot have moved.

## Self-gate

Gate directory `/tmp/hb-gate/t1b`, `VITEST_MAX_WORKERS=6`, run from `scripts/`.

| Command                                                                                                 | Result                                                                     |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| gate: `run-package-tests.ts --coverage.reportsDirectory=$G/cov-final --coverage.include='generate-env*.ts' generate-env.test.ts` | **pass** — `GATE_EXIT=0` (from `$G/gate-final.exit`), 122/122, 1 file, no `POLE` line |
| coverage, read from `$G/cov-final/coverage-final.json`                                                   | `generate-env.ts` statements 100.00, functions 100.00, branches 95.65; files measured 1 |
| `npx tsgo --noEmit` (package's declared typecheck)                                                        | **pass** — exit 0, zero `error TS` lines                                   |
| `npx eslint generate-env.ts generate-env.test.ts` from `scripts/`, after the last edit                   | **pass** — `ESLINT_EXIT=0`, empty output                                   |
| `pnpm exec tsx scripts/verify-env.ts --mode=development`                                                  | **pass** — exit 0, `✓ All environment verifications passed`                 |

The gate command in §The concurrent gate protocol uses `../../scripts/with-env.ts`, which assumes a
two-level package directory; `scripts/` is one level, so the paths are `./with-env.ts` and
`./run-package-tests.ts`. First invocation died with `ERR_MODULE_NOT_FOUND` on
`…/projects/scripts/with-env.ts` before correction.

The two partial branches (lines 446, 486) are the pre-existing `else if (typeof raw === 'string')`
fallbacks in `generateOpsEnv`/`generateBuildEnv`, unchanged from cycle 1 and outside this task's code.
`writeGeneratedFile` has no uncovered statement or partial branch.

**Sibling-owned failures: none observed this cycle.** The audit's 8 typecheck and 4 lint errors in
`run-package-tests.ts` / `run-package-tests.test.ts` are gone — `npx tsgo --noEmit` over the whole
package is exit 0 with zero errors. Nothing was attributed outward because there was nothing to
attribute. I did not touch either file.

`--mode=ciVitest` and `--mode=ciE2E` were not run; the brief records them as failing for a
pre-existing reason (on-disk env files generated in development mode by the orchestrator).

## Acceptance criteria

1. **No write at all when content is unchanged, mode-bit-independently** — **met.** The strengthened
   test asserts `(ino, mtimeNs)` unchanged on all three paths against backdated timestamps, which holds
   regardless of process identity; demonstrated at uid 0, where it separates correct code from mutant A
   while the permission signal is silent. Permission revocation retained as the additional signal the
   criterion permits.
2. **Same-directory temp pinned by a test that actually discriminates** — **met.** The audit's exact
   cross-directory mutant now goes RED, shown above with the other four write-behaviour tests still
   green under it. The test carries no dependency on device layout, and its root-directory mtime
   assertion discriminates at uid 0 as well.
3. **Atomic when content differs; same-directory temp + `renameSync`** — **met**, unchanged from
   cycle 1 and now additionally pinned by criterion 2's test.
4. **Byte-identical generated content for all four modes** — **met**, unchanged from cycle 1; the
   generator is byte-identical to its cycle-start state, so cycle 1's three-way comparison still holds.
5. **`pnpm verify:env` still passes, `ensure-stack` otherwise untouched** — **met**, exit 0 for
   `--mode=development`; no `ensure-stack` file touched.

## Deviations

- **The audit's literal direction for finding 1 was not sufficient on its own** and was implemented with
  the backdating primitive added. A bare `toEqual(before[index])` would have passed here but is
  timing-dependent, and the measurement it was based on does not hold (evidence above). The direction's
  intent — a mode-bit-independent assertion — is met and strengthened, not narrowed.

## Concerns and limitations

- **The same-directory property is pinned through one of the three paths.** Only
  `apps/api/.dev.vars` has a target directory that differs from the tree root, so it is the only path
  where "beside the target" and "in the root" are distinguishable at all. All three route through the
  single `writeGeneratedFile` helper, so pinning it there pins the code for all three; a hypothetical
  per-path implementation would not be covered, and that is the limit of the test.
- **A temp placed in a writable third directory is still not caught by these two tests** — the root
  becoming unwritable and the root's mtime are what discriminate, so a mutant choosing, say,
  `apps/` would pass the new test. It would fail the existing `outside the system temp directory` test
  only for `os.tmpdir()` specifically. Fully general placement pinning would need to observe the temp
  path during the write, which `vi.spyOn` on `node:fs` cannot do in this package (`Module namespace is
  not configurable in ESM`, recorded in cycle 1).
- **The mode-bit-independence evidence is a replication, not the vitest test run as root.** The probe
  performs the same sequence against the same imported `generateEnvFiles`, but it is not the test file
  itself. Running vitest as root was rejected because its caches would land root-owned inside a repo
  other agents are actively writing.
- **The two out-of-scope writers remain destructive** (`apps/api/wrangler.toml`, four workflow YAMLs) —
  unchanged from cycle 1, recorded so it is not mistaken for fixed.

## Confidence

**High.** Both findings are closed with observed RED from the mutants that motivated them, including
the audit's exact mutant, and both new assertions are demonstrated to discriminate at uid 0 where the
old proof is provably vacuous. The one place I departed from the stated direction is backed by a
measurement that contradicts the direction's premise, and the generator's bytes are hash-verified
unchanged.
