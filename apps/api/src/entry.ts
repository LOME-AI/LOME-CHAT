import { createApp } from './app.js';
import { installProductionConsolePatch } from './lib/telemetry/index.js';
import { scheduledHandler } from './scheduled.js';
import type { Bindings } from './lib/context/index.js';
import type { ScheduledBindings } from './scheduled.js';

/** The Worker handler shape the runtime invokes (`src/index.ts` default-exports it). */
export interface WorkerEntry {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled(
    controller: { cron: string },
    env: ScheduledBindings,
    ctx: ExecutionContext
  ): Promise<void>;
}

export interface WorkerEntryDeps {
  readonly app: {
    fetch(request: Request, env: Bindings, ctx: ExecutionContext): Response | Promise<Response>;
  };
  readonly scheduled: (
    controller: { cron: string },
    env: ScheduledBindings,
    ctx: ExecutionContext
  ) => Promise<void>;
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
    scheduled(controller, env, ctx): Promise<void> {
      // Same per-invocation patch as fetch: cron telemetry must ride the
      // patched console in production too.
      deps.installConsolePatch(env);
      return deps.scheduled(controller, env, ctx);
    },
  };
}

/** The composed production entry; `src/index.ts` re-exports it as the default. */
export const worker = createWorkerEntry({
  app: createApp(),
  scheduled: scheduledHandler,
  installConsolePatch: installProductionConsolePatch,
});
