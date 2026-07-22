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

// Coverage is scoped to `src/engine/**` — the module a later task fills with the
// crawler engine. The Vite/React shell created now carries no logic and is
// deliberately outside the coverage universe. defineConfig (not defineProject)
// so the `coverage` keys are honored; `perFile` fails any engine file that
// slips below the gate.
const merged: ViteUserConfig = mergeConfig(
  rootConfig,
  defineConfig({
    plugins: [react()],
    test: {
      name: 'crawler-view',
      environment: BROWSER_TEST_ENVIRONMENT,
      globals: true,
      setupFiles: ['./src/test-setup.ts'],
      coverage: {
        include: ['src/engine/**/*.ts'],
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

export default merged;
