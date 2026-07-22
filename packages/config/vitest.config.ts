import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Single source of truth for the DOM-emulator choice — packages that need a
// browser-like environment import this instead of hardcoding the string, so
// a future swap (or a typo) can't drift between packages.
export const BROWSER_TEST_ENVIRONMENT = 'happy-dom';

// Coverage roughly doubles each fork's heap. In isolation, a single package's
// coverage run is no faster or safer capped at 50% workers than left at
// Vitest's own default (`cpus - 1`) — tested directly, same wall time, same
// memory range. The cap's real, measured value only shows up in the full
// monorepo `pnpm test`: turbo runs multiple packages' coverage concurrently,
// each spawning its own fork pool, and with every package left uncapped the
// *aggregate* fork count across packages oversubscribes the box — peak swap
// during a full run nearly doubled (2.9GB capped vs 5.6GB uncapped) versus no
// change in wall time. Gated on `--coverage` because coverage is the
// memory-heavy case; plain `test`/`test:watch` runs don't need it.
const coverageWorkerCap = process.argv.includes('--coverage') ? { maxWorkers: '50%' } : {};

export default defineConfig({
  test: {
    ...coverageWorkerCap,
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
    // Pre-bundle the heavy internal packages once per worker instead of walking
    // their full module trees per test file. Linked workspace packages are not
    // pre-bundled by default, so they must be named explicitly. Node/SSR test
    // files (the api integration suite) are the beneficiaries; browser-env
    // packages are unaffected.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ['@hushbox/db', '@hushbox/shared', '@hushbox/crypto'],
        },
      },
    },
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
