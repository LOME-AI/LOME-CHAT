import { defineConfig, mergeConfig, type ViteUserConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import rootConfig, { BROWSER_TEST_ENVIRONMENT } from '@hushbox/config/vitest';

const COVERAGE_GATE = {
  lines: 95,
  branches: 95,
  functions: 95,
  statements: 95,
};

// Mirrors apps/web/vitest.config.ts: defineConfig (not defineProject) so the
// `coverage` keys are honored, static `include` + `perFile` so a never-imported
// source file fails the gate instead of escaping the report.
const merged: ViteUserConfig = mergeConfig(
  rootConfig,
  defineConfig({
    plugins: [react()],
    test: {
      name: 'admin',
      environment: BROWSER_TEST_ENVIRONMENT,
      globals: true,
      setupFiles: ['./src/test-setup.ts'],
      coverage: {
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: [
          // Generated router tree — not authored code.
          '**/*.gen.ts',
          // Test-only scaffolding: helpers imported solely by tests.
          'src/test-utils/**',
          'src/test-setup.ts',
        ],
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

// Vitest matches coverage globs with picomatch `contains: true` (no
// end-anchoring), so the shared barrel exclude `**/index.ts` also swallows
// route `index.tsx` files — silently dropping them from the coverage universe
// and the perFile gate. Rewrite that one merged entry to an extglob that
// still excludes real `index.ts` barrels but cannot match `index.tsx`. The
// shared list in packages/config is left alone: other packages consume it.
const coverage = merged.test?.coverage;
const exclude = coverage !== undefined && 'exclude' in coverage ? coverage.exclude : undefined;
if (coverage === undefined || !Array.isArray(exclude) || !exclude.includes('**/index.ts')) {
  throw new Error('expected the shared coverage exclude "**/index.ts" in the merged config');
}
coverage.exclude = exclude.map((glob) => (glob === '**/index.ts' ? '**/index.ts!(x*)' : glob));

export default merged;
