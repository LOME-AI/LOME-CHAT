/* global process */
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

import { defaultClientConditions } from 'vite';

import {
  ORT_EXTERN_WASM_CONDITION,
  TTS_WORKER_SCAN_ENTRY,
  WORKER_BUILD_OPTIONS,
  ortAssetsPlugin,
} from '../../scripts/lib/build-seam.ts';

const vitePort = process.env['HB_VITE_PORT'] ?? '5173';
const astroPort = process.env['HB_ASTRO_PORT'];

// Paths the marketing dev server hands off to the Vite app: SPA routes the real
// app owns (auth, chat) plus `/demo`, the embedded product-demo SPA. Production
// uses the generated `_headers` instead of this dev-only redirect.
const SPA_REDIRECT_PATHS = new Set([
  '/login',
  '/login/',
  '/signup',
  '/signup/',
  '/chat',
  '/chat/',
  '/demo',
  '/demo/',
]);

export default defineConfig({
  site: 'https://hushbox.ai',
  integrations: [mdx(), react(), sitemap()],
  // CSP hashes for inline scripts are produced by `scripts/generate-headers.ts`,
  // which walks built HTML directly and hashes every <script> body (Astro-emitted
  // and `is:inline` project scripts alike). Astro's own `experimental.csp` is
  // deliberately NOT enabled: it only hashes scripts it owns and skips
  // `<script is:inline>`, so the four project-authored bootstrap scripts
  // (theme, a11y, menu toggle, scroll arrow) would be missing hashes and
  // blocked in production. Doing all hashing in the generator gives us one
  // source of truth and covers every inline script regardless of how it was
  // emitted.
  //
  // Known limitation: code blocks in MDX go through Shiki, which emits
  // per-token inline style="color:#..." attributes that cannot be hashed.
  // No blog post currently uses code fences. Adding one will fail the e2e
  // regression test once style-src drops 'unsafe-inline'.
  server: {
    port: Number(astroPort ?? 4321),
  },
  vite: {
    // Read env files from the repo root (where `pnpm generate:env` writes
    // `.env.development`) instead of `apps/marketing/`. Mirrors the same
    // override in `apps/web/vite.config.ts` so both apps see the single
    // generated env file.
    envDir: '../..',
    // Astro 5 overrides Vite's default `envPrefix` from `VITE_` to `PUBLIC_`,
    // which would skip `VITE_API_URL` substitution in client islands. Restore
    // `VITE_` alongside `PUBLIC_` so the var defined in envConfig (and shared
    // with `apps/web`) reaches browser code. See
    // node_modules/astro/dist/core/create-vite.js:147.
    envPrefix: ['PUBLIC_', 'VITE_'],
    // ES-format workers keep `new.target` intact, which the TTS worker's
    // transformers dependency needs to load at all (see the constant).
    worker: WORKER_BUILD_OPTIONS,
    optimizeDeps: {
      // Prebundles kokoro-js at startup instead of on the first Listen click,
      // which would otherwise force a full-page reload (see the constant).
      // Unlike plain Vite, this does not replace a default: Astro sets its own
      // srcDir scan entry in the inline config it merges ours into, and Vite's
      // config merge concatenates arrays, so both entries survive.
      entries: [TTS_WORKER_SCAN_ENTRY],
    },
    resolve: {
      // Picks onnxruntime-web's extern-wasm build variant so the blog TTS
      // worker does not drag a bundled ~21 MB wasm copy into the output
      // alongside the self-hosted one ortAssetsPlugin emits (see the
      // constant's own comment). `conditions` REPLACES Vite's defaults, so the
      // spread is load-bearing: without it, module/browser resolution breaks
      // across the whole site. Astro passes user `resolve.conditions` through
      // untouched (its own create-vite.js sets none).
      conditions: [ORT_EXTERN_WASM_CONDITION, ...defaultClientConditions],
    },
    plugins: [
      tailwindcss(),
      // Self-hosts the onnxruntime-web WASM runtime same-origin (under
      // TTS_ORT_WASM_PATH) so the blog "Listen" TTS engine loads under the CSP
      // with no third-party CDN. Shared with the web (Vite) build.
      ortAssetsPlugin(),
      {
        name: 'spa-redirect',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = req.url?.split('?')[0] ?? '';
            if (SPA_REDIRECT_PATHS.has(url)) {
              res.writeHead(302, { Location: `http://localhost:${vitePort}${url}` });
              res.end();
              return;
            }
            next();
          });
        },
      },
    ],
  },
  outDir: 'dist',
  build: {
    format: 'directory',
  },
});
