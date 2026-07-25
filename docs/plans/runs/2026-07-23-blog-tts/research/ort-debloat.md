# ORT wasm debloat — analysis

Analyst, 2026-07-24 (written up by the orchestrator; the analyst has no write tools).

## Mechanism (Verified) — narrower than assumed

The `new URL(...)` reference is **not** in `@huggingface/transformers` and not in our plugin. It is in onnxruntime-web's *default* browser bundle variant.

- `tts.worker.ts:20` → `kokoro-js` → `@huggingface/transformers` browser export `transformers.web.js`, which **externalizes** ORT (`import * as ... from "onnxruntime-web"`; 0 occurrences of `ort-wasm` in that file).
- `onnxruntime-web`'s exports map resolves the browser `import` condition to **`dist/ort.bundle.min.mjs`**, which inlines Emscripten glue containing `new URL("ort-wasm-simd-threaded.jsep.wasm", import.meta.url)`.
- Rolldown statically detects it and emits the asset in **both** app builds (both bundle `tts.worker`). Only two built files reference it: `dist/assets/tts.worker-*.js` and `dist/_astro/tts.worker-*.js`. The third copy arrives via `merge-marketing-into-web.ts`.

**The upstream-sanctioned fix exists** — a sibling export condition:
```json
"import": { "onnxruntime-web-use-extern-wasm": "./dist/ort.min.mjs",
            "default": "./dist/ort.bundle.min.mjs" }
```
`ort.min.mjs` contains **zero** `ort-wasm...wasm` references. Added by microsoft/onnxruntime PR #24014 ("allow bundler import condition for not bundling wasm"), motivated by issue #24009. Its consumer contract is: self-host the `.mjs`/`.wasm` and set `wasmPaths` — **exactly what `ort-assets-plugin.ts` + `tts.worker.ts:35` already do.**

## Safety (Verified from ORT source, via `ort.bundle.min.mjs.map` sourcesContent)

With `wasmPaths` set to the string `/ort/`:
1. `locateFile` is always set, so the glue's `new URL(bundledAsset)` branch is unreachable.
2. The `embeddedWasmModule` short-circuit is skipped — ORT **already** dynamic-imports `/ort/ort-wasm-simd-threaded.jsep.mjs` today. The inlined glue is already dead code at runtime.
3. The proxy-worker reference is guarded by `if (!wasm.wasmPaths && …)` **and** transformers hard-sets `ONNX_ENV.wasm.proxy = false`. Doubly unreachable.
4. Ordering is safe: `env.wasmPaths` is assigned at worker module top level; ORT reads it lazily at first session creation.

All three wasm copies are byte-identical (sha256 `c46655e8…`), so removing two carries no version-skew risk. `_headers` has no per-asset entries; `sw.js` precaches none of it.

## Options

| | Option | Verdict |
|---|---|---|
| **A** | `resolve.conditions: [ORT_EXTERN_WASM_CONDITION, ...defaultClientConditions]` in both apps | **RECOMMENDED** |
| B | Plugin deletes the asset in `generateBundle` | Rejected — leaves a live `/assets/ort-…wasm` reference pointing at a 404 (violates Fail Fast / Never Hide Problems) |
| C | `pnpm patch` onnxruntime-web | Rejected — drifts on every dependency bump |
| D | `transform` plugin rewriting the minified `new URL(...)` literal | Rejected — correctness pinned to third-party minified text |
| E | Accept | Rejected — 26% of the dist, plus 21.6 MB in the APK and every OTA zip, forever |

