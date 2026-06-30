/// <reference types="@cloudflare/workers-types" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { DbTxnRunnerDO } from './test-worker';

/**
 * Types the bindings the workers project injects (vitest.workers.config.ts).
 * `env` from 'cloudflare:workers' is typed as Cloudflare.Env, which merges
 * with this declaration.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      DATABASE_URL: string;
      DB_TXN_RUNNER: DurableObjectNamespace<DbTxnRunnerDO>;
    }
  }
}
