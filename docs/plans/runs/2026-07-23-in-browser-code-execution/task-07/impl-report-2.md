# T7 — Security containment tests — impl report 2

## Objective

Runtime-confirm what the now-final sandbox package claims: the WebRTC exfil
channel is closed (constructor deleted), the sandbox embeds from a ported
localhost origin (frame-ancestors fix), and the full malicious-document corpus
still holds under the final CSP (`default-src 'none'`, `script-src … 'unsafe-inline'`,
frame/child/worker/object `'none'`, connect-src self+2 PyPI).

## Files changed

- `e2e/security/document-sandbox-containment.spec.ts`
  - **WebRTC test un-fixmed and inverted.** Was held `test.fixme` asserting the
    (then-open) intended containment. Now a live test asserting the constructor is
    absent: the document logs `typeof RTCPeerConnection` (→ `undefined`) and
    `new RTCPeerConnection(...)` throws, so no `onicecandidate` handler is ever
    wired, no STUN request is sent, and no `srflx`/`relay` candidate can appear.
    This is the runtime confirmation the WebRTC channel is closed via the
    JS-neutralization layer.
  - **CSP regression pins updated to the final policy.** Added `toContain`
    assertions for `default-src 'none'`, `frame-src/child-src/worker-src/object-src
    'none'`, `script-src 'self' 'unsafe-inline'`, and `frame-ancestors …
    http://localhost:*` (alongside the retained `webrtc 'block'`, connect-src, and
    no-wildcard pins). The served-CSP-equals-`_headers` byte match is unchanged
    (single source of truth, no second copy).
- `e2e/helpers/sandbox-harness.ts`
  - **Port-80 workaround removed; parent served from a real ported loopback
    origin.** The parent page now comes from a throwaway `http.createServer` bound
    to loopback on an ephemeral port (`http://localhost:<port>`), replacing the
    `page.route` fulfilment. This both (a) embeds from a ported localhost origin —
    the case `frame-ancestors http://localhost:*` now admits — and (b) closes a
    Local Network Access gap (see Raised). Cleanup rides the page's own `close`
    event (fixture teardown), never an `afterEach` in a spec.

## Runtime verification (executed, not read)

The whole point of the un-fixme was to run it. Every mechanism below was executed
in real HeadlessChrome (Playwright-bundled Chromium 150 — the engine the suite
uses) against the **real** sandbox origin serving the **real** final CSP (the T10
dev-server, verified header byte-for-byte === `apps/sandbox/public/_headers`),
with the parent embedded from a ported loopback origin and **no** Local Network
Access launch flag (i.e. the founder runner's default):

- **WebRTC** — `RTC:typeof undefined`; `new RTCPeerConnection(...)` → `WEBRTC:BLOCKED
  TypeError`; no `WEBRTC:LEAK`, no `ICE srflx`, no `ICE relay`. The bundled
  `render.js` was confirmed to carry the constructor deletion (`RTCPeerConnection`,
  `webkitRTCPeerConnection`, `mozRTCPeerConnection`, `RTCDataChannel`), so the
  block is the real neutralized bootstrap, not a stub. Chromium logged
  `Unrecognized Content-Security-Policy directive 'webrtc'`, confirming the CSP
  directive is inert and the JS layer is what closes the channel. The deletion is
  engine-agnostic (a locked `undefined` global), so the same wall holds on iOS
  WKWebView; the on-device WKWebView confirmation is a separate manual/founder
  item, but the mechanism proven here is the one that runs there.
- **frame-ancestors** — the sandbox iframe loads and posts `ready` when embedded
  from a ported `http://localhost:<port>` parent. The predecessor's finding (a
  ported parent was refused under the portless `frame-ancestors http://localhost`)
  is resolved by the final `http://localhost:*`.
