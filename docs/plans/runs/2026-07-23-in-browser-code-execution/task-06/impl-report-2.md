# T6 — Headers & CSP — impl report 2 (fix pass)

## Objective

Close two egress holes the sandbox CSP left open, both purely additive to
`apps/sandbox/public/_headers`:

1. WebRTC egress — `connect-src` does not govern `RTCPeerConnection`, so hostile
   document code could open a channel to an attacker STUN/TURN server. Add the
   `webrtc 'block'` CSP directive.
2. DNS-prefetch hostname exfil — CSP cannot cover `<link rel="dns-prefetch">`. Add the
   `X-DNS-Prefetch-Control: off` response header.

## Files changed

- `apps/sandbox/public/_headers` — added `webrtc 'block'` to the CSP (immediately after
  `connect-src`, grouping the network-egress directives) and `X-DNS-Prefetch-Control: off`
  to the `/*` header block. Added a CSP comment bullet stating WHY `webrtc 'block'` is
  needed (connect-src does not govern WebRTC) and a third numbered concern block stating
  WHY `X-DNS-Prefetch-Control: off` is needed (CSP cannot cover dns-prefetch hostname
  leaks). No other directive or header altered — `connect-src`, `script-src`,
  `frame-ancestors`, `default-src`, `worker-src`, CORS/CORP baseline are byte-for-byte
  unchanged.
- `apps/sandbox/src/headers.test.ts` — two new tests pinning the additions.

## Tests added

- `blocks WebRTC egress (connect-src does not govern RTCPeerConnection)` — asserts the
  `webrtc` directive is present and equals exactly `'block'`.
- `disables DNS prefetch so hostnames cannot leak via <link rel="dns-prefetch">` — asserts
  the raw header set contains `X-DNS-Prefetch-Control: off`.

## Self-gate

- `pnpm --filter @hushbox/sandbox test` — pass — 88/88 (10 files); coverage 100%
  stmts/branches/funcs/lines.
- RED verified before the `_headers` edits: with both tests added and neither directive
  present, `vitest run src/headers.test.ts` reported `2 failed | 8 passed` — the webrtc
  test failed on the missing `webrtc` directive, the DNS test on the absent header. GREEN
  after the additive edits.
- `eslint src/headers.test.ts` (run from `apps/sandbox`) — exit 0 after the final edit.
  `_headers` is a plain-text response-header file, not a lint target.

## Acceptance criteria

- `webrtc 'block'` present in the sandbox CSP — MET (directive added; test pins it equals
  `'block'`).
- `X-DNS-Prefetch-Control: off` present in the sandbox header set — MET (header added to
  `/*`; test pins the raw string).
- No other directive altered — MET (connect-src / script-src / frame-ancestors values
  unchanged; both changes are strictly additive).

## `webrtc 'block'` engine-support note (for T7 to probe on-device)

`webrtc` is a standard CSP directive (defined by the WebRTC ↔ CSP spec integration, values
`'allow'` / `'block'`) — not an invented directive. Engine support is uneven and I could
not confirm it on-device from here:

- **Chromium** (Android WebView): the `webrtc` CSP directive is honored by Blink; WebRTC
  peer-connection creation is blocked under `webrtc 'block'`. Expected to hold on the
  Android WebView engine.
- **WebKit / iOS WKWebView**: WebKit's support for the `webrtc` CSP directive is
  **unverified / likely not implemented**. If WebKit ignores the directive, the CSP line is
  a no-op there and WebRTC egress on iOS would rest on whatever else constrains it (no
  media/network permission granted to the sandboxed frame, `allow` attributes on the iframe,
  etc.) rather than on CSP.

The directive is added regardless as defense-in-depth. T7's in-browser malicious-document
corpus (A8 item (a): an `RTCPeerConnection` exfil probe under real CSP) is the actual
confirmation of closure — it must run the probe under **both** engines, treating the iOS
WKWebView result as the load-bearing one, since that is where CSP-level blocking is in
doubt.

## Deviations with reasons

None. Both changes are exactly as the brief specified; no other directive touched.

## Concerns and limitations

- The iOS WebKit `webrtc 'block'` support gap above is the only open question, and it is
  T7's to resolve on-device. No workaround is added here (inventing a non-standard directive
  is out of scope, and no other header closes the WebRTC channel by itself).

## Confidence

High. Both fixes are one directive / one header each, RED-verified before and GREEN after,
with tests pinning them; the only residual uncertainty is the documented iOS engine-support
question, correctly deferred to T7's on-device corpus.
