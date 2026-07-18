import { analyzeUrl } from '../engine';
import { handleCrawl, handleSitemap } from './handlers';
import type { Plugin } from 'vite';

function originFromPort(port: string | undefined): string | null {
  if (port === undefined || port === '') {
    return null;
  }
  const parsed = Number(port);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return `http://localhost:${port}`;
}

/**
 * Exposes the crawler engine over HTTP from the Vite dev server (dev-only:
 * `configureServer` runs only under `vite serve`). The engine's global `fetch`
 * works here because this is the dev server's Node process. Handlers live in
 * `./handlers` (unit-tested); this wrapper only registers them and injects the
 * dev origins read from the generated env.
 */
export function crawlerApiPlugin(): Plugin {
  return {
    name: 'hushbox:crawler-api',
    configureServer(server) {
      const marketingOrigin = originFromPort(process.env['HB_ASTRO_PORT']);
      const webOrigin = originFromPort(process.env['HB_VITE_PORT']);

      // The handlers resolve every request internally (they catch engine/fetch
      // failures and always send a response), so the returned promise cannot
      // reject; `void` discards it without a floating-promise warning.
      server.middlewares.use('/api/crawl', (req, res) => {
        void handleCrawl(req, res, { analyzeImpl: analyzeUrl });
      });

      server.middlewares.use('/api/sitemap', (req, res) => {
        void handleSitemap(req, res, { fetchImpl: fetch, marketingOrigin, webOrigin });
      });
    },
  };
}
