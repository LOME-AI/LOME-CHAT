import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { stripApiPrefix } from './src/lib/api-proxy.js';

const envDir = resolve(__dirname, '../..');

export default defineConfig(({ command }) => {
  // Ports only feed the dev server; `vite build` never reads `server.*`.
  // Guard `serve` only, so the CI build job needs no generated env.
  const adminPort = Number(process.env['HB_ADMIN_PORT']);
  const apiPort = Number(process.env['HB_API_PORT']);
  if (command === 'serve' && (!Number.isFinite(adminPort) || adminPort <= 0)) {
    throw new Error('HB_ADMIN_PORT is not set — run pnpm generate:env first');
  }
  if (command === 'serve' && (!Number.isFinite(apiPort) || apiPort <= 0)) {
    throw new Error('HB_API_PORT is not set — run pnpm generate:env first');
  }

  return {
    envDir,
    plugins: [
      tailwindcss(),
      TanStackRouterVite({
        quoteStyle: 'single',
        routeFileIgnorePattern: '.*\\.test\\.tsx?$',
        autoCodeSplitting: true,
      }),
      react(),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    preview: {
      strictPort: true,
    },
    server: {
      port: adminPort,
      strictPort: true,
      // The SPA always calls relative `/api/*`. In production Cloudflare
      // routes `admin.hushbox.ai/api/*` to the product Worker; locally this
      // proxy plays that role, stripping the `/api` prefix so the Worker sees
      // its real root-mounted paths (`/admin/...`, `/dev/...`). See
      // src/lib/api-client.ts for the full mapping.
      proxy: {
        '/api': {
          target: `http://localhost:${String(apiPort)}`,
          rewrite: stripApiPrefix,
          // The browser's dev origin is forwarded as-is: the Worker's CSRF
          // Origin check admits the configured ADMIN_URL (the local dev
          // admin origin in development mode). changeOrigin rewrites only
          // the Host header to the target — load-bearing, not cosmetic:
          // wrangler dev rewrites an Origin header that MATCHES the request
          // Host (same-origin shape) to its internal origin, which would
          // fail the Worker's allowlist. With Host rewritten, the true
          // Origin survives to the CSRF check, same as production.
          changeOrigin: true,
        },
      },
    },
  };
});
