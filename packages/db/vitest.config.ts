import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

export default mergeConfig(
  rootConfig,
  // defineConfig (not defineProject) because the coverage carve-out below is
  // a root-level key; the standalone `vitest run --coverage` invocation reads it.
  defineConfig({
    test: {
      name: 'db',
      environment: 'node',
      // mergeConfig concatenates with the root excludes, which already cover
      // dist, node_modules, and *.workers.test.ts (the workers files run under
      // workerd via vitest.workers.config.ts / pnpm test:workers; they import
      // cloudflare:workers and cannot load here).
      // legacy_* / legacy-* files are the non-running reference corpus,
      // excluded from every gate until their deletion.
      exclude: ['**/legacy_*', '**/legacy-*/**'],
      coverage: {
        exclude: ['**/legacy_*', '**/legacy-*/**'],
      },
    },
  })
);
