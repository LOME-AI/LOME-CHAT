# impl-report-1 — WebRTC exfil fix (two-layer)

## Objective

Close the WebRTC network-egress channel from untrusted sandbox document code
(runtime-proved open: a document opened an `RTCPeerConnection` and reached a real
STUN server over UDP; `webrtc 'block'` is an unenforced draft directive). Two
layers: (1) delete the WebRTC constructors from the frame global in both sandbox
bootstraps before any untrusted code runs; (2) tighten the sandbox CSP to
`default-src 'none'` with `frame-src`/`child-src`/`worker-src`/`object-src 'none'`
so the deleted globals cannot be recovered via a fresh realm, and fix
`frame-ancestors` to `http://localhost:*`.

## Files changed

- `src/neutralize-webrtc.ts` (new) — shared helper `neutralizeWebRtc()` deleting
  `RTCPeerConnection`/`webkitRTCPeerConnection`/`mozRTCPeerConnection`/`RTCDataChannel`
  from the frame global (locked, `undefined`). Shared by both bootstraps so the
  removed set cannot drift.
- `src/neutralize-webrtc.test.ts` (new) — unit tests for the helper.
- `src/render/bootstrap.ts` — call `neutralizeWebRtc()` before `startRenderer()`
  (before the first untrusted module import).
- `src/python/bootstrap.ts` — call `neutralizeWebRtc()` before
  `startPythonRuntime()` (before author Python evaluates).
- `src/csp.ts` — `SANDBOX_CSP`: `default-src 'self'→'none'`,
  `worker-src 'self'→'none'`, add `frame-src/child-src/object-src 'none'`,
  `frame-ancestors … http://localhost → http://localhost:*`; kept `webrtc 'block'`
  and every other directive (`script-src`, `connect-src`, `img-src`, `style-src`,
  `font-src`, `base-uri`, `form-action`) byte-for-byte. Header comment updated.
- `public/_headers` — CSP line kept byte-identical to the constant; explanatory
  comments updated to the new posture.
- `public/render.js`, `public/python.js` — rebuilt committed bundles (the
  neutralization call is baked in; verified `RTCPeerConnection`/`RTCDataChannel`
  present in both).
- `src/headers.test.ts` — drift test updated: `default-src 'none'`,
  `worker-src 'none'`, new frame-/child-/object-`'none'` test, `webrtc` kept as a
  hint, `frame-ancestors` contains `http://localhost:*`. Byte-identity drift test
  unchanged (still pins `_headers` == `SANDBOX_CSP`).
- `src/python/browser-harness.ts` — added a `probe<T>(pageFunction)` method to
  `PythonPage` (test-infra, coverage-excluded) for security assertions on the
  loaded page.
- `src/python/python-core.browser.test.ts` — assertion that the WebRTC
  constructors are neutralized on the runtime frame (runs under the served CSP).
- `src/render/render.browser.test.ts` — same WebRTC assertion on the render
  frame. (See deviation re: CSP-serving.)

## Tests added

- `neutralizeWebRtc removes every WebRTC constructor` — deletion of all four
  globals — covers layer-1 mechanism.
- `neutralizeWebRtc makes constructing a peer connection throw` — construction
  fails after neutralization.
- `covers the vendor-prefixed peer-connection aliases` — the removed set.
- `is a no-op that does not throw when a target lacks the globals` — defensive.
- `is idempotent — running twice keeps the globals neutralized`.
- render browser: `neutralizes the WebRTC constructors on the frame before
  document code runs` — proves the render bootstrap wires layer 1 in a real frame.
- python browser: `neutralizes the WebRTC constructors on the runtime frame` —
  proves the python bootstrap wires layer 1 in a real frame under the served CSP.
- headers drift: `denies a fresh realm — frame-src, child-src, and object-src are
  all 'none'` — pins layer 2's realm-recovery block.

## Self-gate

- `pnpm test` (full sandbox suite, coverage gate) — pass — 128 tests, 100%
  coverage (per-file 95 gate met; new `neutralize-webrtc.ts` fully covered).
- `turbo typecheck lint --filter=@hushbox/sandbox --force` — pass.
- `pnpm exec eslint .` (from package dir, after last edit) — exit 0.
- `pnpm exec tsgo --noEmit` — exit 0.
- `pnpm verify:env --mode=development` and `--mode=production` — pass.
- Python browser tests (core + figures + micropip) re-run under the served
  `default-src 'none'` CSP — all pass (Pyodide, matplotlib figures, micropip
  install all work under `'none'`).

## Acceptance criteria (A11)

- Bootstrap JS neutralization in BOTH render and python bootstraps, before
  untrusted code — met (unit + two real-frame browser assertions).
- CSP `default-src 'self'→'none'` with explicit `frame-src`/`child-src`/
  `worker-src`/`object-src 'none'` — met.
- Keep `webrtc 'block'` and every existing working directive exactly — met.
- `frame-ancestors http://localhost → http://localhost:*` — met.
- Drift test updated to the new policy; served == constant == `_headers` — met.
- Re-verify Pyodide under `'none'` — met (proven; all python browser suites green
  under the served CSP).
- Re-verify renderer under `'none'` — NOT met as stated; see below. The
  `default-src 'none'` change itself does not break the renderer, but serving the
  real CSP exposes a pre-existing `script-src` gap.

## Deviations with reasons

- The brief asked me to serve the CSP in the render browser test and confirm it
  passes. Doing so FAILS the React/npm-import case: the renderer's inline
  `<script type="importmap">` is blocked by `script-src` (no `'unsafe-inline'`,
  nonce, or hash). I verified this is PRE-EXISTING — identical under the old
  `default-src 'self'` CSP (same `script-src`) — and orthogonal to the WebRTC/
  `default-src` change; it was never caught because the render browser test never
  served any CSP. The brief forbids touching `script-src` and forbids loosening
  silently. So I reverted the render-test CSP-serving (restoring its prior
  no-CSP behavior) to keep the suite green for what this task owns, kept the
  WebRTC assertion (JS layer, CSP-independent), and raised the finding. Layer 2's
  realm-recovery block is still pinned by the drift/headers test.

## Concerns and limitations

- BLOCKER (out of scope, pre-existing, raised): the renderer does NOT run under
  the served sandbox CSP. Serving `SANDBOX_CSP` breaks React/npm-import documents
  (inline import map blocked) and inline-`<script>` HTML documents. Evidence
  (real headless Chromium): console `Executing inline script violates … script-src
  'self' 'wasm-unsafe-eval' blob: https://esm.sh. Either the 'unsafe-inline'
  keyword, a hash …, or a nonce … is required`, then
  `Failed to resolve module specifier "react/jsx-runtime"`; reproduced identically
  under the old `default-src 'self'` policy; an inline HTML `<script>` renders as
  literal text (not executed). A static `_headers` file cannot carry a per-response
  nonce, so the resolution is a founder/`script-src` decision (e.g.
  `'unsafe-inline'`, or dropping import maps by rewriting bare specifiers to full
  URLs in the transpiled module before creating the blob). Belongs to the CSP /
  renderer workstream, not this WebRTC task.
- `webrtc 'block'` is confirmed "Unrecognized" by Chromium (console warning) — it
  is kept only as a hint for engines that may honor it; the JS deletion is the
  real block.

## Confidence

High on the WebRTC fix (both layers): unit-proven, real-frame-proven on both
pages, and the CSP is byte-pinned across served/constant/`_headers`. High on the
render-CSP finding (verified in a real browser, reproduced under the old policy).
The one open item is the raised, out-of-scope pre-existing renderer-under-CSP gap.
