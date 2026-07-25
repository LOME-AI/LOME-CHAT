import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// The app-origin frame-src policy that must reach the bundled Capacitor WebView,
// where the generated `_headers` CSP does not apply. Pinned here so a future edit
// that drops or widens it fails before review. Runtime enforcement (a sandboxed
// document being unable to navigate its own frame to an off-allowlist host) is a
// browser behavior verified on the web via the security suite and on-device via
// the Android Maestro flow — jsdom does not enforce CSP, so this suite pins the
// policy's presence and exact shape, which is what mobile containment rests on.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(path.resolve(HERE, '../../index.html'), 'utf8');

function frameSourceDirective(html: string): string | null {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  if (!meta) return null;
  const directive = /frame-src ([^;"]*)/i.exec(meta[1] ?? '');
  return directive ? (directive[1] ?? '').trim() : null;
}

describe('app-origin frame-src (mobile CSP)', () => {
  it('ships a Content-Security-Policy meta tag in the app HTML', () => {
    expect(INDEX_HTML).toMatch(/<meta\s+http-equiv="Content-Security-Policy"/i);
  });

  it('constrains child frames to self and the sandbox origin', () => {
    const frameSource = frameSourceDirective(INDEX_HTML);
    expect(frameSource).not.toBeNull();
    expect(frameSource).toContain("'self'");
    // Per-mode sandbox origin substituted by Vite at build time — never a
    // hard-coded domain, so dev/preview/prod each get the correct allowlist.
    expect(frameSource).toContain('%VITE_SANDBOX_ORIGIN_URL%');
  });

  it('never allows an arbitrary child-frame host', () => {
    const frameSource = frameSourceDirective(INDEX_HTML) ?? '';
    // A bare wildcard would defeat containment — a document could navigate its
    // frame anywhere and exfiltrate in the URL.
    expect(frameSource.split(/\s+/)).not.toContain('*');
  });

  it('sets no default-src, so only framing is narrowed', () => {
    const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(
      INDEX_HTML
    );
    expect(meta?.[1]).not.toMatch(/default-src/i);
  });
});
