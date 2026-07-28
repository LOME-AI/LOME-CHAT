/**
 * The build-config seam: values whose correctness depends on being identical
 * across build surfaces, written once here and imported rather than restated
 * per app.
 */
import { createRequire } from 'node:module';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
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
 * which `ortAssetsPlugin` below and `tts.worker.ts` already satisfy, so the
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
 * Vite's worker build options, shared by both app configs.
 *
 * `format: 'es'` is load-bearing, not a preference. Under the default `iife`
 * worker format, rolldown's transform wraps the worker and rewrites its
 * `MetaProperty` nodes — but it rewrites `new.target` as though it were
 * `import.meta`, emitting `Object.setPrototypeOf(closure, <importMetaStandIn>
 * .prototype)`. `@huggingface/transformers`' `Callable` base class, which every
 * tokenizer and processor extends, is built on exactly that
 * `Object.setPrototypeOf(closure, new.target.prototype)` line, so the rewrite
 * makes the TTS worker throw "Object prototype may only be an Object or null:
 * undefined" on its load path in every built site — while dev, which serves the
 * worker as a native ES module and never applies the transform, stays green.
 * The rewrite fires on `new.target` alone; the worker source need not mention
 * `import.meta` at all.
 *
 * `es` emits the worker unwrapped, so `new.target` survives. The TTS worker is
 * the only `new Worker` in the repo and is already constructed with
 * `{ type: 'module' }`, so nothing here depends on the classic-worker format.
 * `verify-bundle` guards the built output against the rewrite returning.
 *
 * Lives beside the ORT constants because this is the build-config seam both
 * `apps/web/vite.config.ts` and `apps/marketing/astro.config.mjs` already
 * import from; the format must never be spelled out per-app.
 */
export const WORKER_BUILD_OPTIONS = { format: 'es' } as const;

/**
 * Absolute path to the TTS worker's source, for use as an
 * `optimizeDeps.entries` scan entry in dev.
 *
 * Vite's dependency scanner never crosses a
 * `new Worker(new URL(…, import.meta.url))` edge: the plugin that understands
 * that pattern is registered only in the main pipeline, not in the scanner's
 * reduced plugin set. Dynamic imports are followed; worker entry points are
 * not. So kokoro-js — imported only inside the TTS worker — is invisible at
 * startup and gets discovered on the first worker fetch. Late discovery
 * re-chunks the whole prebundle, and any prebundle hash change forces a
 * full-page reload, which costs the user their first click on Listen / read
 * aloud.
 *
 * Naming the worker's source as a scan entry makes the scanner walk it at
 * startup. The path is named rather than the package, so nothing here can
 * drift against `packages/ui`'s dependency list and every future worker-only
 * dependency is covered by the same entry.
 */
export function resolveTtsWorkerSource(
  workerPath: string = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../packages/ui/src/components/accessibility/lib/tts.worker.ts'
  )
): string {
  if (!existsSync(workerPath)) {
    throw new Error(
      `TTS worker source not found at ${workerPath}. The dev dependency scanner ` +
        `cannot reach kokoro-js without it, so the first TTS click would trigger a ` +
        `full-page reload; update the path if the worker moved.`
    );
  }
  return workerPath;
}

/**
 * Resolved at config load so a moved or renamed worker fails the dev server
 * loudly instead of silently restoring the first-click reload. This assert is
 * the regression guard for that behaviour.
 */
export const TTS_WORKER_SCAN_ENTRY = resolveTtsWorkerSource();

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
