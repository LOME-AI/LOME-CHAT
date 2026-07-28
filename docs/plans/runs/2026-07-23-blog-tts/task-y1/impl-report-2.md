# Y1 — fix cycle 1: the two cache-key gaps (implementation report 2)

## Objective

Close the two turbo cache-key gaps self-reported in report 1 and independently confirmed by an
auditor: `@hushbox/sandbox#build` has no cache-key sensitivity to the bundle guard's sources,
and `@hushbox/admin#build` has none to the security-header generator its own build hook runs.
Scope is exactly two files; nothing narrows.

## Files changed

- `apps/sandbox/turbo.json` (new) — package configuration extending the root (`extends: ["//"]`),
  adding the bundle guard's four sources to the build task's `inputs`. Only `inputs` is
  overridden; `outputs`, `dependsOn` and `env` are inherited.
- `apps/admin/turbo.json` — two entries added to the existing `inputs`:
  `../../scripts/generate-headers.ts` and `../../scripts/lib/headers-vite-plugin.ts`. Nothing
  removed. The comment was extended to record the header generator as the second tool the hook
  runs, and to state that only `inputs` is overridden.

Not changed: the root `turbo.json`, `scripts/` (probe edits were reverted byte-identically),
and every other file in the repo.

**Which files each package names, and why those:** `apps/sandbox/src/build.ts` imports
`scripts/verify-web-bundle.ts`, which imports `scripts/lib/ort-assets-plugin.ts`,
`scripts/lib/is-main.ts` and `scripts/lib/run-main.ts` — four files, all named.
`apps/admin/vite.config.ts` runs that same guard **plus** `scripts/generate-headers.ts` (via
`scripts/lib/headers-vite-plugin.ts`) from the same `closeBundle` — six files, all named. The
sandbox does **not** run the header generator (its `_headers` is a static file under
`apps/sandbox/public/`, covered by `$TURBO_DEFAULT$`), so naming the two header files there
would be noise that rebuilds the sandbox for changes it cannot observe. `tts-hosts.ts` and
`routes.ts` are `@hushbox/shared` files, already covered through `dependsOn: ["^build"]`.

## Tests added

None, and none is appropriate. The plan bans config-shape tests for this work (§Y1 criterion 4:
"This is an artifact-level assertion, not a config-shape test"); a test asserting a JSON file
contains a string would pass while the hash stayed frozen — which is exactly the failure mode
this fix exists to prevent. The behaviour under test is the turbo task hash, so the
red-green-refactor cycle was run against the hash itself: every named file was measured
NO-MOVE before the change and MOVED-and-RETURNED after, in controlled batches. Both batches are
transcribed below.

### Measurement protocol

`scripts/y1fix-probe.sh` (scratchpad, not in the repo) reads
`turbo run build --filter=<pkg> --dry=json` and extracts the task hash. Per probe file:
`idleA → append "// probe" → edited → restore from a byte copy → idleB`. A reading counts only
when `idleA == idleB`; a mismatch means a concurrent workstream moved the hash inside the
measurement window and the probe is retried. Every restore is verified by comparing the file's
sha256 before and after.

**Warm-up:** the first `--dry=json` of every batch is discarded, per the recorded daemon
staleness (the daemon serves config cached from before a `turbo.json` existed). Every reading
quoted below is at least the second run of that batch. The GREEN batches, run after both config
files existed, showed no degenerate shape at all — `outputs`/`dependsOn`/`env` were populated in
the first run too.

The drift the brief warned about is real and was observed once: in the RED admin batch,
`headers-vite-plugin.ts`'s first attempt drifted (`idleA=66b25749be81f966` →
`idleB=cbc69f99da7203f0`) with no edit of mine outstanding; the retry was stable. All quoted
readings are drift-free windows.

### `@hushbox/admin#build`

RED — before the change (`--force`-free dry runs, warm):

| probe file | idleA | edited | idleB (restored) | verdict |
| --- | --- | --- | --- | --- |
| `scripts/generate-headers.ts` | `66b25749be81f966` | `66b25749be81f966` | `66b25749be81f966` | **NO-MOVE** |
| `scripts/lib/headers-vite-plugin.ts` | `cbc69f99da7203f0` | `cbc69f99da7203f0` | `cbc69f99da7203f0` | **NO-MOVE** |

GREEN — after the change, all six named files in one batch, idle `7e6d5378b3c20224` throughout:

| probe file | edited | restored | verdict |
| --- | --- | --- | --- |
| `scripts/generate-headers.ts` | `3e858d7dc3a358fe` | `7e6d5378b3c20224` | **MOVED / RETURNED** |
| `scripts/lib/headers-vite-plugin.ts` | `789fd9eab9b2c3af` | `7e6d5378b3c20224` | **MOVED / RETURNED** |
| `scripts/verify-web-bundle.ts` | `56c871abc4d6a394` | `7e6d5378b3c20224` | **MOVED / RETURNED** |
| `scripts/lib/ort-assets-plugin.ts` | `fca06ad26152784f` | `7e6d5378b3c20224` | **MOVED / RETURNED** |
| `scripts/lib/is-main.ts` | `5c7c1eaa01c763f4` | `7e6d5378b3c20224` | **MOVED / RETURNED** |
| `scripts/lib/run-main.ts` | `f398850fe364e4c4` | `7e6d5378b3c20224` | **MOVED / RETURNED** |

