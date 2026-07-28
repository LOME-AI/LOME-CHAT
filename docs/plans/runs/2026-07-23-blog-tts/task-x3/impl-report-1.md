# X3 — impl report 1

## Objective

Declare the phantom `onnxruntime-common` dependency of `@huggingface/transformers` with a
pnpm `packageExtensions` entry, retire the containment mechanisms that declaration makes
redundant, and prove each retirement rather than assuming it.

## Baseline drift check

Verified before the first edit, against the orchestrator's stated baseline:

| Baseline claim | Observed | Drift |
| --- | --- | --- |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `packages/ui/package.json`, `knip.jsonc` clean vs HEAD | all four clean (`git status --porcelain` empty for them) | none |
| `ls node_modules/.pnpm/ \| grep -c '^onnxruntime-common@'` = 2 | 2 — `1.21.0`, `1.22.0-dev.20250409-89f8206ba4` | none |
| no warm `kokoro-js` prebundle in either app | `apps/marketing/node_modules/.vite/deps` had no `kokoro-js*`; `apps/web/node_modules/.vite/deps` did not exist | none |

`scripts/verify-web-bundle.ts` was already modified vs HEAD — that is X1/X5a's landed work
in this run, expected, not drift.

## Files changed

- `pnpm-workspace.yaml` — adds the `packageExtensions` entry (criterion 1) and deletes the
  `publicHoistPattern` block the falsification gate retired (criterion 6).
- `pnpm-lock.yaml` — install output; the declared edge and the extensions checksum.
- `packages/ui/package.json` — removes the `onnxruntime-common` pin (criterion 4).
- `knip.jsonc` — removes the `packages/ui` `ignoreDependencies` entry and its rationale
  comment, which described the now-deleted pin (criterion 4).
