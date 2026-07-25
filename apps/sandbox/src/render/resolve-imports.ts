import { moduleUrlFor, type VersionPins } from './specifier.js';

/**
 * Resolution of the bare module specifiers a document imports. Every bare
 * specifier is rewritten to an absolute CDN URL in the module source before the
 * source is handed to the engine, so the frame needs no import map at all.
 *
 * That matters beyond tidiness: an import map takes effect only when it is
 * inserted, and engines that support just one per document (Android System
 * WebView 113 among them) ignore every later map — so a specifier that first
 * appeared in a re-`init` of a live frame could never resolve there, which is
 * exactly what a document gains as it streams. Rewriting has no such
 * per-document state, so a frame resolves the same specifiers on its tenth init
 * as on its first, on every engine.
 *
 * Rewriting is safe against the CDN's own graph: esm.sh emits absolute URLs for
 * its dependencies (`/react@19.1.0/es2022/react.mjs`), never bare specifiers, so
 * nothing downstream of the document's own source needs resolving.
 *
 * Kept pure and separate from the browser bootstrap so the rules are unit-tested
 * in Node, not only exercised in a live frame.
 */

export interface RewriteBareImportsInput {
  /** The module source to rewrite (already transpiled, for react documents). */
  readonly code: string;
  /** CDN base URL (esm.sh in production, a local stub in test modes). */
  readonly cdnBase: string;
  /** Version pins applied when a specifier declares no version of its own. */
  readonly pins: VersionPins;
}

// One pattern for all three forms — static `from '…'`, side-effect
// `import '…'`, and dynamic `import('…')` — capturing the lead, the quote, and
// the specifier. The dynamic form's closing paren is left outside the match
// because nothing before the closing quote needs to change. Deliberately
// syntactic: a document is one module of generated code, and matching import
// syntax is enough to resolve it without carrying a parser into the frame. The
// cost is that an import-shaped string inside a literal is rewritten too — a
// visible-but-harmless change to that string, never a broken import.
const SPECIFIER_PATTERN = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"]+)\2/g;

/** A specifier is bare when it is neither a relative/absolute path nor a URL. */
function isBareSpecifier(specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  // Any scheme (`https:`, `blob:`, `data:`) makes it a non-bare, already-resolved URL.
  return !/^[a-z][a-z0-9+.-]*:/i.test(specifier);
}

/** Rewrite every bare import specifier in a module source to its CDN URL. */
export function rewriteBareImports(input: RewriteBareImportsInput): string {
  return input.code.replaceAll(
    SPECIFIER_PATTERN,
    (match, lead: string, quote: string, specifier: string) => {
      if (!isBareSpecifier(specifier)) return match;
      return `${lead}${quote}${moduleUrlFor(specifier, input.cdnBase, input.pins)}${quote}`;
    }
  );
}
