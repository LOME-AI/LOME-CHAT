import { createApp } from './app.js';
import { installProductionConsolePatch } from './lib/telemetry/index.js';
import { scheduledHandler } from './scheduled.js';
import type { Bindings } from './lib/context/index.js';

/** The Worker handler shape the runtime invokes (`src/index.ts` default-exports it). */
export interface WorkerEntry {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled(): Promise<void>;
}

export interface WorkerEntryDeps {
  readonly app: {
    fetch(request: Request, env: Bindings, ctx: ExecutionContext): Response | Promise<Response>;
  };
  readonly scheduled: () => Promise<void>;
  readonly installConsolePatch: (env: Bindings) => void;
}

export function createWorkerEntry(deps: WorkerEntryDeps): WorkerEntry {
  return {
    fetch(request: Request, env: Bindings, ctx: ExecutionContext): Response | Promise<Response> {
      // Idempotent and production-gated; installed here because env (and thus
      // mode detection) only exists per-invocation on Workers, not at module
      // evaluation.
      deps.installConsolePatch(env);
      return deps.app.fetch(request, env, ctx);
    },
    scheduled: deps.scheduled,
  };
}

/** The composed production entry; `src/index.ts` re-exports it as the default. */
export const worker = createWorkerEntry({
  app: createApp(),
  scheduled: scheduledHandler,
  installConsolePatch: installProductionConsolePatch,
});
