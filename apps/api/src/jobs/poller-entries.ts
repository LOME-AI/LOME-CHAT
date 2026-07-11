import { refreshCatalog } from '../slices/models/index.js';
import { runOrThrow } from './cron.js';
import type { RefreshCatalogDeps, RefreshJitter } from '../slices/models/index.js';
import type { CronEntry } from './cron.js';

/**
 * The hourly model-catalog poller. The refresh itself is the models slice's
 * published, skip-unchanged, upsert-converging query; the cron only supplies
 * live infra and a start jitter.
 */

/** Random start delay ceiling so a fleet of triggers spreads out. */
export const CATALOG_REFRESH_JITTER_MAX_MS = 60_000;

export function productionRefreshJitter(): RefreshJitter {
  return {
    maxMs: CATALOG_REFRESH_JITTER_MAX_MS,
    random: Math.random,
    sleep: (ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

export function createCatalogRefreshEntry(deps: RefreshCatalogDeps): CronEntry {
  return {
    name: 'model-catalog-refresh',
    run: async (): Promise<void> => {
      await runOrThrow(refreshCatalog(deps));
    },
  };
}
