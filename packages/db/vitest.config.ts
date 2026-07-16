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
        // Static inclusion over the real runtime source globs: the v8 provider
        // only reports files some test imported, so without `include` a
        // never-imported source file passes the gate silently. With it, vitest
        // merges unimported matches into the report at 0% and the per-file
        // thresholds below catch them. (Root-config excludes still apply after
        // `include`: tests, `**/index.ts` barrels, `**/__tests__/**`, *.d.ts.)
        include: [
          'src/schema/**/*.ts',
          'src/client.ts',
          'src/evidence.ts',
          'src/workers-validation/txn-executor.ts',
        ],
        exclude: [
          '**/legacy_*',
          '**/legacy-*/**',
          // Fishery test-data builders are test infrastructure, not product
          // source — exercised by the suites they seed, never gated themselves.
          'src/factories/**',
          // The DO worker entry imports `cloudflare:workers` and cannot load in
          // this node-environment project; the finalize logic it delegates to
          // lives in the covered `txn-executor.ts` neighbor (included above).
          'src/workers-validation/test-worker.ts',
        ],
        // `perFile` is load-bearing: glob thresholds otherwise compare the
        // AGGREGATE of matching files, where a small 0% file drowns among the
        // covered schema lines. Per-file checking plus the static `include`
        // above is what makes a never-imported file actually fail the gate
        // instead of escaping the report.
        thresholds: {
          perFile: true,
          'src/schema/**/*.ts': COVERAGE_GATE,
          'src/client.ts': COVERAGE_GATE,
          'src/evidence.ts': COVERAGE_GATE,
          'src/workers-validation/txn-executor.ts': COVERAGE_GATE,
        },
      },
    },
  })
);
