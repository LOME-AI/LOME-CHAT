import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { crawlerApiPlugin } from './src/server/crawler-api-plugin';

const envDir = resolve(__dirname, '../..');

export default defineConfig(({ command }) => {
  // The port only feeds the dev server; this app is never built (no `build`
  // script), so guard `serve` only.
  const crawlerPort = Number(process.env['HB_CRAWLER_VIEW_PORT']);
  if (command === 'serve' && (!Number.isFinite(crawlerPort) || crawlerPort <= 0)) {
    throw new Error('HB_CRAWLER_VIEW_PORT is not set — run pnpm generate:env first');
  }

  return {
    envDir,
    plugins: [tailwindcss(), react(), crawlerApiPlugin()],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    server: {
      port: crawlerPort,
      strictPort: true,
    },
  };
});
