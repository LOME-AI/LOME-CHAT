import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

const COVERAGE_GATE = {
  lines: 95,
  branches: 95,
  functions: 95,
  statements: 95,
};

// defineConfig (not defineProject): the coverage gate below is a root-level key
// that a standalone `vitest run --coverage` invocation reads. Mirrors
// scripts/vitest.config.ts — a Node package, no browser DOM.
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      name: 'sandbox',
      environment: 'node',
      exclude: ['**/dist/**', '**/node_modules/**'],
      // This package imports none of the heavy internal packages the shared
      // config pre-bundles (@hushbox/db/shared/crypto), so leaving the SSR
      // optimizer on only emits "Failed to resolve dependency" warnings for
      // deps it does not have. Disabling keeps test output pristine.
      deps: { optimizer: { ssr: { enabled: false } } },
      coverage: {
        // Static inclusion over the real source: the v8 provider only reports
        // files a test imported, so without `include` a never-imported module
        // passes the gate silently. With it, vitest merges unimported matches
        // into the report at 0% and the per-file thresholds fail on them.
        // `serve.ts` is the process bootstrap (listens on a socket) — excluded
        // like an entry point; its pure helpers live in dev-server.ts. The
        // `build.ts` CLI main is v8-ignored in-file; its logic (buildSandbox)
        // stays covered. `render/bootstrap.ts` and `python/bootstrap.ts` are the
        // browser renderer/runtime entries — they only run inside a real frame
        // (never imported in Node), so v8 reports them at 0%; they are exercised
        // by the browser integration tests and their pure logic lives in the
        // covered render/*.ts and python/*.ts helpers. `embed-harness.ts` (the
        // origin server plus the sandboxed embedding) and
        // `python/browser-harness.ts` (the Python-specific driver over it) are
        // the integration-test harnesses — test infrastructure, not shipped
        // runtime, excluded like an entry point.
        include: ['src/**/*.ts'],
        exclude: [
          'src/serve.ts',
          'src/embed-harness.ts',
          'src/render/bootstrap.ts',
          'src/python/bootstrap.ts',
          'src/python/browser-harness.ts',
        ],
        thresholds: {
          perFile: true,
          ...COVERAGE_GATE,
        },
      },
    },
  })
);
