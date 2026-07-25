# T1 — CSP + model-source: make the on-device TTS model download work under the enforced CSP

## Objective

Make the Kokoro TTS model download load under the enforced production SPA CSP:
allowlist the Hugging Face model hosts (from one shared constant), self-host
onnxruntime-web's WASM same-origin (no jsdelivr in the policy), derive the
engine's model host from the same constant, and guard it with a unit derivation
test plus one browser CSP E2E test.

## Files changed

- `packages/shared/src/tts-hosts.ts` (new) — the single source of truth: `TTS_MODEL_HOST`, `TTS_MODEL_CONNECT_SRC`, `TTS_ORT_WASM_PATH`.
- `packages/shared/src/tts-hosts.test.ts` (new) — pins the constant values/shape.
- `packages/shared/src/index.ts` — one line: `export * from './tts-hosts.js'` (barrel, so `@hushbox/shared` resolves it for the worker).
- `scripts/generate-headers.ts` — imports `TTS_MODEL_CONNECT_SRC` and spreads it into the `buildSpaHeaders` `connectSource` array (the only CSP change).
- `scripts/generate-headers.test.ts` — derivation tests + a `directiveTokens` helper.
- `scripts/lib/ort-assets-plugin.ts` (new) — shared Vite plugin: resolves the ORT `.wasm`/`.mjs` from the installed transformers (via kokoro-js), serves them same-origin in dev (`configureServer`) and emits them into the built dist (`generateBundle` → `ort/…`).
- `scripts/lib/ort-assets-plugin.test.ts` (new) — full coverage of the plugin's pure + hook logic.
- `packages/ui/src/components/accessibility/lib/tts.worker.ts` — pins `env.remoteHost` (from `TTS_MODEL_HOST`) and `env.backends.onnx.wasm.wasmPaths` (from `TTS_ORT_WASM_PATH`) at module import.
- `packages/ui/src/components/accessibility/lib/tts.worker.test.ts` — adds `env` to the kokoro-js mock + two assertions on the pinned config.
- `apps/web/vite.config.ts` — wires `ortAssetsPlugin()` into the plugins array.
- `apps/marketing/astro.config.mjs` — wires `ortAssetsPlugin()` into `vite.plugins` (same plugin, both surfaces).
- `e2e/marketing-roadmap.spec.ts` — one new `test()` block asserting real browser CSP enforcement.

## The shared constant (evidence item)

`packages/shared/src/tts-hosts.ts`:

- `TTS_MODEL_HOST = 'https://huggingface.co'` (CSP host form, no trailing slash).
- `TTS_MODEL_CONNECT_SRC = ['https://huggingface.co', 'https://*.hf.co'] as const`.
- `TTS_ORT_WASM_PATH = '/ort/'`.

