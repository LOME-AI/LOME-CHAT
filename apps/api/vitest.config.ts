import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

const COVERAGE_GATE = {
  lines: 95,
  branches: 95,
  functions: 95,
  statements: 95,
};

// These two files run in their own `api-noopt` project with the SSR dep
// optimizer disabled. They use `vi.importActual` / factory-`importOriginal`
// on external ESM deps; the optimizer rewrites those imports through a
// malformed `&v=` cache URL that fails to resolve, so they fail even on a
// fresh cache. The optimizer stays on for every other api test. Referenced by
// both the `api-noopt` include and the `api` exclude so the paths live once
// and the files execute exactly once.
const OPTIMIZER_OFF_FILES = [
  'src/lib/resilience/policies.test.ts',
  'src/slices/models/adapters/video-adapter.test.ts',
];

export default mergeConfig(
  rootConfig,
  // defineConfig (not defineProject) because the coverage gate below is a
  // root-level key; the standalone `vitest run --coverage` invocation reads it.
  defineConfig({
    test: {
      // Both projects extend this file's resolved root config (rootConfig
      // merged with the test options here), so retry/timeout/setupFiles and
      // the root exclude list apply to each.
      projects: [
        {
          extends: true,
          test: {
            name: 'api',
            environment: 'node',
            globals: true,
            // src/smoke is the API-level smoke suite — its own project below.
            // OPTIMIZER_OFF_FILES run under `api-noopt` — exclude them here so
            // they don't double-run.
            exclude: [
              '**/dist/**',
              '**/node_modules/**',
              '**/src/smoke/**',
              ...OPTIMIZER_OFF_FILES,
            ],
          },
        },
        {
          // Per-slice API smoke specs: the fully-assembled app exercised
          // through the typed client against the real local dev stack.
          // Standalone run: `pnpm --filter @hushbox/api test --project smoke`
          // (the test script's with-env wrapper loads the bindings).
          extends: true,
          test: {
            name: 'smoke',
            environment: 'node',
            globals: true,
            include: ['src/smoke/**/*.smoke.test.ts'],
          },
        },
        {
          // See OPTIMIZER_OFF_FILES above: these run with the SSR dep optimizer
          // disabled so their `vi.importActual` / factory-`importOriginal` of
          // external ESM deps resolves normally instead of through the
          // optimizer's malformed cache URL.
          extends: true,
          test: {
            name: 'api-noopt',
            environment: 'node',
            globals: true,
            include: OPTIMIZER_OFF_FILES,
            deps: { optimizer: { ssr: { enabled: false } } },
          },
        },
      ],
      coverage: {
        // Static inclusion over the gated source globs: the v8 provider only
        // reports files some test imported, so without `include` a
        // never-imported file passes the gate silently. With it, vitest merges
        // unimported matches into the report at 0% and the thresholds below
        // see them. (Root-config excludes still apply after `include`: tests,
        // `**/index.ts` barrels, configs.)
        include: [
          'src/slices/**/*.ts',
          'src/lib/**/*.ts',
          'src/middleware/**/*.ts',
          'src/platform/**/*.ts',
          'src/adapters/**/*.ts',
          'src/jobs/**/*.ts',
          'src/app.ts',
          'src/entry.ts',
          'src/scheduled.ts',
        ],
        exclude: [
          // The slice template is scaffolding, not code, and carries no gate.
          'src/slices/_template/**',
          // Composition-only DO class bindings: each imports
          // `cloudflare:workers` transitively and therefore cannot load in
          // this node-environment test project. Everything testable lives in
          // their `*-bindings.ts` neighbors and in `@hushbox/realtime`'s
          // plain modules; these two files stay one-expression compositions.
          'src/adapters/job-dispatcher.ts',
          'src/adapters/conversation-room.ts',
          // Test-only scaffolding: scratch-MinIO-bucket helpers imported solely
          // by media `*.integration.test.ts` suites (never product code), so
          // they are test infrastructure and carry no product coverage gate.
          'src/slices/media/adapters/test-fixtures.ts',
          // Test-only scaffolding: AI-integration harness imported solely by
          // `*.integration.test.ts` suites (mock provider locally, real in CI;
          // never product code), so it is test infrastructure and carries no
          // product coverage gate.
          'src/slices/models/adapters/integration-setup.ts',
        ],
        // `perFile` is load-bearing: glob thresholds otherwise compare the
        // AGGREGATE of matching files, where a small 0% file drowns among
        // thousands of covered lines. Per-file checking plus the static
        // `include` above is what makes a never-imported file actually fail
        // the gate instead of escaping the report.
        thresholds: {
          perFile: true,
          'src/slices/**/*.ts': COVERAGE_GATE,
          'src/lib/**/*.ts': COVERAGE_GATE,
          'src/middleware/**/*.ts': COVERAGE_GATE,
          'src/platform/**/*.ts': COVERAGE_GATE,
          'src/adapters/**/*.ts': COVERAGE_GATE,
          'src/jobs/**/*.ts': COVERAGE_GATE,
          'src/{app,entry,scheduled}.ts': COVERAGE_GATE,
        },
      },
    },
  })
);
