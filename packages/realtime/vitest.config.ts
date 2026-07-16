import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

const COVERAGE_GATE = {
  lines: 95,
  branches: 95,
  functions: 95,
  statements: 95,
};

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
        // Static inclusion over the runtime source globs: the v8 provider only
        // reports files some test imported, so without `include` a
        // never-imported source file passes the gate silently. With it, vitest
        // merges the unimported matches into the report at 0% and the per-file
        // thresholds below fail on them. (Root-config excludes still apply:
        // tests, `**/index.ts` barrels, `*.d.ts`, configs.)
        include: ['src/**/*.ts'],
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
        // `perFile` is load-bearing: a glob threshold otherwise AGGREGATES its
        // matching files, letting a small 0% file drown among covered lines.
        // Per-file checking plus the static `include` makes a never-imported
        // file actually fail the gate instead of escaping the report.
        thresholds: {
          perFile: true,
          'src/**/*.ts': COVERAGE_GATE,
        },
      },
    },
  })
);
