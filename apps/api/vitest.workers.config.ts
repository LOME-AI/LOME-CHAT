import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// A second project that exists only to pin runtime behavior the node-environment
// project cannot observe: node ships full-ICU, workerd does not, so anything the
// Worker relies on from the platform's own Intl/locale data has to be asserted
// inside workerd or it is not asserted at all. Carries no coverage — every
// module it touches is covered by the node project.
//
// Deliberately not merged with the shared vitest config: its setupFiles run
// node-only code (the ensure-stack heartbeat) that cannot execute under workerd.
//
// The compatibility date and flags mirror wrangler.toml so a production runtime
// change shows up here as a failure rather than in delivered notifications.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-03-01',
        compatibilityFlags: ['nodejs_compat', 'web_socket_auto_reply_to_close'],
      },
    }),
  ],
  test: {
    name: 'api-workers',
    include: ['src/**/*.workers.test.ts'],
  },
});
