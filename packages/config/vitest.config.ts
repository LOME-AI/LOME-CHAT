import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export default defineConfig({
  test: {
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
      reporter: ['text', 'json', 'html'],
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
