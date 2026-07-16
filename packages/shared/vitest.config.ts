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
  // defineProject silently drops `coverage`, so a never-imported file would
  // pass the gate unseen.
  defineConfig({
    test: {
      name: 'shared',
      environment: 'node',
      exclude: ['**/dist/**', '**/node_modules/**'],
      coverage: {
        // Static inclusion over the runtime source tree: the v8 provider only
        // reports files some test imported, so without `include` a
        // never-imported file escapes the report entirely. With it, vitest
        // merges unimported matches in at 0% and the per-file gate catches
        // them. (Root-config excludes still apply after `include`: tests,
        // `**/index.ts` barrels, configs, `*.d.ts`.)
        include: ['src/**/*.ts'],
        exclude: [
          // Test infrastructure, exported for other packages' suites — not
          // product runtime. The base config already drops barrels, test/spec
          // files, and configs; these are the remaining in-repo test helpers.
          'src/__tests__/**',
          'src/test-utilities.ts',
          'src/test-polyfills.ts',
          'src/test-ids.ts',
          'src/test-signals.ts',
          // Self-declared test infrastructure: backs the live-catalog drift
          // watchdog test and is never imported by production (its own header
          // states this). Exercised by its colocated test, not product runtime.
          'src/models/live-catalog-fetch.ts',
        ],
        // `perFile` is load-bearing: without it a glob threshold compares the
        // AGGREGATE of matching files, where a small 0% file drowns among the
        // covered ones. Per-file checking plus the static `include` above is
        // what makes a never-imported file fail the gate instead of escaping
        // the report.
        thresholds: {
          perFile: true,
          ...COVERAGE_GATE,
        },
      },
    },
  })
);