- `scripts/verify-web-bundle.ts` — `declaredOrtCommonVersion()` re-pointed at the
  `packageExtensions` entry (criterion 5); two prose sites that asserted the removed
  `packages/ui` pin as the deciding mechanism corrected (a violation message and the file
  header's version-skew bullet), because they now state something false.
- `scripts/verify-web-bundle.test.ts` — the `declaredOrtCommonVersion` suite rewritten
  against the new source of truth.

## Tests added

All in `scripts/verify-web-bundle.test.ts`, `describe('declaredOrtCommonVersion')`. They
replace three tests that fed the function a JSON manifest, which no longer type-checks as
an input.

| Test | Behavior | Criterion |
| --- | --- | --- |
| `returns the version the transformers package extension declares` | parses the exact version out of a fixture workspace file carrying a version (`9.8.7-dev.20250101-abcdef0`) that appears nowhere else in the repo | 5 |
| `reads the repository's own workspace file when given no path` | the zero-arg default resolves to the real `pnpm-workspace.yaml` and finds the entry | 5 |
| `rejects a workspace file declaring no onnxruntime-common extension` | missing declaration throws | 5 (failure path) |
| `rejects a range where an exact onnxruntime-common version is required` | `^1.22.0` throws and names the offending value | 5 (failure path) |

RED was observed for all four before implementing: with the function still reading a JSON
manifest, the three fixture-driven tests failed with
`Unexpected token 'p', "packageExt"... is not valid JSON` — the wrong failure for the
assertion, i.e. failing because the feature was absent. The zero-arg test passed at RED
(both sources then held the same string); it became discriminating once the
`packages/ui` pin was deleted, at which point the old implementation could not satisfy it
at all.

## Acceptance criteria

### 1. `packageExtensions` entry with the exact selector — MET

```yaml
packageExtensions:
  '@huggingface/transformers@3.8.1':
    dependencies:
      onnxruntime-common: 1.22.0-dev.20250409-89f8206ba4
```

The comment above it records: why the edge is declared here rather than patched (pnpm
builds the graph from the resolver manifest, before patches touch files); why the selector
is one exact transformers version and the value an exact version, never a range (a range
keeps applying beside a future newer `onnxruntime-web`, installing a real second copy and
splitting `instanceof Tensor`); how it fails safe on a transformers bump; and that
`checkOrtCommonVersion` is not a mirrored constant to clean up, because the only other
declaration of this version is upstream's own manifest, which cannot be imported or shared.

### 2. Lock diff — MET, with one characterised extra (raised)

`git diff pnpm-lock.yaml` in full, line by line:

| Lines | What | Assessment |
| --- | --- | --- |
| `overrides:` block, 7 entries reordered | pnpm 10.26 rewrote the block in sorted key order | **Not in the criterion's list.** Zero version movement: `diff <(HEAD block sorted) <(new block sorted)` is empty — same 7 keys, same 7 values, order only. |
| `+packageExtensionsChecksum: sha256-cJaACgkhhUtJz1d1bVdP3GFpauNSNvrt67th3f7Zj/g=` | the criterion's first expected line | expected |
| `-onnxruntime-common: specifier/version` under the `packages/ui` importer | criterion 4's own removal | expected consequence of criterion 4 |
| `+onnxruntime-common: 1.22.0-dev.20250409-89f8206ba4` under `snapshots: '@huggingface/transformers@3.8.1'` | the criterion's second expected line — the new edge | expected |

That is the entire diff: 7 insertions, 7 deletions, no other hunk. **No version moved
anywhere in the lockfile**, which is the risk this criterion exists to catch, so I did not
stop. The overrides reordering is a formatting normalisation by the pnpm version already in
use; it is reported here rather than silently absorbed.

### 3. Symlink and copy count — MET (the Inferred premise holds)

Before:

```
node_modules/.pnpm/@huggingface+transformers@3.8.1/node_modules/
  @huggingface/  onnxruntime-node -> …  onnxruntime-web -> …  sharp -> …
```

no `onnxruntime-common`. Copies: 2 (`1.21.0`, `1.22.0-dev.20250409-89f8206ba4`).

After:

```
onnxruntime-common -> ../../onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/node_modules/onnxruntime-common
```

Copies: **still 2**, the same two directories — no third installed. Re-checked after each
of the four installs performed during this task; stable at 2 throughout.

### 4. `packages/ui` pin and knip ignore removed — MET

Both deleted. Non-vacuity proof for the knip half: running knip with HEAD's `knip.jsonc`
against the current tree reports
`onnxruntime-common  packages/ui  knip.jsonc  Remove from ignoreDependencies` — knip itself
demands the removal once the pin is gone. With my `knip.jsonc` that hint is absent.

### 5. `declaredOrtCommonVersion()` re-pointed, failure path still tested — MET

Reads `pnpm-workspace.yaml` via a structural regex requiring the transformers selector, its
`dependencies:` map and the `onnxruntime-common:` key each on its own consecutive line, so
a value from any other block cannot pass for it. The `EXACT_VERSION` assertion is unchanged.
Parsing the file line-structurally rather than with a YAML library follows the existing
precedent in `scripts/workspaces.ts`, and avoids adding a dependency — which would itself
have moved the lockfile and broken criterion 2.

Proof it reads the new source, beyond the unit tests: `packages/ui/package.json` no longer
declares `onnxruntime-common` at all, so the previous implementation would now throw on
every call; the guard runs green.

Proof the failure path still throws, demonstrated end to end on the real file (doctored,
then restored):

- value doctored to an exact-but-wrong `1.21.0` → `pnpm verify:web-bundle` exits 1 with
  `shipped onnxruntime-common version is 1.22.0-dev.20250409-89f8206ba4, expected 1.21.0`
  on all four built worker chunks. This proves the guard is non-vacuous *and* that its
  expected value now comes from the workspace file.
- value doctored to the range `^1.22.0` → exits 1 with
  `pnpm-workspace.yaml must declare onnxruntime-common at an exact version in the
  @huggingface/transformers packageExtensions entry (found ^1.22.0)`.

`checkOrtCommonVersion` itself is untouched and stays.

### 6. Falsification gate for retiring `publicHoistPattern` — MET (it retires)

Method, identical before and after, on both apps: `rm -rf <app>/node_modules/.vite/deps`,
start the app's own dev server (`astro dev` / `vite`, not the full `pnpm dev` stack), wait
for ready, `curl` the TTS worker's dev URL
(`/@fs/…/packages/ui/src/components/accessibility/lib/tts.worker.ts?worker_file&type=module`)
to force the optimizer to discover `kokoro-js` — X4 has not landed, so discovery is still
first-fetch — then poll for `deps/kokoro-js.js` and measure it the moment it settles.

| Measurement | BEFORE (`publicHoistPattern` present, no extension) | AFTER (extension present, `publicHoistPattern` deleted) |
| --- | --- | --- |
| marketing `deps/kokoro-js.js` bytes | 4,218,286 | 4,218,286 |
| web `deps/kokoro-js.js` bytes | 4,218,286 | 4,218,286 |
| sha256 (all four) | `662e231a994c42a20635c05d5ac516ac752b3ace3ee3472c0a022a04bf5365ca` | same |
| ESM imports in the prebundle | one, relative: `from "./chunk-XkmBru0b.js"` | identical |
| ORT inline region markers `onnxruntime-common@1.22.0-dev…` | 14 | 14 |
| region markers `onnxruntime-common@1.21.0` | 0 | 0 |
| separate `onnx*` chunk in `deps/` | none | none |

Byte-identical, not merely same-sized, so no sourcemap-name drift needed explaining. ORT
stays inlined (the file opens with `//#region ../../node_modules/.pnpm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/…`),
zero bare specifiers survive, nothing splits into a second chunk. `publicHoistPattern` is
therefore retired and the task lands the intended two-piece end state, not three.

One install-debris trap worth recording: after deleting `publicHoistPattern` and
reinstalling, pnpm **left the stale `node_modules/onnxruntime-common` public-hoist symlink
in place**. Measuring at that point would have silently measured the old mechanism still
working. I removed the stale link and reinstalled; pnpm did not recreate it, and only then
took the AFTER measurements.

### 7. Production build + `verify:web-bundle` — MET

`pnpm build:web` builds both apps, merges, verifies, then generates CSP headers. Because
turbo reported `FULL TURBO` on the app builds, I discarded that run's artifact and rebuilt
with the cache bypassed (`turbo build --force --filter=@hushbox/web --filter=@hushbox/marketing`,
`Cached: 0 cached, 2 total`), re-ran `merge-marketing-into-web.ts`, then
`pnpm verify:web-bundle`.

- `pnpm verify:web-bundle` → exit 0, `Verified …/apps/web/dist`.
- `dist/ort/*` sha256 **unchanged** across the rebuild and identical to the installed
  transformers runtime:
  `08fb86ec…` (`ort-wasm-simd-threaded.jsep.mjs`), `c46655e8…` (`ort-wasm-simd-threaded.jsep.wasm`).
- The built worker chunk keeps its pre-change content hash (`assets/tts.worker-Bt4m7Yrn.js`)
  and reports `1.22.0-dev.20250409-89f8206ba4`; `checkOrtCommonVersion` passes on it.

`pnpm build:web` as a whole exits 1, at the step *after* verification:
`generate-headers.ts` fails with `VITE_API_URL must be set (got undefined)`. That step needs
env this shell does not carry and the fix is `pnpm generate:env`, which the brief forbids
(it rewrites `.github/workflows/ci.yml`, already carrying a foreign diff). Unrelated to X3 —
the verify call runs before it and passed.

## Which containment pieces were retired

| Piece | Disposition | Evidence |
| --- | --- | --- |
| `publicHoistPattern: [onnxruntime-common]` | **retired** | criterion 6's before/after: byte-identical prebundle on both apps with the pattern deleted *and* the stale root symlink removed |
| `onnxruntime-common` pin in `packages/ui/package.json` | **retired** | forced production rebuild + `verify:web-bundle` green, shipped version still `1.22.0-dev…`; `packages/ui` accessibility suite 540/540 green |
| `knip.jsonc` `ignoreDependencies` for it | **retired** | knip is clean of it with my config, and demands its removal with HEAD's config |
| `checkOrtCommonVersion` build guard | **kept**, per criterion 5 | the only check on which ORT version actually ships; proven non-vacuous above by doctoring the declared value |

Net: four mechanisms → two (the `packageExtensions` declaration plus the guard).

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm exec eslint verify-web-bundle.ts verify-web-bundle.test.ts` (from `scripts/`, after the last edit) | **pass** — exit 0 |
| `pnpm exec eslint .` (from `scripts/`) | **pass** — exit 0 |
| `pnpm exec prettier --check pnpm-workspace.yaml knip.jsonc packages/ui/package.json` | **pass** |
| `turbo test typecheck lint --filter=@hushbox/scripts --continue` | typecheck **pass**, lint **pass**, test **fail** — 88 passed / 2 failed files (both foreign, below) |
| `vitest run verify-web-bundle.test.ts` | **pass** — 35/35 |
| `vitest run verify-web-bundle.test.ts --coverage.include=verify-web-bundle.ts` | **pass** — 100% stmts (114/114), 100% branch (50/50), 100% funcs (32/32), 100% lines |
| `pnpm lint:unused` (knip) | **fail** — 2 findings, both foreign (below) |
| `pnpm verify:web-bundle` | **pass** — exit 0 |
| `vitest run src/components/accessibility/lib/` (from `packages/ui/`) | **pass** — 540/540, 20 files |

### Attributed failures — none mine

**`@hushbox/scripts` test gate, 2 files.** `refresh-catalog-run.test.ts` and
`seed-run.test.ts`, both:

```
Cannot find module '…/scripts/node_modules/.vite/vitest/<hash>/deps_ssr/@hushbox_db.js&v=8a56db6e'
  code: 'ERR_MODULE_NOT_FOUND'
```

Exactly the two files §KNOWN PRE-EXISTING FAILURES names. The referenced file *exists*; the
import URL carries a `&v=` query suffix Node's ESM loader cannot resolve — a vitest
dep-optimizer artifact, and it reproduces after the cache regenerates. Neither file imports
anything I changed (no `verify-web-bundle`, no `onnxruntime`, no workspace/knip config);
neither touches `packages/ui`. `generate-env.test.ts`, also listed as red in that section,
now passes — another workstream fixed it.

I did run four `pnpm install`s, which relink `node_modules` and can invalidate vitest dep
caches. I cannot rule out that this aggravated the *timing* of these two failures, but the
failure class and the exact two files were recorded before this task began.

**knip, 2 findings.** `packages/config/vitest.package.config.ts` unused (documented as a
concurrent-agent finding in at least four other run reports in this repo) and
`wrangler apps/sandbox  Remove from ignoreDependencies`. Proven pre-existing rather than
argued: running knip with **HEAD's** `knip.jsonc` produces both findings unchanged, plus
the `onnxruntime-common packages/ui` hint that my change removes. `apps/sandbox` and
`packages/config/vitest.package.config.ts` are unmodified against HEAD by me.

## Deviations

1. **Two prose corrections in `scripts/verify-web-bundle.ts` beyond the criteria.** The
   `checkOrtCommonVersion` violation message said "pnpm hoisted a copy other than the one
   `packages/ui` pins", and the file header said the copy "is decided by pnpm's hoist
   selection". Both became false the moment criterion 4 landed. Under CODE-RULES a wrong
   comment is worse than none, so both now describe the package-extension mechanism. No
   behavior change; the tests that pin the message content still pass.
2. **`turbo build --force`.** Used only to defeat a `FULL TURBO` cache hit that would have
   let a pre-change artifact satisfy criterion 7. Not used to silence any check.

## Concerns and limitations

- **The regex is structural and therefore strict.** A reformat of the `packageExtensions`
  block that inserts a line between the selector, `dependencies:` and the key — a comment,
  a blank line, a sibling dependency listed first — makes the guard throw rather than read
  a wrong value. That is the fail-safe direction, and the error names the file and what it
  must contain, but it is a real footgun for a future editor.
- **`pnpm build:web` cannot run to completion in this shell** (`VITE_API_URL`), so
  criterion 7 was satisfied by the verify step plus a forced rebuild, not by one green
  invocation of the wrapper script. Per §X1's audit that wrapper is in no workflow anyway.
- **X4 has not landed.** Criterion 6's measurement therefore drove discovery by fetching the
  worker URL. When X4 adds `optimizeDeps.entries`, `kokoro-js` will be prebundled at
  startup; the prebundle content should be unaffected, but X4's own criterion 5 re-checks
  the same property and should be read as the live confirmation.
- **Four `pnpm install`s ran** while three other workstreams were building and testing in
  this checkout. Transient failures in their runs during that window are expected.

## Confidence

**High.** Every criterion has a measurement rather than an inference: the Inferred symlink
premise was confirmed directly, the prebundle comparison is byte-identical on both apps
rather than approximately equal, the guard's non-vacuity was demonstrated by doctoring the
real declaration in both failure directions, and both remaining gate failures were shown
foreign by reproducing them against HEAD's configuration.
