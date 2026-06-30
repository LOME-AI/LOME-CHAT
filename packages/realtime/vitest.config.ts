import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

export default mergeConfig(
  rootConfig,
  // defineConfig (not defineProject) because the coverage keys below are
  // root-level: the standalone `vitest run --coverage` invocation reads them.
  defineConfig({
    test: {
      name: 'realtime',
      environment: 'node',
      // *.workers.test.ts files run under workerd via vitest.workers.config.ts
      // (pnpm test:workers); they import cloudflare:workers and cannot load here.
      // legacy_* files are the non-running reference corpus, excluded from
      // every gate until their deletion.
      exclude: ['**/dist/**', '**/node_modules/**', '**/*.workers.test.ts', '**/legacy_*'],
      coverage: {
        // The DO classes and the workers test worker are platform glue (thin
        // shell): exercised under workerd without coverage per the
        // test-placement doctrine — all logic lives in the plain modules the
        // node project covers. legacy_* carries no gate.
        exclude: [
          'src/conversation-room.ts',
          'src/job-dispatcher.ts',
          'src/workers-validation/**',
          '**/legacy_*',
        ],
      },
    },
  })
);
