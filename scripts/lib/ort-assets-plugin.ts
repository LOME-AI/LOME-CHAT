/**
 * Self-host onnxruntime-web's WASM runtime same-origin.
 *
 * The on-device Kokoro TTS engine (@huggingface/transformers, via kokoro-js)
 * loads onnxruntime-web's `.wasm`/`.mjs` runtime. Left to library defaults it
 * fetches those from a third-party CDN (jsdelivr), which the production CSP
 * blocks. `tts.worker.ts` instead pins `env.backends.onnx.wasm.wasmPaths` to
 * the shared same-origin `TTS_ORT_WASM_PATH`; this plugin emits the matching
 * runtime files there so the path resolves, in dev (middleware) and in the
 * built dist (Rollup asset). The files are read from the installed package, so
 * the self-hosted copies always match the installed transformers version.
 *
 * Wired from `apps/web/vite.config.ts` and `apps/marketing/astro.config.mjs`
 * (one implementation, both surfaces).
 */
import { createRequire } from 'node:module';
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TTS_ORT_WASM_PATH } from '../../packages/shared/src/tts-hosts.js';
import type { Plugin } from 'vite';

export interface OrtAsset {
  readonly fileName: string;
  readonly absPath: string;
}

// packages/ui owns the TTS engine (its dep tree carries kokoro-js →
// @huggingface/transformers). Anchor resolution there so it works regardless of
// which app's build invokes the plugin.
const UI_PACKAGE_JSON = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packages/ui/package.json'
);

// `TTS_ORT_WASM_PATH` is the same-origin URL prefix the worker points the ORT
// runtime at (e.g. `/ort/`). Files serve/emit under the same directory.
export const ORT_DIR = TTS_ORT_WASM_PATH.replaceAll(/^\/+|\/+$/gu, '');

/**
 * onnxruntime-web's exports map offers this sibling import condition, which
 * resolves to the `dist/ort.min.mjs` build variant carrying zero
 * `new URL("ort-wasm-….wasm", import.meta.url)` references. Without it the
 * default variant resolves and every bundler that sees the TTS worker
 * statically emits its own ~21 MB copy of the wasm — one per app build.
 *
 * Its consumer contract is "self-host the .mjs/.wasm and set `wasmPaths`",
 * which `ortAssetsPlugin` above and `tts.worker.ts` already satisfy, so the
 * copies are pure waste. Added by microsoft/onnxruntime PR #24014; it is
 * documented nowhere else, including onnxruntime's own docs, so it reads as
 * mystery config without this note. Fails safe: if the condition ever stops
 * resolving, the default fat-but-working variant comes back.
 *
 * Applied via `resolve.conditions` in `apps/web/vite.config.ts` and
 * `apps/marketing/astro.config.mjs` — both import it from here rather than
 * repeating the literal, and both must spread Vite's `defaultClientConditions`
 * because `resolve.conditions` replaces them wholesale.
 */
export const ORT_EXTERN_WASM_CONDITION = 'onnxruntime-web-use-extern-wasm';

