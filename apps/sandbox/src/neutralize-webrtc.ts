/**
 * The document sandbox forbids all network egress from untrusted code, but WebRTC
 * is an egress channel the Content-Security-Policy cannot govern: `connect-src`
 * does not cover RTCPeerConnection, and `webrtc 'block'` is a draft CSP directive
 * Chromium does not enforce (a document was observed reaching a public STUN server
 * over UDP despite it). The only reliable block is removing the WebRTC
 * constructors from the frame global before any untrusted code runs — this JS
 * layer, not CSP, is the actual WebRTC wall. It holds on engines that ignore the
 * CSP directive entirely (e.g. iOS WKWebView). Recovering the deleted globals
 * would require a fresh realm (a child frame, worker, or object), which the
 * sandbox CSP's `default-src 'none'` plus `frame-src`/`worker-src`/`object-src`
 * `'none'` prevent.
 *
 * Shared by both sandbox bootstraps (render + python) so the removed set cannot
 * drift between the two pages.
 */

/** The WebRTC frame globals removed before any untrusted document code runs. */
export const NEUTRALIZED_WEBRTC_GLOBALS = [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'mozRTCPeerConnection',
  'RTCDataChannel',
] as const;

/**
 * Delete the WebRTC constructors from `target` (the frame global by default),
 * leaving them `undefined` and locked so untrusted code sees WebRTC as absent and
 * any construction attempt throws.
 */
export function neutralizeWebRtc(
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): void {
  for (const name of NEUTRALIZED_WEBRTC_GLOBALS) {
    Object.defineProperty(target, name, {
      configurable: false,
      writable: false,
      value: undefined,
    });
  }
}