Non-starters assessed and dropped: `rollupOptions.external` (the reference is a module import, not asset-only), `resolve.alias` stub (kills ORT), `optimizeDeps.exclude` (dev-only), `assetFileNames` (renames, doesn't remove).

**Why A wins:** it **fails safe** — if the condition ever stops applying, resolution silently reverts to today's working-but-fat behavior; bytes regress, TTS does not break. It removes the *reference*, not just the file, so nothing points at a missing path. Zero runtime delta (ORT already imports from `/ort/`). It is the vendor's own seam, so it survives upgrades.

**Two implementation constraints:**
1. `resolve.conditions` **replaces** Vite's defaults — must spread `defaultClientConditions` or browser/module resolution breaks app-wide.
2. Do not mirror the condition string in two configs — export it from `scripts/lib/ort-assets-plugin.ts`, which both configs already import.

Astro passes user `resolve.conditions` through (verified: `create-vite.js` sets none).

## Quantification

| | Before | After |
|---|---|---|
| `apps/web/dist` bytes | 166,677,854 | ~123,485,816 (**−43,192,038, −25.9%**) |
| Largest file | 20.59 MiB (`dist/ort/…wasm`) | unchanged |
| Android `assets/public` | 137 MB (2 copies) | ~115 MB (**−21.6 MB** in APK/AAB) |
| Every OTA zip | 2 copies | 1 copy |

## Verification plan (RED before the fix)

New `scripts/verify-web-bundle.ts` + test (scripts vitest project), wired into `buildWebBundle()` after the merge — one call site covering prod, e2e, and the preview build. Assertions:
1. `dist/ort/…{wasm,mjs}` exist and sha256-match `resolveOrtAssets()` (reuse the existing export — no second resolution implementation).
2. No `ort-wasm*.{wasm,mjs}` anywhere in `dist` outside `dist/ort/`. **RED today** (two copies).
3. No built `.js` contains `/assets/ort-` or `/_astro/ort-`. **RED today** — this is the assertion that distinguishes A from B and catches a silent revert to the bundle variant.
4. Cloudflare Pages guards: every file ≤ 26,214,400 B (25 MiB), file count ≤ 20,000, naming the offending path.

Plus one E2E appended to `e2e/marketing-roadmap.spec.ts` (no new spec file): `page.evaluate(async () => typeof (await import('/ort/ort-wasm-simd-threaded.jsep.mjs')).default)` → `'function'` — exactly ORT's own `dynamicImportDefault(url)` call, executed under the real generated CSP. Plus a HEAD on the `.wasm` asserting 200 / `application/wasm` / correct content-length (keeps 21 MB off the wire).

## RAISED

1. **Latent deploy-breaking landmine, independent of this fix.** `onnxruntime-web@1.26.0`'s wasm is **26,239,907 B = 25.02 MiB — over Cloudflare Pages' 25 MiB per-file hard cap** (Verified; the file is already in the pnpm store). We currently ship 1.22.0-dev's 20.59 MiB copy, but `ortAssetsPlugin` resolves *whatever transformers installs*. A routine `@huggingface/transformers` bump can silently push `dist/ort/…wasm` past the cap and **hard-fail the Pages deploy**. Verifier assertion 4 converts that into a build failure instead. Land it regardless of which debloat option is chosen. Longer-term re-entry: serve the ORT runtime from R2 (Pages' own recommendation for >25 MiB), which reopens the CSP question `TTS_ORT_WASM_PATH` was created to close.
2. **`packages/ui/package.json:55` declares `onnxruntime-web: ^1.26.0` as a direct dependency that no source file imports** (zero `from 'onnxruntime-web'` outside node_modules). knip-suppressed at `knip.jsonc:78` with **no comment**, unlike every other ignore there. Transformers' types reference `onnxruntime-common`, not `onnxruntime-web`. It installs a second ~26 MB wasm into node_modules and creates version-skew potential with the 1.22.0-dev that actually ships. Needs a ruling — not asserted dead, only undocumented.
3. **The `onnxruntime-web-use-extern-wasm` condition is undocumented outside package.json and PR #24014** — needs a durable comment citing the PR so a future reader doesn't delete it as mystery config.

## Assumptions
- Rolldown honors `resolve.conditions` in the dedicated-worker sub-build identically to the main graph — Inferred; must be confirmed on the first real build.
- Worker-chunk size reduction estimated from a 43,113 B unminified source delta, not measured.

Sources: microsoft/onnxruntime PR #24014, issue #22615, Cloudflare Pages limits.
