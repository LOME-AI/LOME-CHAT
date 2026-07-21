import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'path';
import { transformStreamdownSource } from './src/lib/inline-streamdown-lazy-imports';
import { resolveDeviceKeyStoreE2eVariant } from './src/lib/device-key-store-e2e-resolution';
import { previewDirectoryIndexFallback } from './src/lib/preview-directory-index-fallback';
import { headersPlugin } from '../../scripts/lib/headers-vite-plugin';

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
    resolve: {
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
