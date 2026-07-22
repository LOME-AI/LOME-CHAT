import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Coverage is memory-hungry and, unguarded, OOM-crashes mid-run: instrumentation
// roughly doubles each fork's heap, so two levers are needed together, both gated
// on `--coverage` so plain `test` runs are untouched. First, `maxWorkers: '50%'` caps
// the fork count — at the default ~one-fork-per-core the forks over-subscribe the
// box's RAM and the OS OOM-kills workers, bounding aggregate RAM. Second,
// `execArgv: ['--max-old-space-size=8192']` raises each fork's V8 heap above the
// ~2GB default — coverage generation happens inside the fork, and a fork that
// dies mid-coverage leaves the `coverage/.tmp` merge to fail with ENOENT. These are
// top-level `test` options, not `poolOptions.forks.*` — Vitest 4 removed
// `poolOptions` and silently drops it if present, which had left this heap raise
// inert (forks ran at the ~2GB default and could still OOM-crash the coverage
// merge). This is the single global home for the heap flag (CI and local both
// inherit it via mergeConfig); there is no per-package or CI-workflow one-off.
const coverageForkCap = process.argv.includes('--coverage')
  ? {
      pool: 'forks' as const,
      maxWorkers: '50%',
      execArgv: ['--max-old-space-size=8192'],
    }
  : {};

export default defineConfig({
  test: {
    ...coverageForkCap,
    retry: 1,
    // 15s gives slow integration tests (e.g. message-shares with media
    // middleware spin-up) headroom under heavy parallel `test:all` load
    // while still catching genuine hangs. Tightening below this caused
    // sporadic timeouts that masked true-pass tests.
    testTimeout: 15000,
    // Lint-rule fixture trees contain *.test.ts files that exist to be linted,
    // not run — keep the test collector out of them (mirrors the ESLint
    // `__test-fixtures-*__` ignore convention).
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**',
      '**/__test-fixtures-*__/**',
      '**/*.workers.test.ts',
    ],
    // Ticks the ensure-stack heartbeat on every Vitest worker start so a long
    // test run isn't reaped by the idle-killer daemon mid-run. No-op when
    // HB_STACK_SLOT is unset (e.g. CI, where ensure-stack itself is a no-op).
    setupFiles: [path.join(REPO_ROOT, 'scripts/lib/vitest-setup.ts')],
    coverage: {
      provider: 'v8',
      // No 'html': threshold enforcement reads the coverage map directly,
      // independent of which reporters run, so dropping it doesn't touch the
      // gate. Nothing in CI or scripts opens the html tree (coverage/ is
      // gitignored) — it's pure per-file-render cost paid on every run for
      // an artifact nobody reads. Browse coverage on demand instead:
      // `vitest run --coverage --coverage.reporter=html`.
      reporter: ['text', 'json'],
      thresholds: {
        lines: 95,
        branches: 95,
        functions: 95,
        statements: 95,
      },
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/index.ts',
        'e2e/**',
        'mocks/**',
        '**/*.{test,spec}.?(c|m)[jt]s?(x)',
        '**/__tests__/**',
        '**/__test-fixtures-*__/**',
      ],
    },
  },
});