- **connect-src egress** — `fetch`/`XHR`/`WebSocket` all `BLOCKED`; `sendBeacon`
  proven by the in-frame `CSPV connect-src …/beacon` (the queued-return channel
  can't self-report). `'unsafe-inline'` did NOT open egress: the inline scripts
  run (RTC probe logs, `rendered` fires) yet every off-allowlist connection is
  refused by connect-src.
- **iframe attributes** — popup `BLOCKED` (window.open null), top-nav `BLOCKED`
  (SecurityError), parent-DOM `BLOCKED` (SecurityError), `alert()` suppressed
  (`MODAL:RETURNED`, no `dialog` event fired).
- **child self-navigation** — parent-side `CSPV frame-src https://evil.example.test`
  for BOTH deliveries (web HTTP header and Capacitor `<meta http-equiv>`).
- **post-teardown** — a 30 ms beaconing interval freezes after `teardownFrame()`;
  a re-created frame's `ready:2` is the positive real-time fence; the beacon count
  is stable across the window (dead frame emits nothing).

## Self-gate

- `tsgo --noEmit` (from `e2e/`) — pass (0 errors).
- `eslint helpers/sandbox-harness.ts security/document-sandbox-containment.spec.ts`
  (from `e2e/`, after the last edit) — pass (exit 0).
- Full E2E suite through the Playwright runner + fixtures — NOT run here (founder
  owns the close-phase E2E run per A6). Mechanisms proven via the real engine +
  real served CSP as above.

## Acceptance criteria

- **WebRTC probe un-fixmed, asserts the channel is closed** — MET. Executed
  against the real neutralized bootstrap: constructor absent, construction throws,
  no ICE candidate/STUN egress.
- **frame-ancestors workaround removed; embed from ported origin** — MET. Harness
  serves the parent from a real ported loopback origin; iframe embeds and readies.
- **Full corpus green under the final CSP** — MET at the mechanism level for every
  case (egress, popup/top-nav/modal/parent-probe, child self-nav web+mobile,
  post-stop, CSP regression pins). `'unsafe-inline'` confirmed to open no exfil
  path.

## Raised

### The predecessor's `page.route` parent would fail the founder's real run (fixed)

The impl-report-1 harness fulfilled the parent via `page.route`. A fulfilled
response has no network address space, so Chromium 150 classifies the document as
public and its **Local Network Access checks abort the loopback sandbox-iframe
subresource** with `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` before the policy
under test ever runs — reproduced here with the default Playwright launch (no flag).
Playwright's default args do not disable LNA, so the founder's full run would have
hit this. Fixed within bounds by serving the parent from a real loopback origin
(same address space as the iframe → embed admitted). Consequence: the founder's
run needs **no** `playwright.config` launch flag for this suite.

### Both impl-report-1 findings are now resolved by the final sandbox package

Finding 1 (WebRTC open) and Finding 2 (portless frame-ancestors) are closed by the
final package (constructor deletion + `frame-ancestors http://localhost:*`), and
this report confirms both at runtime.

### Shared-helper contract note (T8)

The harness is the shared helper T8 reuses. Its public surface
(`open/sendInit/sendRun/sendStop/teardownFrame/recreateFrame/bridgeLog`) is
unchanged; only the internal parent-serving mechanism moved from `page.route` to a
loopback server. T8 inherits the LNA fix for free (it would have hit the same
block).

## What remains for the founder's full E2E run

- Run the suite through the real fixture stack (`unauthenticatedPage`, the network
  allowlist auto-fail, `expectConsoleErrors`) + the webServers. I validated the
  containment mechanisms via a raw real-browser harness against the real served
  CSP; the fixture plumbing (allowlist abort as the independent backstop, console
  auto-fail wording) is reasoned there, not run through the runner.
- The `app origin ships a frame-src CSP naming the sandbox origin` test needs the
  app preview server (`HB_PREVIEW_PORT`) up; not exercised here.
- iOS WKWebView on-device WebRTC closure — the JS deletion is engine-agnostic and
  proven on Chromium; the on-device confirmation is a manual/founder item.

## Deviations with reasons

- **Parent served from a real loopback socket instead of `page.route`.** Forced by
  the LNA evidence above; a synthetic fulfilment cannot embed a loopback iframe
  under Chromium 150. The loopback origin is also a truer "ported app origin" than
  a fabricated response, which is exactly what the frame-ancestors fix is meant to
  admit.

## Concerns and limitations

- `expectConsoleErrors` patterns remain generous by design (they cover the CSP /
  sandbox prose the corpus provokes). A Chromium-version wording drift would fail a
  test at teardown on an un-opted console line — a first-real-run tuning item.
- Server lifecycle rides `page.once('close', …)` with `closeAllConnections()`;
  under the fixture teardown the page closes, dropping the browser keep-alive
  socket. Validated in the standalone runs (servers closed cleanly, no port leak).

## Confidence

High. The WebRTC un-fixme and the full corpus were executed against the real
neutralized bootstrap and the real served final CSP in the suite's own engine,
from a ported loopback origin with no launch flag; the static gates are green; the
LNA blocker was found and closed. Residual is the fixture-stack plumbing and the
app-preview / on-device items, all explicitly delegated to the founder's run.
