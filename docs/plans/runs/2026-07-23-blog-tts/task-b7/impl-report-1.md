# B7 — `onnxruntime-web` direct dependency: investigate, remove if unused

## Objective

Determine why `packages/ui/package.json` declares `onnxruntime-web ^1.26.0` when no source
file imports it, and remove it if nothing needs it. Founder ruling: "investigate and remove
if truly unused."

## Determination

**It is NOT unused. It is kept, and the missing justification is now documented.**

The dependency is never imported by any source file, but it is load-bearing for the built
output: it decides which `onnxruntime-common` version pnpm hoists, and that copy supplies the
`Tensor` class the TTS worker actually uses at runtime. Removing it changes the shipped worker
bundle.

### Evidence per investigation item

**1. Type resolution — NOT the reason. Verified.**

- No `.ts`/`.tsx`/`.astro`/`.mjs` outside `node_modules` and `legacy/` contains an import from
  `onnxruntime-web`; the only repo references are prose comments plus the knip entry
  (`grep` over the tree).
- `@huggingface/transformers`' and `kokoro-js`' `.d.ts` files reference only
  `onnxruntime-common` (e.g. `kokoro-js/types/kokoro.d.ts:270`:
  `let wasmPaths: import("onnxruntime-common").Env.WasmPrefixOrFilePaths`). Zero
  `onnxruntime-web` type references.
- Empirically: `turbo typecheck --filter=@hushbox/ui --filter=@hushbox/web
  --filter=@hushbox/marketing` passes **with the dependency removed** (0 errors, 3/3 tasks).
  The base tsconfig sets `skipLibCheck: true`, so third-party `.d.ts` resolution is not a gate
  either way. Typecheck was never the discriminator.

**2. The ORT assets plugin's resolution anchor — NOT the reason. Verified.**

`scripts/lib/ort-assets-plugin.ts:67-71` anchors on `packages/ui/package.json` but resolves
`kokoro-js` → `@huggingface/transformers`, then reads `ort-*.{wasm,mjs}` out of **transformers'
own `dist/`** — it never resolves `onnxruntime-web` at all. The two served files are
`@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.{mjs,wasm}` (44,484 B / 21,596,019 B),
which is why `dist/ort/` bytes are invariant under this dependency. No plugin change was needed;
`scripts/lib/ort-assets-plugin.ts` was not edited.

**3. Peer/optional resolution and pnpm hoisting — THIS is the reason. Verified.**

`@huggingface/transformers`' browser build externalizes **two** bare specifiers, not one:

```
import * __WEBPACK_EXTERNAL_MODULE_onnxruntime_common_82b39e9f__ from "onnxruntime-common";
import * __WEBPACK_EXTERNAL_MODULE_onnxruntime_web_74d14b94__    from "onnxruntime-web";
```

and re-exports the common one's class:

```
Tensor: () => (/* reexport safe */ onnxruntime_common__WEBPACK_IMPORTED_MODULE_3__.Tensor)
```

`.Tensor` is the **only** runtime member taken from that module (all other `onnxruntime-common`
references in the file are JSDoc types).

- `onnxruntime-web` resolves deterministically to transformers' own peer copy:
  `node_modules/.pnpm/@huggingface+transformers@3.8.1/node_modules/onnxruntime-web ->
  ../../onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/...`. Unaffected by the direct dep.
- `onnxruntime-common` is **absent** from transformers' peer directory (contents:
  `@huggingface`, `onnxruntime-node`, `onnxruntime-web`, `sharp`), so resolution walks out to
  pnpm's hoist directory `node_modules/.pnpm/node_modules/onnxruntime-common` — whose version
  is decided by whatever else in the workspace depends on it.
