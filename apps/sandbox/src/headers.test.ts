import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { SANDBOX_CSP, SANDBOX_SECURITY_HEADERS } from './csp.js';

/**
 * The sandbox origin's `public/_headers` carries the Content-Security-Policy
 * that IS the containment model for untrusted document code: document code can
 * load ES modules and Python wheels, and reach nothing else on the network.
 * These tests pin that posture against the committed static file, so a future
 * edit that widens the allowlist fails loudly.
 */

const HEADERS_FILE = path.join(import.meta.dirname, '..', 'public', '_headers');

/** The single `Content-Security-Policy` value from the `/*` block. */
function readCsp(): string {
  const content = readFileSync(HEADERS_FILE, 'utf8');
  const line = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('Content-Security-Policy:'));
  if (line === undefined) throw new Error('no Content-Security-Policy in _headers');
  return line.slice('Content-Security-Policy:'.length).trim();
}

/** Space-separated tokens of one CSP directive (directive name dropped). */
function directiveTokens(csp: string, name: string): string[] {
  const directive = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  if (directive === undefined) throw new Error(`no ${name} directive in CSP`);
  return directive.split(/\s+/).slice(1);
}

describe('sandbox _headers CSP', () => {
  it('restricts connect-src to self plus only the PyPI wheel hosts micropip needs', () => {
    const byName = (a: string, b: string): number => a.localeCompare(b);
    const tokens = directiveTokens(readCsp(), 'connect-src');
    expect(tokens.toSorted(byName)).toEqual(
      ["'self'", 'https://files.pythonhosted.org', 'https://pypi.org'].toSorted(byName)
    );
  });

  it('does not allow any other fetch/XHR/WS destination (no wildcard, no module CDN)', () => {
    const tokens = directiveTokens(readCsp(), 'connect-src');
    expect(tokens).not.toContain('*');
    // The module CDN is a script-src source, never a fetch target — putting it
    // in connect-src would open an exfiltration channel.
    expect(tokens).not.toContain('https://esm.sh');
  });

  it('keeps webrtc block (a hint for engines that honor it; the bootstrap is the real block)', () => {
    const tokens = directiveTokens(readCsp(), 'webrtc');
    expect(tokens).toEqual(["'block'"]);
  });

  it("denies a fresh realm — frame-src, child-src, and object-src are all 'none'", () => {
    // A child frame/worker/object would be a new realm carrying the WebRTC
    // constructors the bootstrap deletes; 'none' here removes that recovery path.
    expect(directiveTokens(readCsp(), 'frame-src')).toEqual(["'none'"]);
    expect(directiveTokens(readCsp(), 'child-src')).toEqual(["'none'"]);
    expect(directiveTokens(readCsp(), 'object-src')).toEqual(["'none'"]);
  });

  it('allows module loading from self, the module CDN, blob output, and WASM in script-src', () => {
    const tokens = directiveTokens(readCsp(), 'script-src');
    expect(tokens).toContain("'self'");
    expect(tokens).toContain('https://esm.sh');
    expect(tokens).toContain('blob:');
    expect(tokens).toContain("'wasm-unsafe-eval'");
  });

  it("allows the document's own inline scripts ('unsafe-inline' in script-src)", () => {
    // The sandbox runs untrusted document code, whose html kind IS inline
    // <script>, classic or module; a static CSP cannot nonce it. Containment is the network lockdown, not
    // script-src, so permitting inline execution grants no capability.
    const tokens = directiveTokens(readCsp(), 'script-src');
    expect(tokens).toContain("'unsafe-inline'");
  });

  it("keeps worker-src at 'none' — the runtime spawns no worker", () => {
    const tokens = directiveTokens(readCsp(), 'worker-src');
    expect(tokens).toEqual(["'none'"]);
  });

  it('limits frame-ancestors to the web origin and the mobile app-shell origins', () => {
    const tokens = directiveTokens(readCsp(), 'frame-ancestors');
    // iOS Capacitor WebView shell.
    expect(tokens).toContain('capacitor://localhost');
    // Android Capacitor WebView + dev shell (androidScheme is `http`); the
    // portless form matched only port 80, so the ported dev origin needs `:*`.
    expect(tokens).toContain('http://localhost:*');
    // Desktop web app origin.
    expect(tokens).toContain('https://hushbox.ai');
  });

  it('does not allow arbitrary embedders (no wildcard frame-ancestors)', () => {
    const tokens = directiveTokens(readCsp(), 'frame-ancestors');
    expect(tokens).not.toContain('*');
    expect(tokens).not.toContain('https:');
  });

  it("denies anything not enumerated (default-src 'none' is the floor)", () => {
    const tokens = directiveTokens(readCsp(), 'default-src');
    expect(tokens).toEqual(["'none'"]);
  });

  it('keeps the permissive CORS + resource-policy baseline for cross-origin asset fetches', () => {
    const content = readFileSync(HEADERS_FILE, 'utf8');
    expect(content).toContain('Access-Control-Allow-Origin: *');
    expect(content).toContain('Cross-Origin-Resource-Policy: cross-origin');
  });

  it('disables DNS prefetch so hostnames cannot leak via <link rel="dns-prefetch">', () => {
    const content = readFileSync(HEADERS_FILE, 'utf8');
    expect(content).toContain('X-DNS-Prefetch-Control: off');
  });

  it('is byte-identical to the single shared SANDBOX_CSP constant (no drift)', () => {
    // The static `_headers` file cannot import TypeScript, so this equality is
    // the single-source contract: the dev server and the Python test harness
    // reference SANDBOX_CSP directly, and this pins the shipped file to the same
    // bytes. A policy edit in one place without the others fails here.
    expect(readCsp()).toBe(SANDBOX_CSP);
  });

  it('ships the DNS-prefetch lock the shared security-headers constant declares', () => {
    const content = readFileSync(HEADERS_FILE, 'utf8');
    expect(SANDBOX_SECURITY_HEADERS['X-DNS-Prefetch-Control']).toBe('off');
    expect(content).toContain('X-DNS-Prefetch-Control: off');
  });
});
