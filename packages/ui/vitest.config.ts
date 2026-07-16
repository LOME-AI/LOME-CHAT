import { defineConfig, mergeConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
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
    plugins: [react()],
    test: {
      name: 'ui',
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test-setup.ts'],
      coverage: {
        // Static inclusion over the source globs: the v8 provider only reports
        // files some test imported, so without `include` a never-imported
        // source file passes the gate silently. With it, vitest merges
        // unimported matches into the report at 0% and the per-file thresholds
        // below fail on them. (Root-config excludes still apply after
        // `include`: tests, `**/index.ts` barrels, `*.d.ts`, configs.)
        include: ['src/**/*.{ts,tsx}'],
        // Test infrastructure, not product source.
        exclude: ['src/test-setup.ts'],
        // `perFile` is load-bearing: glob thresholds otherwise compare the
        // AGGREGATE of matching files, where a small 0% file drowns among the
        // covered ones. Per-file checking plus the static `include` above is
        // what makes a never-imported file actually fail the gate instead of
        // escaping the report.
        thresholds: {
          perFile: true,
          ...COVERAGE_GATE,
        },
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
  })
);
