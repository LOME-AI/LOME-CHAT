import { describe, it, expect } from 'vitest';
import { neutralizeWebRtc, NEUTRALIZED_WEBRTC_GLOBALS } from './neutralize-webrtc.js';

/**
 * WebRTC is an open network-egress channel the sandbox CSP cannot close
 * (`webrtc 'block'` is a draft directive Chromium does not enforce), so the
 * bootstrap deletes the WebRTC constructors from the frame global before any
 * untrusted code runs. These tests pin that removal.
 */

/** Stands in for a native WebRTC constructor a real browser exposes on the global. */
function nativeConstructor(): void {
  // No behavior needed: the tests only assert this gets removed.
}

/** A stand-in frame global carrying the WebRTC constructors a real browser exposes. */
function freshTarget(): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const name of NEUTRALIZED_WEBRTC_GLOBALS) target[name] = nativeConstructor;
  return target;
}

describe('neutralizeWebRtc', () => {
  it('removes every WebRTC constructor from the target global', () => {
    const target = freshTarget();
    neutralizeWebRtc(target);
    for (const name of NEUTRALIZED_WEBRTC_GLOBALS) expect(target[name]).toBeUndefined();
  });

  it('makes constructing a peer connection throw', () => {
    const target = freshTarget();
    neutralizeWebRtc(target);
    const Ctor = target['RTCPeerConnection'] as new () => unknown;
    expect(() => new Ctor()).toThrow();
  });

  it('covers the vendor-prefixed peer-connection aliases', () => {
    expect(NEUTRALIZED_WEBRTC_GLOBALS).toContain('RTCPeerConnection');
    expect(NEUTRALIZED_WEBRTC_GLOBALS).toContain('webkitRTCPeerConnection');
    expect(NEUTRALIZED_WEBRTC_GLOBALS).toContain('mozRTCPeerConnection');
    expect(NEUTRALIZED_WEBRTC_GLOBALS).toContain('RTCDataChannel');
  });

  it('is a no-op that does not throw when a target lacks the globals', () => {
    const target: Record<string, unknown> = {};
    expect(() => {
      neutralizeWebRtc(target);
    }).not.toThrow();
    for (const name of NEUTRALIZED_WEBRTC_GLOBALS) expect(target[name]).toBeUndefined();
  });

  it('is idempotent — running twice keeps the globals neutralized', () => {
    const target = freshTarget();
    neutralizeWebRtc(target);
    expect(() => {
      neutralizeWebRtc(target);
    }).not.toThrow();
    for (const name of NEUTRALIZED_WEBRTC_GLOBALS) expect(target[name]).toBeUndefined();
  });
});
