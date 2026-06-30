import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Per the redesign's test-placement rules this project exists only for
// platform behavior (hibernatable-WS round-trips, the deadline alarm,
// eviction through a real DO), runs single-worker without isolation, and
// carries no coverage — all logic lives in the plain modules the
// node-environment project covers.
//
// Deliberately not merged with the shared vitest config: its setupFiles run
// node-only code (ensure-stack heartbeat) that cannot execute under workerd.

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/workers-validation/test-worker.ts',
      miniflare: {
        compatibilityDate: '2026-03-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          CONVERSATION_ROOM: 'TestConversationRoom',
          JOB_DISPATCHER: 'TestJobDispatcher',
        },
      },
    }),
  ],
  test: {
    name: 'realtime-workers',
    include: ['src/workers-validation/**/*.workers.test.ts'],
    testTimeout: 15000,
    isolate: false,
    fileParallelism: false,
  },
});
