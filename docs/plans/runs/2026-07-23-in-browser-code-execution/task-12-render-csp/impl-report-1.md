# impl-report-1 — renderer under served CSP + `'unsafe-inline'` script-src

## Objective

Close the blocker the WebRTC fix's re-verification raised: the renderer did not run
under the real sandbox `script-src` because inline `<script>` (html kind) and the
inline `<script type="importmap">` (js/react module paths) are blocked without
`'unsafe-inline'`. Add `'unsafe-inline'` to the single sandbox `script-src` constant,
and root-cause the test gap by making the render browser test serve the real CSP (the
python test already did — the asymmetry that hid the break).

## Files changed

- `src/csp.ts` — added `'unsafe-inline'` to `script-src` in the one `SANDBOX_CSP`
  constant; final `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:
  https://esm.sh`. No other directive touched (default-src 'none', connect-src,
  worker-src/frame-src/child-src/object-src 'none', webrtc 'block', frame-ancestors,
  etc. all byte-unchanged from the WebRTC fix). Header comment now records the durable
  why: the sandbox runs the document's own inline scripts; a static file cannot nonce
  arbitrary user code; containment is origin isolation + the network lockdown, not
  script-src.
- `public/_headers` — CSP line kept byte-identical to the constant (drift test pins
  this); script-src explanatory comment updated to the same durable why.
- `src/headers.test.ts` — added a drift assertion that `script-src` contains
  `'unsafe-inline'` (with the durable reason); the existing byte-identity test
  (`_headers` == `SANDBOX_CSP`) continues to pin served == constant == `_headers`.
- `src/render/render.browser.test.ts` — the render browser harness now serves
  `SANDBOX_CSP` on every response (imported from `../csp.js`), matching the python
  harness. Added two tests (below). The existing plain-HTML, js, react, transpile-error,
  and WebRTC-frame-neutralization tests now all run under the served CSP.

## Tests added

- `runs an HTML document's own inline <script> under the served CSP` — an html document
  whose inline `<script>` appends `#inline-out` to the DOM; proves the served script-src
  executes the document's own inline scripts. Covers A12 proof (a): html-with-inline-script.
- `keeps WebRTC neutralized inside an inline script the CSP now permits` — an inline
  script (now permitted by `'unsafe-inline'`) that does `new RTCPeerConnection()` inside
  a `try/catch` and writes `blocked`/`reachable` to the DOM; proves the deleted
  constructors stay gone regardless of how the script runs. Covers A12 item 3.
- The pre-existing `mounts a React component that imports an npm package` now serves as
  the react-with-importmap proof (A12 (c)) — it fails RED without `'unsafe-inline'`
  (bare specifiers unresolvable, inline import map blocked) and passes GREEN after.
- The pre-existing `runs a JS document…` serves as the js proof (A12 (b)) under CSP.

## Self-gate

- RED verify: `vitest run src/render/render.browser.test.ts` with the pre-`'unsafe-inline'`
  constant — 3 failed / 4 passed: the html-inline-script test (inline script not executed,
  `#inline-out` absent), the WebRTC-inline test (script rendered as literal text), and the
  react-importmap test (`type: rendered` never arrives) all fail because inline scripts and
  the inline import map are CSP-blocked. Exactly the pre-existing gap.
- GREEN: `vitest run src/render/render.browser.test.ts src/headers.test.ts` — 21 passed.
- `pnpm test` (full sandbox suite, coverage gate via run-package-tests) — pass — 131 tests,
  17 files, 100% coverage (per-file 95 gate met). Includes render-under-CSP,
  python-under-CSP (core/figures/micropip), drift/headers, and WebRTC-neutralization.
- `turbo typecheck lint --filter=@hushbox/sandbox --force` — 2 successful.
- `eslint src/csp.ts src/headers.test.ts src/render/render.browser.test.ts` (from package
  dir, after last edit) — exit 0.
- `verify:env --mode=development` and `--mode=production` — both pass.

## Acceptance criteria (A12)

- Add `'unsafe-inline'` to sandbox `script-src`, single constant, no other directive
  touched — met. Final `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:
  https://esm.sh`.
- Drift test updated (served === constant === `_headers`) to the new script-src — met
  (explicit `'unsafe-inline'` assertion + unchanged byte-identity pin).
- Root-cause test fix: render browser test serves the real CSP and proves html-with-inline
  -script + js + react-with-importmap render under it; fail RED without `'unsafe-inline'`,
  pass GREEN after — met.
- WebRTC neutralization still holds under `'unsafe-inline'` (inline `new RTCPeerConnection()`
  throws; frame globals deleted) — met (new inline test + retained frame-global test).

## Deviations with reasons

None.

## Concerns and limitations

- The render harness now serves CSP identically to the python harness, closing the
  asymmetry. `'unsafe-inline'` is ignored by the browser when a nonce/hash is present;
  there is none here (a static file cannot mint per-response nonces), so it takes effect —
  which is the intended posture for a sandbox that runs the document's own scripts.
- Untouched per bounds: `python/`, `e2e/`, `apps/web`, `packages/**`.

## Confidence

High. RED reproduced the exact blocker (inline script + import map blocked) and GREEN
cleared it in a real headless browser; the network lockdown (connect-src, frame/child/
worker/object 'none', WebRTC deletion) is byte-unchanged, and the WebRTC-under-inline
test proves `'unsafe-inline'` composes with the neutralization. Full suite 100% coverage,
all gates green.
