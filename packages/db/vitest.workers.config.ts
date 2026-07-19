import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Per the redesign's test-placement rules this project exists only for
// platform behavior (here: the DO-finalize validation), runs single-worker
// without isolation, and carries no coverage — all logic lives in plain
// modules covered by the node-environment project.
//
// Deliberately not merged with the shared vitest config: its setupFiles run
// node-only code (ensure-stack heartbeat) that cannot execute under workerd.

// DATABASE_URL is the local neon-proxy locally. In CI it should point at a
// managed Neon branch, not the local proxy (audit DBI-8): the settlement
// validation exercises the deferred zero-sum trigger and driver/connection
// semantics under workerd, which the managed engine reflects most faithfully.
// CI-against-managed-Neon is founder-verified; nothing here forces the target.
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('vitest.workers.config: DATABASE_URL is required (run via scripts/with-env.ts)');
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/workers-validation/test-worker.ts',
      miniflare: {
        compatibilityDate: '2026-03-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: { DB_TXN_RUNNER: 'DbTxnRunnerDO' },
        bindings: { DATABASE_URL: databaseUrl },
      },
    }),
  ],
  test: {
    name: 'db-workers',
    include: ['src/workers-validation/**/*.workers.test.ts'],
    testTimeout: 15000,
    isolate: false,
    fileParallelism: false,
  },
});
