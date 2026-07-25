# T1 fix (report 2) — correct the kokoro-js env API usage in the TTS worker

## Objective

Fix two validated findings against `tts.worker.ts` and its test: the worker
set `env.backends.onnx.wasm.wasmPaths` (and `env.remoteHost`) on kokoro-js's
exported `env`, which THROWS at module import (the real `env` is a wrapper
exposing only a `wasmPaths` setter), breaking worker init including existing
chat read-aloud; and the test mocked a fabricated `env` shape, making the
WASM/host assertions false-green. Bounds: edit only `tts.worker.ts` and its
test — no other T1 files.

## Root-cause confirmation (Verified this session)

`node -e` against the installed `kokoro-js@1.2.1`:
- `Object.keys(env)` → `['wasmPaths']`; `'backends' in env` → `false`.
- `env.wasmPaths` is a real getter/setter (`get`+`set` in the descriptor); `env.wasmPaths = '/ort/'` works.
- `env.backends.onnx.wasm.wasmPaths = 'x'` → throws `Cannot read properties of undefined (reading 'onnx')`.
- `env.remoteHost = '…'` does NOT throw — it just adds a dead own-property kokoro-js never reads (so the old assignment was inert, not load-bearing).

kokoro-js's own type decl (`types/kokoro.d.ts`) declares `env` as
`namespace env { let wasmPaths: WasmPrefixOrFilePaths }` — so
`env.wasmPaths = TTS_ORT_WASM_PATH` typechecks with no cast.

## Files changed

- `packages/ui/src/components/accessibility/lib/tts.worker.ts` — replaced the `interface TransformersEnv` + `configureModelEnv(env as unknown as TransformersEnv)` double-cast (which threw at import) with a single `env.wasmPaths = TTS_ORT_WASM_PATH` against kokoro-js's real wrapper setter. Removed the `env.backends.onnx…` assignment, the dead `env.remoteHost` assignment, the `TransformersEnv` interface, and the now-unused `TTS_MODEL_HOST` import. Per AMENDED criterion 3 the model host is left to transformers' `https://huggingface.co` default, which `TTS_MODEL_CONNECT_SRC` covers.
- `packages/ui/src/components/accessibility/lib/tts.worker.test.ts` — reworked the kokoro-js mock's `env` to mirror the real wrapper (`{ wasmPaths: '' }`, nothing else); replaced the two false-green assertions (`env.remoteHost`, `env.backends.onnx.wasm.wasmPaths`) with one asserting `env.wasmPaths === TTS_ORT_WASM_PATH` after the worker's import; added a `real kokoro-js env API` test that pins the mock's fidelity against the REAL module via `vi.importActual`.

## The new test's regression guarantee (evidence item)

The mock `env` is now `{ wasmPaths: '' }` — the real single-`wasmPaths` shape.
Because the worker mutates `env` at module top-level and the test imports
`./tts.worker` at file top, any worker regression to `env.backends.onnx.wasm…`
dereferences `undefined.onnx` and **throws during the test file's import**,
erroring the whole suite — the exact production failure.

The `real kokoro-js env API` test additionally asserts, against the unmocked
module: `Object.keys(env) === Object.keys(mockEnv)` (ties the mock to reality —
if kokoro-js ever grows a real `backends` tree, this fails and forces the mock
to be re-checked), `'backends' in env === false`, and that reaching
`env.backends.onnx` throws. So the mock can no longer silently diverge from the
real API the way the fabricated shape did.

## TDD red→green (Verified)

1. Reworked the test first (real-shaped mock + real-API assertions).
2. Ran against the STILL-BROKEN worker → **RED**: suite failed to import with
   `TypeError: Cannot read properties of undefined (reading 'onnx')` at
   `configureModelEnv … tts.worker.ts:45:19` (`target.backends.onnx.wasm.wasmPaths`)
   — i.e. the test now reproduces the exact production throw. `0 test` collected.
3. Applied the worker fix (`env.wasmPaths = TTS_ORT_WASM_PATH`) → **GREEN**: 28 tests pass.

Worker imports without throwing against the real kokoro-js env: proven by the
node probe (`env.wasmPaths = '/ort/'` succeeds on the real module — the worker's
sole env mutation) and by the green `real kokoro-js env API` test which loads
the real module in the ui test environment.

## Self-gate

- `vitest run tts.worker.test.ts` — **pass**, 28 tests (was 30; net −2: dropped the `remoteHost` assertion, folded the two env assertions into one, added the real-API grounding test).
- Coverage of `tts.worker.ts` (`--coverage.include` scoped) — **100%** stmts/branch/funcs/lines (60/60, 25/25, 12/12, 60/60). Per-file 95% gate satisfied.
- `turbo typecheck lint --filter=@hushbox/ui` — **both pass** (2 successful, cache miss/executed). No chunk-highlighter/audio noise this run — the whole ui package lints and typechecks clean, so nothing to attribute to T3/T5.
- `eslint tts.worker.ts tts.worker.test.ts` from the package dir after the LAST edit — **exit 0** (fixed one `sonarjs/void-use` and one `prettier/prettier` surfaced along the way).

## Acceptance criteria (this fix's scope)

- Worker no longer throws at import; sets WASM path via the real wrapper setter — **met** (red→green; node probe; 100% coverage).
- `env.backends…` + `env.remoteHost` assignments and the `TransformersEnv` double-cast removed — **met** (diff).
- Test grounded in the real kokoro-js env API; would fail if the worker reverts to `.backends.onnx…` — **met** (RED reproduced the exact throw; `real kokoro-js env API` test ties mock to real shape).
- AMENDED criterion 3 (do NOT pin `remoteHost`; no `@huggingface/transformers` direct dep) — **met** (no remoteHost set; only `@hushbox/shared` imported).

## Deviations with reasons

None. Untouched by design (out of bounds / passed prior audit): `generate-headers.ts`, `tts-hosts.ts`, `ort-assets-plugin.ts`, the e2e block.

## Concerns and limitations

- The `real kokoro-js env API` test loads the real `kokoro-js` (→ transformers) in the ui test environment; verified it imports cleanly and fast (~0.5s tests) in `BROWSER_TEST_ENVIRONMENT`. If a future environment change makes that import heavy/unavailable, this one test would need a lighter grounding, but it is the durable process fix the finding asks for.

## Confidence

High — the exact production throw was reproduced by the reworked test (watched RED), the fix is a one-line wrapper-setter call matching the real API and kokoro-js's own type decl, coverage is 100% on the file, and package typecheck+lint+the worker suite are all green.
