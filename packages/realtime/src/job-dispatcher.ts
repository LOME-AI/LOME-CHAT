// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- The Cloudflare Workers ambient runtime (the `cloudflare:workers` module + DO globals) has no importable module form; the published `@cloudflare/workers-types` is a global script whose DOM redefinitions break a browser-DOM consumer (apps/web type-checks this source through the typed API client). A path reference to a minimal local ambient shim is the only mechanism that carries the runtime into that consumer's program without polluting its DOM lib.
/// <reference path="./cloudflare-workers.d.ts" />
import { DurableObject } from 'cloudflare:workers';
import { ERROR_CODES } from '@hushbox/shared';
import { JobDispatcherCore } from './job-dispatcher-core.js';
import type { DispatcherTelemetry, JobPassExecutor } from './job-dispatcher-core.js';

/**
 * The composition seam: the worker binds the pass executor (claim/execute/
 * complete against Postgres), telemetry, and the clock — packages never
 * import apps. The factory closes the DO class over these bindings; the
 * worker entry re-exports the bound class for the wrangler DO binding.
 */
export interface JobDispatcherBindings {
  readonly executor: JobPassExecutor;
  readonly telemetry: DispatcherTelemetry;
  readonly now: () => number;
}

export type JobDispatcherClass<Env> = new (ctx: DurableObjectState, env: Env) => DurableObject<Env>;

/**
 * Thin-shell Durable Object (the arch pattern: a DO class contains only
 * platform glue). One instance per shard, stateless except its alarm; every
 * behavior — arm-first, idle decay, the wake-overwrite race — lives in the
 * plain JobDispatcherCore the node project covers.
 */
export function createJobDispatcherClass<Env>(
  createBindings: (env: Env) => JobDispatcherBindings
): JobDispatcherClass<Env> {
  return class JobDispatcher extends DurableObject<Env> {
    private readonly core: JobDispatcherCore;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      const shard = ctx.id.name;
      if (shard === undefined) {
        throw new Error('JobDispatcher requires a named id — reach it via idFromName(shard)');
      }
      const bindings = createBindings(env);
      this.core = new JobDispatcherCore({
        shard,
        executor: bindings.executor,
        telemetry: bindings.telemetry,
        now: bindings.now,
        scheduler: {
          getAlarm: () => this.ctx.storage.getAlarm(),
          setAlarm: async (at) => {
            await this.ctx.storage.setAlarm(at);
          },
        },
      });
    }

    override async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/wake') {
        await this.core.wake();
        return Response.json({ woken: true });
      }
      return Response.json({ code: ERROR_CODES.NOT_FOUND }, { status: 404 });
    }

    async alarm(): Promise<void> {
      await this.core.onAlarm();
    }
  };
}
