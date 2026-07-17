import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

const COVERAGE_GATE = {
  lines: 95,
  branches: 95,
  functions: 95,
  statements: 95,
};

// defineConfig (not defineProject): the coverage gate below is a root-level
// key, and a standalone `vitest run --coverage` invocation reads it.
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      name: 'scripts',
      environment: 'node',
      // legacy_* files are a non-running reference corpus, excluded from
      // every gate until deletion.
      exclude: ['**/dist/**', '**/node_modules/**', '**/legacy_*'],
      coverage: {
        // Static inclusion over the real script source: the v8 provider only
        // reports files some test imported, so without `include` a
        // never-imported script passes the gate silently. With it, vitest
        // merges unimported matches into the report at 0% and the per-file
        // thresholds below fail on them. (Root-config excludes — tests,
        // *.config.*, *.d.ts, index.ts — still apply.)
        include: ['*.ts', 'lib/**/*.ts', 'readme/**/*.ts'],
        // legacy reference corpus — excluded from every gate until deletion.
        exclude: ['**/legacy_*'],
        // `perFile` is load-bearing: glob thresholds otherwise compare the
        // AGGREGATE of matching files, so a small 0% file drowns in thousands
        // of covered lines. Per-file checking plus the static `include` makes
        // a never-imported or under-tested file actually fail the gate instead
        // of escaping the report.
        thresholds: {
          perFile: true,
          '*.ts': COVERAGE_GATE,
          'lib/**/*.ts': COVERAGE_GATE,
          'readme/**/*.ts': COVERAGE_GATE,
        },
      },
    },
  })
);
