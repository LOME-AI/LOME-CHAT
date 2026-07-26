import { defaultClientConditions, defineConfig, loadEnv, build, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'path';
import { transformStreamdownSource } from './src/lib/inline-streamdown-lazy-imports';
import { resolveDeviceKeyStoreE2eVariant } from './src/lib/device-key-store-e2e-resolution';
import { previewDirectoryIndexFallback } from './src/lib/preview-directory-index-fallback';
import { headersPlugin } from '../../scripts/lib/headers-vite-plugin';
import {
  ORT_EXTERN_WASM_CONDITION,
  WORKER_BUILD_OPTIONS,
  ortAssetsPlugin,
} from '../../scripts/lib/ort-assets-plugin';

const envDir = resolve(__dirname, '../..');

function apiPreconnectPlugin(apiUrl: string | undefined): Plugin {
  return {
    name: 'api-preconnect',
    transformIndexHtml() {
      if (!apiUrl) return [];
      try {
        const origin = new URL(apiUrl).origin;
        if (origin === 'http://localhost' || origin.startsWith('http://localhost:')) return [];
        return [
          {
            tag: 'link',
            attrs: { rel: 'preconnect', href: origin, crossorigin: true },
            injectTo: 'head',
          },
        ];
      } catch {
        return [];
      }
    },
  };
}

function marketingRedirectPlugin(): Plugin {
  const astroPort = process.env['HB_ASTRO_PORT']!;
  return {
    name: 'marketing-redirect',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (url === '/') {
          res.writeHead(301, { Location: `http://localhost:${astroPort}/welcome` });
          res.end();
          return;
        }
        if (
          url === '/welcome' ||
          url === '/welcome/' ||
          url === '/privacy' ||
          url === '/privacy/' ||
          url === '/terms' ||
          url === '/terms/'
        ) {
          res.writeHead(302, { Location: `http://localhost:${astroPort}${url}` });
          res.end();
          return;
        }
        next();
      });
    },
  };
}

// E2E builds (VITE_E2E baked into the env files) swap the device-key store for
// its storageState-capturable localStorage variant at module-resolution time —
// never via a runtime env.isE2E dynamic import(), whose cancellable chunk fetch
// blanked guest share routes when a navigation raced it. `enforce: 'pre'` so
// the remap wins before Vite's own resolver handles the `@/` alias.
function deviceKeyStoreE2eVariantPlugin(): Plugin {
  const e2eModulePath = resolve(__dirname, 'src/lib/device-key-store.e2e.ts');
  return {
    name: 'device-key-store-e2e-variant',
    enforce: 'pre',
    resolveId(source, importer) {
      return resolveDeviceKeyStoreE2eVariant(source, importer, e2eModulePath);
    },
  };
}

function inlineStreamdownLazyImports(): Plugin {
  return {
    name: 'inline-streamdown-lazy-imports',
    apply: 'build',
    transform(code, id) {
      if (!id.includes('node_modules') || !id.includes('streamdown')) return null;
      const result = transformStreamdownSource(code);
      return result ? { code: result, map: null } : null;
    },
  };
}

function devAssetsPlugin(): Plugin {
  const assetsDir = resolve(__dirname, 'resources/assets');
  return {
    name: 'dev-assets',
    configureServer(server) {
      server.middlewares.use('/dev-assets', (req, res, next) => {
        const relativePath = (req.url ?? '').split('?')[0];
        if (!relativePath) return next();

        const filePath = resolve(assetsDir, `.${relativePath}`);
        if (!filePath.startsWith(assetsDir)) {
          res.statusCode = 403;
          res.end();
          return;
        }

        res.setHeader('Content-Type', 'image/png');
        createReadStream(filePath)
          .on('error', () => {
            res.statusCode = 404;
            res.end();
          })
          .pipe(res);
      });
    },
  };
}

function sharedFaviconPlugin(): Plugin {
  const faviconPath = resolve(__dirname, '../../packages/ui/src/assets/favicon.ico');
  return {
    name: 'shared-favicon',
    configureServer(server) {
      server.middlewares.use('/favicon.ico', (_req, res) => {
        res.setHeader('Content-Type', 'image/x-icon');
        createReadStream(faviconPath).pipe(res);
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'favicon.ico',
        source: readFileSync(faviconPath),
      });
    },
  };
}

// Serves the PWA manifest's app icon at a stable `/icon.png`, emitted from the
// single canonical app-icon source (shared with the native asset generator) so
// there is no committed duplicate. Mirrors sharedFaviconPlugin.
function pwaIconPlugin(): Plugin {
  const iconPath = resolve(__dirname, 'resources/assets/icon-only.png');
  return {
    name: 'pwa-icon',
    configureServer(server) {
      server.middlewares.use('/icon.png', (_req, res) => {
        res.setHeader('Content-Type', 'image/png');
        createReadStream(iconPath).pipe(res);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'icon.png', source: readFileSync(iconPath) });
    },
  };
}