Import sites:
- `scripts/generate-headers.ts`: `import { TTS_MODEL_CONNECT_SRC } from '../packages/shared/src/tts-hosts.js'` (matches the file's existing deep-relative `routes.js` import) → spread into `connectSource`.
- `packages/ui/.../tts.worker.ts`: `import { TTS_MODEL_HOST, TTS_ORT_WASM_PATH } from '@hushbox/shared'` (matches ui's existing `@hushbox/shared` barrel usage) → sets `env.remoteHost = \`${TTS_MODEL_HOST}/\`` and `env.backends.onnx.wasm.wasmPaths = TTS_ORT_WASM_PATH`.
- `scripts/lib/ort-assets-plugin.ts`: `import { TTS_ORT_WASM_PATH }` — derives the served dir + emit dir so the emit location and the worker's `wasmPaths` cannot drift.

## Resolved connect-src (evidence item)

Real generated `_headers` `/*` block, `VITE_API_URL=https://api.hushbox.ai`
(built dist → `merge-marketing-into-web` → `generate-headers.ts`):

```
connect-src 'self' https://api.hushbox.ai https://*.r2.cloudflarestorage.com https://*.r2.dev https://secure.myhelcim.com https://huggingface.co https://*.hf.co wss://api.hushbox.ai
```

`grep -c jsdelivr apps/web/dist/_headers` → `0`. No other directive changed.

## Self-hosted WASM (evidence item)

- Worker sets `env.backends.onnx.wasm.wasmPaths = '/ort/'`; transformers only sets its jsdelivr default when `wasmPaths` is unset, so this pre-empts the CDN.
- Served path: `/ort/ort-wasm-simd-threaded.jsep.wasm` + `/ort/ort-wasm-simd-threaded.jsep.mjs`.
- Files resolved from the installed package (always matches the runtime version): `require.resolve('kokoro-js')` → `require.resolve('@huggingface/transformers')` → dirname → glob `ort-*.{wasm,mjs}`.
- Proof each built dist contains them (real builds run this session):
  - `apps/web/dist/ort/`: `ort-wasm-simd-threaded.jsep.mjs` (44484 B), `ort-wasm-simd-threaded.jsep.wasm` (21596019 B).
  - `apps/marketing/dist/ort/`: same two files, same sizes.
  - Survives `merge-marketing-into-web` into `apps/web/dist/ort/`.
- Chose build-time emit (via `generateBundle`, mirroring the existing `sharedFaviconPlugin`) over committing the 21.6 MB binary — no repo bloat, always version-matched. Verified empirically that Astro honors the `generateBundle` emit into `dist/` (this was the marketing-build risk called out in NEEDS_CONTEXT; it is NOT disproportionately complex — the same plugin works verbatim in both Vite and Astro).

## Tests added

- `tts-hosts.test.ts` — 5 tests pinning the constant values/shape (catches an accidental value/host change).
- `generate-headers.test.ts` — "adds every shared TTS model host to the SPA connect-src (superset of the constant)" and "adds only the HF model hosts … no jsdelivr, no wildcard broader than *.hf.co". Catches: a host dropped from the generated `connect-src`, a jsdelivr leak, or an over-broad HF wildcard. Criteria 1, 4, 6, 7.
- `tts.worker.test.ts` — "pins env.remoteHost to the shared Hugging Face host" and "self-hosts the onnxruntime WASM at the shared same-origin path". Criterion 2, 3.
- `ort-assets-plugin.test.ts` — resolution (real + empty-dir throw), content types, plugin emit (asserts `ort/<file>` fileNames), dev middleware match/non-match/no-url. Criterion 2.
- `marketing-roadmap.spec.ts` — one new browser CSP `test()`: installs a `securitypolicyviolation` listener via `addInitScript` before `page.goto('/welcome')`, opts out of the console auto-fail via `expectConsoleErrors([/Refused to connect|Content Security Policy/i])`, fetches a disallowed host (`https://blocked.invalid`) and asserts a violation with `blockedURI` containing `blocked.invalid`, and fetches `https://huggingface.co` asserting NO violation for that origin (asserts on `blockedURI`, never fetch success; the HF probe is `route.fulfill`ed locally so it never egresses and never depends on HF reachability). Criterion 5.

## Self-gate

- `pnpm --filter @hushbox/scripts exec vitest run generate-headers.test.ts lib/ort-assets-plugin.test.ts` (my files) — pass, 79 tests; coverage of `generate-headers.ts` + `ort-assets-plugin.ts` = 100% stmts/branch/funcs/lines.
- `pnpm --filter @hushbox/scripts test` (full) — FAIL: 1771 tests pass, 86 files pass; 2 files fail (`seed-run.test.ts`, `seed.ts`) with `ERR_MODULE_NOT_FOUND` on `…/.vite/vitest/…/deps_ssr/@hushbox_db.js`. Not mine: `seed.ts` is ambient-modified (git `M`, I did not edit it), I touched no seed/db code, and the failure reproduces on a fresh isolated `vitest run seed-run.test.ts`. A Vite optimized-deps cache issue in a concurrent-heavy tree.
- TTS-adjacent ui tests (`tts-engine`, `tts.worker`, `tts-worker-protocol`, `tts-stream-feeder`, `tts-download-progress`) — pass, 139 tests.
- Typecheck (`pnpm --filter <pkg> typecheck`): `@hushbox/scripts` EXIT 0, `@hushbox/shared` EXIT 0, `@hushbox/web` EXIT 0, `@hushbox/ui` EXIT 0, `@hushbox/marketing` 0 errors.
- Lint (from each package dir, after final edits): my owned files in scripts/shared/ui/e2e all `eslint` EXIT 0; `apps/web/vite.config.ts` is eslint-ignored (config file); `apps/marketing/astro.config.mjs` EXIT 0.
- `@hushbox/ui` package lint FAILS — but only on `chunk-highlighter.ts` / `chunk-highlighter.test.ts` (concurrent T3 work-in-progress, not my files; my worker files lint clean). Same for the full `pnpm test:ui`, which is blocked by the concurrent T3 chunk-highlighter tests; I did not run it to green and instead targeted the TTS-adjacent files (all pass).
- `jscpd --threshold 2` on owned files — 0 clones (0%).

## Acceptance criteria

1. `connect-src` gains `https://huggingface.co` + `https://*.hf.co` and only those (no jsdelivr, no broader wildcard), from the shared constant — **met** (resolved-connect-src evidence above; derivation tests; `jsdelivr` count 0).
2. `tts.worker.ts` sets `wasmPaths` same-origin and the ORT `.wasm`/`.mjs` are emitted into both web and marketing dist so it resolves with no jsdelivr fetch — **met** (worker test; both `dist/ort/` listings; served path `/ort/…`).
3. `tts.worker.ts` derives `env.remoteHost` from the shared constant — **met** (worker test asserts `env.remoteHost === 'https://huggingface.co/'`).
4. Unit derivation test asserts generated `connect-src` ⊇ the shared constant — **met** (`generate-headers.test.ts`).
5. Exactly one new `test()` appended to `marketing-roadmap.spec.ts` per the spec — **met** (see Tests added). Actual E2E run deferred (see deviations).
6. Existing `generate-headers.test.ts` still passes — **met** (68 → now 70 tests, all green).
7. No over-broadening of any other directive — **met** (only `connect-src` changed; other directives byte-identical; derivation test bounds the HF tokens to exactly the constant).

## Deviations with reasons

- **E2E block authored but not run.** The actual `pnpm e2e` run needs the full local stack (db/redis/minio/api + web+marketing build + preview) — heavy and mid-flight alongside concurrent T2/T3 agents. The brief permits deferral to close-phase. The spec typechecks and lints clean, and I confirmed the two facts it depends on: the generated CSP now contains the HF hosts, and `vite preview` enforces the real `_headers` CSP via `headers-vite-plugin`. Deferred for close-phase verification.
- **`ort-assets-plugin.ts` implementation written before its test** (the rest of the task was strict test-first). The plugin is glue around a resolvable fact; I backfilled a full test (100% coverage, both hook branches). Noted for honesty.

## Concerns and limitations

- The ORT `.wasm` is 21.6 MB emitted per build into each dist — expected for a self-hosted WASM runtime; it is a build artifact, not committed.
- `env` is imported from kokoro-js whose `.d.ts` under-declares it (only `wasmPaths`); the runtime object is transformers' full `env` (verified in `kokoro.web.js`: `remoteHost:"https://huggingface.co/"` + the jsdelivr default template). The worker casts through a local `TransformersEnv` interface (`as unknown as`, the same double-cast pattern the file already uses for `from_pretrained`) — no `any`.
- Research premise correction (already in plan design context, restated): the deployed origin/main chat TTS is CSP-blocked by the same missing hosts — this fix closes a live latent production gap, not only the new blog feature.

## Confidence

High — every deterministic criterion is proven (real builds, real generated `_headers`, 100% coverage on my source, all my tests green, all five typechecks green). The one non-proven-this-session item is the E2E run, deferred by design; its dependencies are individually verified.