The four previously-named files were re-measured deliberately: the edit had to be shown not to
have broken what report 1 established.

### `@hushbox/sandbox#build`

RED — idle `44d97e8a410e8981` for the whole batch; every one of the four files edited **and**
restored to the same `44d97e8a410e8981`: `verify-web-bundle.ts`, `lib/ort-assets-plugin.ts`,
`lib/is-main.ts`, `lib/run-main.ts` — all **NO-MOVE**. The guard was not part of the sandbox
cache key at all.

GREEN — after the change, idle `047c746aef237200` throughout:

| probe file | edited | restored | verdict |
| --- | --- | --- | --- |
| `scripts/verify-web-bundle.ts` | `8c705fe954cf42ec` | `047c746aef237200` | **MOVED / RETURNED** |
| `scripts/lib/ort-assets-plugin.ts` | `c60a50b8308958d7` | `047c746aef237200` | **MOVED / RETURNED** |
| `scripts/lib/is-main.ts` | `dfb5adf836858160` | `047c746aef237200` | **MOVED / RETURNED** |
| `scripts/lib/run-main.ts` | `e5616e9de499d602` | `047c746aef237200` | **MOVED / RETURNED** |

## Nothing narrowed — the superset property, measured

Resolved task definitions, from warmed-up `--dry=json`:

```
@hushbox/admin#build   inputs: ["$TURBO_DEFAULT$", "../../scripts/generate-headers.ts",
                                "../../scripts/lib/headers-vite-plugin.ts",
                                "../../scripts/lib/is-main.ts",
                                "../../scripts/lib/ort-assets-plugin.ts",
                                "../../scripts/lib/run-main.ts",
                                "../../scripts/verify-web-bundle.ts", ".env*"]
@hushbox/sandbox#build inputs: ["$TURBO_DEFAULT$", "../../scripts/lib/is-main.ts",
                                "../../scripts/lib/ort-assets-plugin.ts",
                                "../../scripts/lib/run-main.ts",
                                "../../scripts/verify-web-bundle.ts", ".env*"]
```

Both retain the root task's complete input set (`["$TURBO_DEFAULT$", ".env*"]`) verbatim and add
named files on top — strict superset by inspection. The admin set is also a strict superset of
its own pre-change set: the six entries include the four that were there, plus two.

Proven at the resolved-file level, not only by reading the config. Each package's
`turbo.json` was moved aside, the dry run repeated (warm), and the file count compared:

| package | inherited baseline (no package `turbo.json`) | with the package `turbo.json` | delta |
| --- | --- | --- | --- |
| `@hushbox/admin` | `["$TURBO_DEFAULT$",".env*"]`, 152 files | 159 files | +6 named + the `turbo.json` itself |
| `@hushbox/sandbox` | `["$TURBO_DEFAULT$",".env*"]`, 54 files | 59 files | +4 named + the `turbo.json` itself |

The arithmetic is exact in both cases, so no in-package file that `$TURBO_DEFAULT$` used to
cover was dropped. Both `turbo.json` files were restored byte-identically (sha256 compared).

## Inheritance still correct

Resolved from the same warmed-up dry runs. Identical for both packages, and identical to the
root `build` task:

| field | `@hushbox/admin#build` | `@hushbox/sandbox#build` | root `build` |
| --- | --- | --- | --- |
| `outputs` | `["dist/**"]` | `["dist/**"]` | `["dist/**"]` |
| `dependsOn` | `["^build","fetch-pyodide"]` | `["^build","fetch-pyodide"]` | `["^build","fetch-pyodide"]` |
| `env` | `["ESM_CDN_URL"]` | `["ESM_CDN_URL"]` | `["ESM_CDN_URL"]` |
| `cache` | `true` | `true` | (default `true`) |

`env` inheritance was also confirmed behaviourally: running the sandbox build with
`ESM_CDN_URL` set produced task hash `27abc84dc0a84a73` against the `047c746aef237200` measured
with it unset — the variable is genuinely hashed, so `extends` did not drop it.

## Builds still pass and still gate

| what | command | result |
| --- | --- | --- |
| sandbox, through turbo | `ESM_CDN_URL=… turbo run build --filter=@hushbox/sandbox --force` | exit 0, `✓ sandbox dist assembled`, 2/2 tasks |
| sandbox, failing direction | same, with a 15 B `ort-wasm-simd-threaded.jsep.wasm` planted in `apps/sandbox/public/` | **exit 1** — `TTS artifact in a bundle declared TTS-free: ort-wasm-simd-threaded.jsep.wasm (15 B)` |
| sandbox, restored | same, planted file removed | exit 0 |
| admin, through turbo | `ESM_CDN_URL=… turbo run build --filter=@hushbox/admin` | exit 0, 1/1 task |
| admin, direct | `pnpm build` in `apps/admin` | exit 0; `dist/_headers` present |
| admin, failing direction | same, with the fake wasm planted in `apps/admin/public/` | **exit 1** — same TTS-artifact violation |
| admin, restored | same, planted file removed | exit 0 |

