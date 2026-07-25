import { transform } from 'sucrase';

/**
 * In-browser JSX/TypeScript transpile for react documents. Sucrase is bundled
 * into the classic renderer script (pinned, ~40 KB) rather than fetched at
 * render time, so transpilation is synchronous and needs no network — the frame
 * loads only the document's own module graph.
 *
 * The automatic JSX runtime is used so authors never import React by hand: the
 * transpiler injects a `react/jsx-runtime` import, which specifier resolution
 * rewrites to the pinned React build like any other bare import.
 */
export class TranspileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TranspileError';
  }
}

/** Transpile a react document's JSX/TSX source to a browser ES module. */
export function transpileReact(code: string): string {
  try {
    return transform(code, {
      transforms: ['jsx', 'typescript'],
      jsxRuntime: 'automatic',
      production: true,
    }).code;
  } catch (error) {
    // Sucrase throws a SyntaxError whose string form carries the location; keep
    // it verbatim as the surfaced message and the original as the cause.
    throw new TranspileError(String(error), { cause: error });
  }
}
