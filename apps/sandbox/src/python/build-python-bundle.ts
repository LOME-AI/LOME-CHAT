import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

/**
 * Bundles the Python runtime into `public/python.js` — the single classic script
 * the Pyodide host page loads. The bridge schemas and the error classifier are
 * inlined so the page needs no `type="module"` bootstrap; the Pyodide loader is a
 * runtime import from this same origin, left external. The output is committed and
 * a drift test re-runs this to guarantee it stays current with the source.
 */

const pythonDir = path.dirname(fileURLToPath(import.meta.url));
const entryPoint = path.join(pythonDir, 'bootstrap.ts');

/** Absolute path of the committed Python-runtime bundle the sandbox page serves. */
export const PYTHON_BUNDLE_PATH = path.join(pythonDir, '..', '..', 'public', 'python.js');

/** Build the Python-runtime bundle and return its source text. */
export async function buildPythonBundle(): Promise<string> {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    // Classic script (an IIFE), never an ES module: the page loads it with a plain
    // <script> tag, matching the web renderer's bootstrap discipline.
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    write: false,
  });
  const output = result.outputFiles[0];
  /* v8 ignore next -- esbuild always emits exactly one output for a single entry */
  if (output === undefined) throw new Error('esbuild produced no output for the Python bundle');
  return output.text;
}

/** (Re)write the committed bundle from source. */
export async function writePythonBundle(): Promise<void> {
  writeFileSync(PYTHON_BUNDLE_PATH, await buildPythonBundle());
}

/* v8 ignore start -- CLI entry, exercised via the `build:python` package script */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writePythonBundle();
  console.log('✓ Python runtime bundle written to public/python.js');
}
/* v8 ignore stop */
