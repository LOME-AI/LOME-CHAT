import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { stripApiPrefix } from './src/lib/api-proxy.js';
import { headersPlugin } from '../../scripts/lib/headers-vite-plugin';
import { generateAdminHeaders } from '../../scripts/generate-headers';
import { appBundleOptions, verifyBundle } from '../../scripts/verify-bundle';
import type { Plugin } from 'vite';

const rootDir = resolve(__dirname, '../..');
const distDir = resolve(__dirname, 'dist');
const headersFile = resolve(distDir, '_headers');

// After `vite build`, finish the dist: emit dist/_headers so the assets-only
// admin Worker serves the CSP + X-Frame-Options: DENY + HSTS stack on
// admin.hushbox.ai, then verify the finished bundle. Headers are built here
// (not a separate script step like the web bundle's) because admin has no
// marketing-merge to sequence around; `closeBundle` runs once the shell's inline
// pre-paint scripts are written, which generateAdminHeaders hashes into the CSP.
//
// Verification lives in this hook, not a second plugin, because Rollup runs
// `closeBundle` as a parallel hook — sibling plugins' hooks are started
// together, so plugin order would not sequence them. The order is load-bearing:
// `_headers` is an emitted file and the Cloudflare Pages file-count check
// counts it.
function finalizeAdminDistPlugin(): Plugin {
  return {
    name: 'finalize-admin-dist',
    apply: 'build',
    async closeBundle() {
      await generateAdminHeaders({ distDir });
      await verifyBundle(appBundleOptions(rootDir, 'apps/admin'));
    },
  };
}

export default defineConfig(({ command }) => {
  // Ports feed the dev server and the `vite preview` build; `vite build`
  // reads neither `server.*` nor `preview.*`. `vite preview` resolves config
  // with `command === 'serve'`, so this one guard covers dev and preview,
  // while the CI build job (`command === 'build'`) needs no generated env.
  const adminPort = Number(process.env['HB_ADMIN_PORT']);
  const apiPort = Number(process.env['HB_API_PORT']);
  if (command === 'serve' && (!Number.isFinite(adminPort) || adminPort <= 0)) {
    throw new Error('HB_ADMIN_PORT is not set — run pnpm generate:env first');
  }
  if (command === 'serve' && (!Number.isFinite(apiPort) || apiPort <= 0)) {
    throw new Error('HB_API_PORT is not set — run pnpm generate:env first');
  }

  // The SPA always calls relative `/api/*`. In production Cloudflare routes
  // `admin.hushbox.ai/api/*` to the product Worker; locally this proxy plays
  // that role, stripping the `/api` prefix so the Worker sees its real
  // root-mounted paths (`/admin/...`, `/dev/...`). Shared by the dev server
  // and the `vite preview` static build (the admin e2e suite targets the
  // preview), so both reach the Worker identically. See src/lib/api-client.ts
  // for the full mapping.
  const apiProxy = {
    '/api': {
      target: `http://localhost:${String(apiPort)}`,
      rewrite: stripApiPrefix,
      // The browser's origin is forwarded as-is: the Worker's CSRF Origin
      // check admits the configured ADMIN_URL (the local admin origin in
      // development mode). changeOrigin rewrites only the Host header to the
      // target — load-bearing, not cosmetic: wrangler dev rewrites an Origin
      // header that MATCHES the request Host (same-origin shape) to its
      // internal origin, which would fail the Worker's allowlist. With Host
      // rewritten, the true Origin survives to the CSRF check, same as
      // production.
      changeOrigin: true,
    },
  };

  return {
    envDir: rootDir,
    plugins: [
      tailwindcss(),
      TanStackRouterVite({
        quoteStyle: 'single',
        routeFileIgnorePattern: '.*\\.test\\.tsx?$',
        autoCodeSplitting: true,
      }),
      react(),
      finalizeAdminDistPlugin(),
      // Applies the generated _headers to `vite preview` responses, so the admin
      // E2E suite (which drives the preview build) enforces the production CSP —
      // the same mechanism the web bundle uses. Inert in dev (see plugin doc).
      headersPlugin({ headersFile }),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    preview: {
      port: adminPort,
      strictPort: true,
      proxy: apiProxy,
    },
    server: {
      port: adminPort,
      strictPort: true,
      proxy: apiProxy,
    },
  };
});
