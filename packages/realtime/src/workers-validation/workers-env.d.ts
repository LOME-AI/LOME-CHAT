/// <reference types="@cloudflare/workers-types" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { TestConversationRoom, TestJobDispatcher } from './test-worker';

/**
 * Types the bindings the workers project injects (vitest.workers.config.ts).
 * `env` from 'cloudflare:test' is typed as Cloudflare.Env, which merges with
 * this declaration.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      CONVERSATION_ROOM: DurableObjectNamespace<TestConversationRoom>;
      JOB_DISPATCHER: DurableObjectNamespace<TestJobDispatcher>;
    }
  }
}
