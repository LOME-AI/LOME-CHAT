import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

/**
 * Bundles the web renderer into `public/render.js` — the single classic script
 * the sandbox page loads. Sucrase, the bridge schemas, and the specifier
 * resolution are inlined so the page needs no `type="module"` bootstrap and no
 * network beyond the document's own imports. The output is committed and a drift test
 * re-runs this to guarantee it stays current with the source.
 */

const renderDir = path.dirname(fileURLToPath(import.meta.url));
const entryPoint = path.join(renderDir, 'bootstrap.ts');

/** Absolute path of the committed renderer bundle the sandbox page serves. */
export const RENDER_BUNDLE_PATH = path.join(renderDir, '..', '..', 'public', 'render.js');

/** Build the renderer bundle and return its source text. */
export async function buildRenderBundle(): Promise<string> {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    // Classic script (an IIFE), never an ES module: a module script is deferred,
    // and the page's own script must have run — closing the WebRTC egress
    // channel — before anything else in the frame can execute.
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    write: false,
  });
  const output = result.outputFiles[0];
  /* v8 ignore next -- esbuild always emits exactly one output for a single entry */
  if (output === undefined) throw new Error('esbuild produced no output for the renderer bundle');
  return output.text;
}

/** (Re)write the committed bundle from source. */
export async function writeRenderBundle(): Promise<void> {
  writeFileSync(RENDER_BUNDLE_PATH, await buildRenderBundle());
}

/* v8 ignore start -- CLI entry, exercised via the `build:render` package script */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeRenderBundle();
  console.log('✓ renderer bundle written to public/render.js');
}
/* v8 ignore stop */