Both planted files were deleted; `git status --porcelain apps/admin apps/sandbox` shows only
`apps/admin/vite.config.ts` and `apps/sandbox/src/build.ts` (both pre-existing from cycle 1) plus
the two untracked `turbo.json` files.

Running the sandbox through `turbo` rather than `pnpm` matters here: it is the path that parses
the new `turbo.json`, and a malformed one would have failed the run rather than been ignored.

## Self-gate

| Command | Result |
| --- | --- |
| `prettier --check apps/admin/turbo.json apps/sandbox/turbo.json` | **pass** — "All matched files use Prettier code style!" |
| `turbo run test typecheck lint --filter=@hushbox/sandbox --force` | **pass** — 4/4 tasks, 0 cached |
| `turbo run test typecheck lint --filter=@hushbox/admin --force` | **pass** — 3/3 tasks, 0 cached |
| `eslint turbo.json` from each package dir, after the last edit | exit 0 — "File ignored because no matching configuration was supplied" (warning). ESLint's config does not match `.json`; `prettier --check` above is the real formatting gate for these two files. |

`@hushbox/admin#typecheck` is **green this cycle**. Report 1 recorded it failing on
`apps/api/src/slices/models/domain/trial-eligibility.ts(120,5) TS2353`; that foreign breakage has
since been fixed by its owning workstream, as the brief stated.

Not re-run, because a `turbo.json` `inputs` list cannot affect them: `pnpm arch:check` (ts-morph
rules over TypeScript), `lint:unused`, and the `@hushbox/scripts` suite — no `scripts/` file was
left changed.

## Acceptance criteria

**Gap 1 — `apps/sandbox` gets the same `extends: ["//"]` file as `apps/admin`. MET.**
`apps/sandbox/turbo.json` created; `@hushbox/sandbox#build`'s hash now moves for all four guard
sources and returns on restore (table above), where before the change all four were NO-MOVE at
`44d97e8a410e8981`. `outputs`/`dependsOn`/`env` inherited unchanged. Build passes and still gates.

**Gap 2 — `apps/admin/turbo.json` covers `generate-headers.ts` and `headers-vite-plugin.ts`.
MET.** Both added; both move the hash and return (table above), where before both were NO-MOVE.
The four pre-existing entries were re-measured and still move.

**Do not narrow anything. MET.** Both resolved `inputs` retain `["$TURBO_DEFAULT$", ".env*"]`
verbatim and add on top; the resolved-file counts confirm the additions are purely additive
(+6/+4 named files, no in-package file lost).

**Scope — exactly two files. MET.** `git status --porcelain` shows my only additions are
`apps/sandbox/turbo.json` (new) and `apps/admin/turbo.json` (edited). `package.json` and
`scripts/build-web-bundle.ts`, named as concurrently owned by another task, were not touched.

## Deviations

None. Both changes landed in the files the brief named, in the shape it specified.

## Concerns and limitations

- **A real cache *hit* is still not demonstrable in this checkout**, for the reason report 1
  recorded: concurrent workstreams move the hash between runs (observed once mid-batch here,
  and handled by the drift check). The evidence is the cache **key**'s sensitivity, measured in
  both directions on every named file. The hash is the cache key, so this is the property that
  matters; it is not a full end-to-end cache-restore demonstration.
- **The `inputs` lists are named file by file and will drift if the import graph grows.** If
  either build hook gains a new local `scripts/` import, its file must be added here or the gap
  reopens silently — nothing fails loudly. A `scripts/**` glob would be self-maintaining but
  would rebuild both apps on every unrelated script edit; the trade is recorded in each file's
  comment. This is a standing maintenance cost, not a defect of this change.
- **Two mechanisms now share one `inputs` list in `apps/admin/turbo.json`** (the bundle guard and
  the CSP generator). They are separate concerns that happen to run in the same `closeBundle`,
  which is why the comment names both explicitly rather than describing "the build's scripts".
- **The web app has the same structural exposure and is out of scope.** `apps/web`'s build runs
  the guard through `scripts/build-web-bundle.ts`, and `apps/web` has no package `turbo.json` —
  but `pnpm build:e2e` / the CI web builds do not go through a cached `turbo run build` for the
  OTA dists, and the brief scopes this cycle to two files. Flagged, not fixed.

## Confidence

**High.** Every claim here is a measured reading in a drift-checked window, both directions, on
both packages: NO-MOVE before, MOVED-and-RETURNED after, with byte-identical restores verified by
sha256. The superset property is proven by resolved-file arithmetic rather than by reading the
config, and both builds were executed through turbo in the passing and the failing direction.