- With the direct dep: hoisted `onnxruntime-common` = 1.26.0. With it removed: 1.21.0 (pulled
  up from `onnxruntime-node@1.21.0`, transformers' node-side dep). Reproduced in both
  directions across four installs.

This is visible in the shipped bytes. The built TTS worker chunk contains two ORT env objects —
one inlined by `ort.min.mjs` (``versions:{common:`1.22.0-dev.20250409-89f8206ba4`}``) and one
from the separately resolved module:

| build | bundled `versions:{common:…}` | web worker chunk sha256 |
|---|---|---|
| dep present (baseline) | `1.26.0` | `2d245ac8…addca` |
| dep removed | `1.21.0` | `49094803…1d42` |
| dep present (control rebuild) | `1.27.0` | `e7b88dd1…5c3d` |

First differing byte between the with-dep and without-dep worker chunks is at offset 2165, and
it is exactly that version literal.

**4. Would removal change the shipped ORT version? — Split answer. Verified.**

- The self-hosted ORT **runtime** does not change: `dist/ort/` bytes are identical (sha256s
  below), and onnxruntime-web stays 1.22.0-dev either way.
- The companion `onnxruntime-common` module that ships **inside the worker JS** does change,
  1.26.0 → 1.21.0, taking the `Tensor` implementation with it.

Per the brief's stop-and-report rule ("if removal would change the SHIPPED ORT version, stop
and report — that is a behavior change, not a cleanup"), the removal was **not** kept. The
brief's other branch applies: keep the dependency and document precisely what requires it.

## Files changed

- `knip.jsonc` — added the missing justification comment above the `packages/ui`
  `ignoreDependencies: ["onnxruntime-web"]` entry, stating that the dependency pins the hoisted
  `onnxruntime-common` (whose `Tensor` transformers re-exports) and that it is unrelated to the
  self-hosted `/ort/` assets. Comment-only; the entry itself is byte-identical to before.

Nothing else. `packages/ui/package.json` and `scripts/lib/ort-assets-plugin.ts` are unchanged
from their pre-task state (`git diff HEAD -- packages/ui/package.json` contains zero
`onnxruntime` lines; its remaining diff is other tasks' export entries).

## Tests added

None. The task is an investigation with a comment-only outcome; there is no new behavior to pin.
The proof obligation is B6's `verifyWebBundle`, which ran (and passed) in all four builds — see
`scripts/build-web-bundle.ts:89`, immediately before the `generate-headers` step every build
reached.

## Self-gate

| command | result |
|---|---|
| `pnpm build:web` ×4 (baseline / removed / control with-dep / final) | build + merge + `verifyWebBundle` pass; each stops at `generate-headers.ts` with `VITE_API_URL must be set (got undefined)` — a prod-env precondition unavailable locally, identical in every run including the untouched baseline |
| `turbo typecheck --filter=@hushbox/ui --filter=@hushbox/web --filter=@hushbox/marketing --force` | pass — 3 successful, 3 total, 0 errors |
| `pnpm lint:unused` (knip) | **clean for this entry** — no `Remove from ignoreDependencies` hint for `onnxruntime-web`, i.e. the ignore is still required. The run exits 1 on two unrelated ambient items (below) |
| `prettier --check knip.jsonc packages/ui/package.json` | pass |
| `eslint knip.jsonc` | n/a — no root ESLint config; `.jsonc` at repo root is covered by Prettier only |

knip's two failures, both outside this task's ownership and both from the concurrent untracked
`apps/sandbox` workstream / pre-existing uncommitted config edits (the same edits already
visible in `git diff knip.jsonc` as hunks I did not write):

```
Unused files (1)
packages/config/vitest.package.config.ts
Configuration hints (1)
wrangler  apps/sandbox  knip.jsonc  Remove from ignoreDependencies
```

## Acceptance criteria

1. **A determination, with evidence, of whether anything requires the direct dep — MET.**
   Types: no. Plugin anchor: no. pnpm hoist resolution of `onnxruntime-common`: **yes**.
   Evidence above (symlink targets, transformers' externals + `Tensor` re-export, hoisted
   version flip reproduced in both directions, bundled version literal at byte 2165).
2. **If unused, remove it and the knip ignore; if used, keep it and add the missing
   justification comment — MET (used branch).** Dependency and knip entry retained; the
   justification comment is added.
3. **B6's verifier passes and `dist/ort/` bytes unchanged — MET.**
   Baseline and final builds both produce exactly the brief's expected hashes:
   ```
   c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39  dist/ort/ort-wasm-simd-threaded.jsep.wasm
   08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9  dist/ort/ort-wasm-simd-threaded.jsep.mjs
   ```
   These hashes held in **all four** builds, including the one with the dependency removed —
   confirming the `/ort/` assets are sourced from transformers' dist and are structurally
   independent of this dependency. Stronger restoration proof: both TTS worker chunks are
   byte-identical to the baseline in the final build
   (`2d245ac8…addca` web, `526bd8ff…9c2d` marketing-merged), as are the `accessibility`,
   `tts-engine`, `document-reader` and `blog-reader` chunks. No stray `ort-wasm*` exists
   outside `dist/ort/`, and the worker still references `/ort/` with zero
   `ort-wasm-simd-threaded.jsep.wasm` literals (the B6 extern-wasm condition still applies).
4. **`pnpm lint:unused` clean for this entry — MET.** See self-gate.

## Deviations

- **The brief's primary hypothesis (remove it) was not carried out**, because the investigation
  it mandated disproved the premise. The brief anticipated this with both an explicit
  stop-and-report clause and an "if used, keep and document" branch; the latter is what shipped.
- **`pnpm-lock.yaml` was written**, which is outside the stated BOUNDS. Unavoidable: testing
  removal requires `pnpm install`, which rewrites the lockfile. Two consequences, both handled:
  - The removal's *incremental* lockfile effect was isolated by installing with and without the
    dependency and diffing the two generated lockfiles against each other (not against HEAD):
    exactly 22 lines, all `onnxruntime-web`/`onnxruntime-common` entries. Nothing else.
  - The first reinstall floated `^1.26.0` to the newly published **1.27.0**, which would have
    silently bumped the shipped `Tensor`. The `onnxruntime-*` lockfile entries were restored to
    HEAD's 1.26.0 resolutions (integrity hashes taken from `git show HEAD:pnpm-lock.yaml`) and
    reinstalled; `diff` of all `onnxruntime` lines against HEAD's lockfile is now empty, and the
    final build reproduces the baseline worker chunks byte-for-byte.
  - The remaining large `pnpm-lock.yaml` diff versus HEAD (apps/sandbox importer,
    `@cloudflare/vitest-pool-workers`, some `vite@8.1.5` peer resolutions) is **pre-existing
    drift, not mine**: `apps/sandbox/` is untracked yet has installed `node_modules`, so HEAD's
    lockfile cannot describe the installed workspace; and the `node_modules/.pnpm/vite@8.1.5*`
    directories are dated 2026-07-24 01:47–03:01, before this session. `apps/web/node_modules/vite`
    still points at `rolldown-vite@7.3.1` (dated 2026-07-12), so the app build toolchain is
    untouched.

## Concerns and limitations

- **The pin is accidental and fragile, and this is the real finding.** Nothing declares intent:
  `^1.26.0` is a caret range on a package we do not import, so a fresh install already floats it
  (observed: 1.26.0 → 1.27.0 within this task), silently changing the `Tensor` implementation in
  the shipped worker. And the version it selects (1.26/1.27) never matches the ORT runtime that
  actually executes (1.22.0-dev) — the mismatch is merely tolerated today.
  The coherent fix is to declare `onnxruntime-common` directly, exact-pinned to transformers'
  `1.22.0-dev.20250409-89f8206ba4`, and drop `onnxruntime-web`. That is a dependency change
  (approval-gated) and it would change shipped bytes, so it was not taken here.
- **The `Tensor` cross-copy compatibility is untested at any version.** Today's shipped
  combination (ORT runtime 1.22.0-dev + `Tensor` from onnxruntime-common 1.26.0) works only by
  duck typing. Whether 1.21.0 would also work is unknown and was not tested — validating it
  needs a real browser TTS run, not available here. That uncertainty is precisely why the
  removal was rejected rather than shipped-and-hoped.
- **The full `dist` manifest is not byte-identical to the baseline** (50 differing lines in
  `chat._id`, `document-panel`, `authenticated-chat-page`, `routeTree.gen`, `bootstrap`, `index`
  and the marketing HTML that references them). Attributed to concurrent work, not to this task:
  `apps/web/src/components/document-panel/document-sandbox.tsx` and neighbours were modified
  during the build window by another agent. Every TTS/ORT-carrying artifact is identical to
  baseline.
- knip is red on two ambient items unrelated to this task (listed under self-gate); no fix
  attempted, per ambient-issue instructions.

## Confidence

**High.** The determination rests on reproduced, byte-level evidence in three directions
(dependency present at 1.26, absent, present at 1.27), a direct reading of the externals and
`Tensor` re-export in transformers' browser build, and a final build that reproduces the
baseline TTS worker chunks byte-for-byte. The one thing not established is whether the older
`Tensor` would actually misbehave — deliberately, since the task's bar is "does removal change
what ships", and it demonstrably does.
