import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { A11Y_INIT_SCRIPT } from '@hushbox/ui/accessibility/init-script';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.resolve(HERE, '../../index.html');

/**
 * Normalize away the only differences Prettier is allowed to introduce
 * between the shipped constant and its inline copy (same rationale as
 * apps/web/src/lib/a11y-flash-script.test.ts): quote style and whitespace.
 * Any logic drift between the two copies fails the parity test.
 */
function normalizeScript(s: string): string {
  return s.replaceAll(/["']/g, '"').replaceAll(/\s+/g, ' ').replaceAll('{ }', '{}').trim();
}

describe('index.html pre-paint accessibility script', () => {
  const html = readFileSync(INDEX_HTML, 'utf8');

  it('embeds the shipped A11Y_INIT_SCRIPT so accessibility prefs apply before first paint', () => {
    expect(normalizeScript(html)).toContain(normalizeScript(A11Y_INIT_SCRIPT));
  });

  it('places the accessibility script inside the <head>', () => {
    const normalizedHtml = normalizeScript(html);
    const scriptStart = normalizedHtml.indexOf(normalizeScript(A11Y_INIT_SCRIPT));
    expect(scriptStart).toBeGreaterThan(-1);
    expect(normalizedHtml.indexOf(normalizeScript('</head>'))).toBeGreaterThan(scriptStart);
  });
});
