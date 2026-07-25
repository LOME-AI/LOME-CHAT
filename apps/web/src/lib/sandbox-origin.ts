import type { RunnableDocumentKind } from '@hushbox/shared/documents';

/**
 * The dedicated, credential-free origin that serves the document renderer pages.
 * Untrusted document code only ever executes there — never in the app origin.
 * The value is defined for every mode in the env registry, so an absent value is
 * a build/deploy misconfiguration and fails fast rather than silently degrading.
 */
export function sandboxOrigin(): string {
  const url = import.meta.env['VITE_SANDBOX_ORIGIN_URL'] as string | undefined;
  if (url === undefined) {
    throw new Error('VITE_SANDBOX_ORIGIN_URL must be defined');
  }
  return url;
}

/**
 * The renderer page for a runnable kind: python runs on the Pyodide host page,
 * every other kind on the web renderer page. Keying on the kind here keeps the
 * page split out of the iframe component.
 */
export function sandboxPageUrl(kind: RunnableDocumentKind): string {
  const page = kind === 'python' ? 'python.html' : 'render.html';
  return `${sandboxOrigin()}/${page}`;
}