// Builds the push-only service worker as a SECOND, self-contained bundle emitted
// to a STABLE unhashed `dist/sw.js` — the SW URL is its identity, so a hashed
// name is unusable, and it must be one file (a service worker cannot import
// sibling hashed chunks). A separate Vite lib build (IIFE, inlined) runs after
// the main bundle is written; `emptyOutDir: false` so it lands alongside it in
// the same dist/ that Pages and `cap sync` consume.
function serviceWorkerBuildPlugin(mode: string): Plugin {
  return {
    name: 'service-worker-build',
    apply: 'build',
    async closeBundle() {
      await build({
        configFile: false,
        root: __dirname,
        mode,
        logLevel: 'warn',
        resolve: { alias: { '@': resolve(__dirname, './src') } },
        build: {
          outDir: resolve(__dirname, 'dist'),
          emptyOutDir: false,
          minify: mode !== 'development',
          lib: {
            entry: resolve(__dirname, 'src/sw/sw.ts'),
            formats: ['iife'],
            name: 'hushboxServiceWorker',
            fileName: () => 'sw.js',
          },
          rollupOptions: {
            // The worker imports only the notification schemas from the
            // `@hushbox/shared` barrel; treat modules as side-effect-free so the
            // rest of the barrel (billing, estimate, ...) tree-shakes out instead
            // of shipping in the worker bundle.
            treeshake: { moduleSideEffects: false },
          },
        },
      });
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, envDir, 'VITE_');

  // The port only feeds the dev server; `vite build` never reads `server.port`.
  // Guard `serve` only, so the CI build job needs no generated env.
  const vitePort = Number(process.env['HB_VITE_PORT']);
  if (command === 'serve' && (!Number.isFinite(vitePort) || vitePort <= 0)) {
    throw new Error('HB_VITE_PORT is not set — run pnpm generate:env first');
  }

  return {
    envDir,
    plugins: [
      ...(env['VITE_E2E'] === 'true' ? [deviceKeyStoreE2eVariantPlugin()] : []),
      tailwindcss(),
      TanStackRouterVite({
        quoteStyle: 'single',
        routeFileIgnorePattern: '.*\\.test\\.tsx?$',
        autoCodeSplitting: true,
      }),
      react(),
      apiPreconnectPlugin(env['VITE_API_URL']),
      inlineStreamdownLazyImports(),
      sharedFaviconPlugin(),
      pwaIconPlugin(),
      serviceWorkerBuildPlugin(mode),
      // Self-hosts the onnxruntime-web WASM runtime same-origin (under
      // TTS_ORT_WASM_PATH) so the on-device TTS engine loads under the CSP with
      // no third-party CDN. Shared with the marketing (Astro) build.
      ortAssetsPlugin(),
      devAssetsPlugin(),
      marketingRedirectPlugin(),
      // Must run BEFORE previewDirectoryIndexFallback so we match against the
      // original request URL (/welcome) rather than the rewritten one
      // (/welcome/index.html).
      headersPlugin({ headersFile: resolve(__dirname, 'dist/_headers') }),
      previewDirectoryIndexFallback(resolve(__dirname, 'dist')),
    ],
    build: {
      minify: mode !== 'development',
      rollupOptions: {
        output: {
          manualChunks(id): string | undefined {
            if (id.includes('node_modules') && id.includes('streamdown')) {
              return 'streamdown';
            }
            return undefined;
          },
        },
      },
    },
    // ES-format workers keep `new.target` intact, which the TTS worker's
    // transformers dependency needs to load at all (see the constant).
    worker: WORKER_BUILD_OPTIONS,
    resolve: {
      // Picks onnxruntime-web's extern-wasm build variant so the TTS worker
      // does not drag a bundled ~21 MB wasm copy into the output alongside the
      // self-hosted one ortAssetsPlugin emits (see the constant's own comment).
      // `conditions` REPLACES Vite's defaults, so the spread is load-bearing:
      // without it, module/browser resolution breaks across the whole app.
      conditions: [ORT_EXTERN_WASM_CONDITION, ...defaultClientConditions],
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    preview: {
      strictPort: true,
    },
    server: {
      port: vitePort,
      strictPort: true,
      proxy: {
        '/api/ws': {
          target: env['VITE_API_URL']!,
          ws: true,
        },
      },
    },
  };
});
