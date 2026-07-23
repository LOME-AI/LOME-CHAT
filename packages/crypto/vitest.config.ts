import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

// This file runs in its own `crypto-noopt` project with the SSR dep optimizer
// disabled. It uses `vi.importActual('otplib')` on an external ESM dep; the
// optimizer rewrites that import through a malformed `&v=` cache URL that fails
// to resolve, so it fails even on a fresh cache. The optimizer stays on for
// every other crypto test. Referenced by both the `crypto-noopt` include and
// the `crypto` exclude so the path lives once and the file executes exactly once.
const OPTIMIZER_OFF_FILES = ['src/totp.test.ts'];

export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      // Both projects extend this file's resolved root config (rootConfig
      // merged with the test options here), so retry/timeout/setupFiles and
      // the root exclude list apply to each.
      projects: [
        {
          extends: true,
          test: {
            name: 'crypto',
            environment: 'node',
            testTimeout: 30_000,
            // OPTIMIZER_OFF_FILES run under `crypto-noopt` — exclude them here
            // so they don't double-run.
            exclude: ['**/dist/**', '**/node_modules/**', ...OPTIMIZER_OFF_FILES],
          },
        },
        {
          // See OPTIMIZER_OFF_FILES above: this runs with the SSR dep optimizer
          // disabled so its `vi.importActual` of an external ESM dep resolves
          // normally instead of through the optimizer's malformed cache URL.
          extends: true,
          test: {
            name: 'crypto-noopt',
            environment: 'node',
            testTimeout: 30_000,
            include: OPTIMIZER_OFF_FILES,
            deps: { optimizer: { ssr: { enabled: false } } },
          },
        },
      ],
    },
  })
);
