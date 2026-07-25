/**
 * The single authoritative security posture the sandbox origin serves. This
 * Content-Security-Policy IS the containment model for untrusted document code:
 * document code may load ES modules (script-src self + the module CDN + `blob:`
 * for the in-browser-transpiled module), run its own inline scripts
 * (`'unsafe-inline'`), and Python wheels (connect-src self + the two PyPI hosts
 * micropip needs), instantiate WebAssembly (`'wasm-unsafe-eval'`), and reach
 * nothing else on the network. `'unsafe-inline'` is required, not a weakening:
 * the sandbox exists to execute the document's own scripts — an html document IS
 * inline `<script>`, classic or module — and a static file cannot mint a
 * per-response nonce for arbitrary user code. Inline execution grants no new capability: containment is
 * the opaque origin plus the network lockdown (connect-src, frame/child/worker/
 * object `'none'`, and the deleted WebRTC constructors), never script-src.
 * Everything not
 * explicitly enumerated is denied: `default-src 'none'` is the floor, so any
 * fetch directive left unset blocks. `frame-src`/`child-src`/`worker-src`/
 * `object-src` are pinned to `'none'` so untrusted code cannot spawn a child
 * frame, worker, or object to obtain a fresh realm — which would restore the
 * WebRTC constructors the bootstrap deletes (`neutralize-webrtc.ts`), since
 * `webrtc 'block'` here is a draft directive Chromium does not enforce. It is
 * kept anyway for engines that may honor it later. `frame-ancestors` limits
 * embedders to the web app and the mobile app-shell origins; the Android/dev
 * shell is portless-`http://localhost` on an arbitrary port, so it is matched
 * with `:*`.
 *
 * This constant is the one source of that string. Three consumers reference it:
 * the local dev server injects it on every response, the browser integration
 * harnesses apply it to the pages they drive, and the committed
 * `public/_headers` (a static file Cloudflare serves in production, which cannot
 * import TypeScript) is pinned equal to it by a drift test. A future edit that
 * changes the policy in one place without the others fails that test.
 */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://esm.sh; " +
  "worker-src 'none'; connect-src 'self' https://pypi.org https://files.pythonhosted.org; " +
  "frame-src 'none'; child-src 'none'; object-src 'none'; webrtc 'block'; " +
  "img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self' data:; frame-ancestors https://hushbox.ai capacitor://localhost http://localhost:*; " +
  "base-uri 'self'; form-action 'self'";

/**
 * The security response headers the sandbox origin serves alongside the CSP.
 * `X-DNS-Prefetch-Control: off` closes the hostname-leak channel CSP cannot
 * cover (`<link rel="dns-prefetch">` encoding data into a lookup). The dev
 * server and the static `_headers` both carry these.
 */
export const SANDBOX_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': SANDBOX_CSP,
  'X-DNS-Prefetch-Control': 'off',
};
