import { defineConfig, mergeConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import rootConfig, { BROWSER_TEST_ENVIRONMENT } from '@hushbox/config/vitest';

const COVERAGE_GATE = {
  lines: 95,
  branches: 95,
  functions: 95,
  statements: 95,
};

// defineConfig (not defineProject) so the `coverage` keys below are honored:
// `vitest run --coverage` reads root-level `test.coverage`, which defineProject
// strips. Env/alias/setup from the previous defineProject shape are preserved.
export default mergeConfig(
  rootConfig,
  defineConfig({
    plugins: [react()],
    test: {
      name: 'web',
      environment: BROWSER_TEST_ENVIRONMENT,
      globals: true,
      setupFiles: ['./src/test-setup.ts'],
      coverage: {
        // Static inclusion over the real product-source globs. The v8 provider
        // only reports files a test imported, so without `include` a
        // never-imported file passes the gate silently. With it, vitest merges
        // unimported matches into the report at 0%, and `perFile` below fails
        // them. (Root-config excludes still apply: tests, `**/index.ts`
        // barrels, `*.config.*`, `*.d.ts`, mocks, fixtures.)
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: [
          // Generated router tree — not authored code.
          '**/*.gen.ts',
          // Test-only scaffolding: helpers imported solely by tests.
          'src/test-utils/**',
          'src/test-setup.ts',
        ],
        // `perFile` is load-bearing: without it a small 0% file drowns among
        // thousands of covered lines in the aggregate. Per-file checking plus
        // static `include` makes a never-imported file fail the gate instead of
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