/**
 * `optimizeDeps.include` entries for the TTS worker's kokoro-js chain, written
 * in Vite's nested-dependency notation so the inner specifier is resolved from
 * kokoro-js's own directory rather than the app's.
 *
 * The chain starts at `@hushbox/ui` because every segment is resolved from the
 * previous one and the first from the app itself: under pnpm's isolated layout
 * neither app can resolve `kokoro-js` (it belongs to the UI package), so a
 * chain rooted there resolves nowhere and Vite drops the entry.
 *
 * `@huggingface/transformers` (reached through kokoro-js) imports
 * `onnxruntime-common` as a bare specifier without declaring it — a phantom
 * dependency, resolvable only through pnpm's hoist dir. That dir is on the
 * node-resolution walk from a file inside `.pnpm/…`, but not from the physical
 * copy the dep optimizer writes into an app's `node_modules/.vite/deps`, so an
 * optimizer anchored there cannot resolve it. It then externalizes the
 * unresolvable import silently — no error, no warning; the prebundle simply
 * keeps a bare `onnxruntime-common` specifier the browser then fails to load —
 * and reuses that output forever, because a later optimize with an unchanged
 * cache key reports a consistent hash and skips. A prebundle poisoned in the
 * window between a lockfile write and a hoist-link creation therefore survives
 * every restart, and the resulting import error names neither the cause nor the
 * cache. Listing the dependency pins it to an anchor that can resolve it and
 * gives it its own prebundle, which the kokoro-js prebundle then links against
 * instead of inlining a private copy — so both hold the same ORT module and
 * `instanceof Tensor` keeps working across the boundary. When the chain does
 * break, the Astro dev server names the failing entry at start ("Failed to
 * resolve dependency: … present in client 'optimizeDeps.include'"); the Vite
 * dev server drops it without a message, so the entry is a guard there only in
 * the structural sense.
 *
 * Dev-only: production is unaffected because Rollup resolves against the real
 * importer file, which always sits inside `.pnpm/…`.
 *
 * Applied via `optimizeDeps.include` in `apps/web/vite.config.ts` and
 * `apps/marketing/astro.config.mjs` — both import it from here rather than
 * repeating the literal.
 */
export const KOKORO_ORT_COMMON_INCLUDE = ['@hushbox/ui > kokoro-js > onnxruntime-common'];

/**
 * Locate the installed `@huggingface/transformers` dist directory (reached
 * through kokoro-js's dependency), which holds the ORT runtime files bundled
 * with the exact transformers version loaded at runtime.
 */
export function ortDistributionDir(anchorPackageJson: string = UI_PACKAGE_JSON): string {
  const kokoroEntry = createRequire(anchorPackageJson).resolve('kokoro-js');
  const transformersEntry = createRequire(kokoroEntry).resolve('@huggingface/transformers');
  return path.dirname(transformersEntry);
}

/**
 * Collect the onnxruntime-web `.wasm`/`.mjs` runtime files from a dist
 * directory. Throws if none are present — a self-host with no runtime to serve
 * is a broken build, not a silent no-op.
 */
export function collectOrtAssets(distributionDir: string): OrtAsset[] {
  const files = readdirSync(distributionDir).filter((name) => /^ort-.*\.(wasm|mjs)$/u.test(name));
  if (files.length === 0) {
    throw new Error(
      `No onnxruntime-web WASM assets (ort-*.wasm/.mjs) found in ${distributionDir}. ` +
        `The TTS runtime cannot be self-hosted; check @huggingface/transformers is installed.`
    );
  }
  return files.map((fileName) => ({ fileName, absPath: path.resolve(distributionDir, fileName) }));
}

/**
 * Resolve onnxruntime-web's runtime files from the installed transformers, so
 * the self-hosted copies always match the version loaded at runtime.
 */
export function resolveOrtAssets(anchorPackageJson: string = UI_PACKAGE_JSON): OrtAsset[] {
  return collectOrtAssets(ortDistributionDir(anchorPackageJson));
}

export function contentTypeFor(fileName: string): string {
  return fileName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
}

/**
 * Vite plugin that serves the ORT runtime files same-origin in dev and emits
 * them into the built dist. Shared verbatim by the web (Vite) and marketing
 * (Astro) builds.
 */
export function ortAssetsPlugin(): Plugin {
  const assets = resolveOrtAssets();
  return {
    name: 'ort-wasm-self-host',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const match = assets.find((asset) => url === `${TTS_ORT_WASM_PATH}${asset.fileName}`);
        if (match === undefined) {
          next();
          return;
        }
        res.setHeader('Content-Type', contentTypeFor(match.fileName));
        createReadStream(match.absPath).pipe(res);
      });
    },
    generateBundle() {
      for (const asset of assets) {
        this.emitFile({
          type: 'asset',
          fileName: `${ORT_DIR}/${asset.fileName}`,
          source: readFileSync(asset.absPath),
        });
      }
    },
  };
}
