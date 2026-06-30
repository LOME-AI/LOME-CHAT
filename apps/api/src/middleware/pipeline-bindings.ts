import {
  assertRequiredBindings,
  createRequestDb,
  createRequestRedis,
} from '../lib/context/index.js';
import { createRequestTelemetry } from '../lib/telemetry/index.js';
import { markPipelineHandler, readPipelineVariable } from './pipeline-markers.js';
import type { AppEnv } from '../lib/context/index.js';
import type { MiddlewareHandler } from 'hono';

/**
 * Pipeline stage 2: fail-fast binding validation + per-request DI. Every
 * binding the pipeline needs is asserted here in one place; downstream stages
 * and handlers consume the validated `c.var` surface (bindings, db, redis,
 * logger) and never touch raw `c.env`. Construction is per-request via
 * factories — no module-level singletons (serverless mindset).
 */
export function pipelineBindings(): MiddlewareHandler<AppEnv> {
  return markPipelineHandler(async (c, next) => {
    // The envUtils type assumes the env stage ran; verify it, because the
    // session stage trusts this stage the same way and the chain is
    // load-bearing.
    const envUtilities = readPipelineVariable(c, 'envUtils');
    if (envUtilities === undefined) {
      throw new Error('pipeline order violated: pipelineBindings requires pipelineEnv first.');
    }
    const bindings = assertRequiredBindings(c.env);
    c.set('bindings', bindings);
    c.set('db', createRequestDb(bindings, envUtilities));
    c.set('redis', createRequestRedis(bindings));
    // Which sinks compose is the TELEMETRY_SINKS registry value (per-mode,
    // fail-fast), never a mode branch here. The flush scheduler is a thunk:
    // `c.executionCtx` THROWS where no ExecutionContext exists (vitest's
    // app.request), so it must be read at capture time — inside the Sentry
    // adapter's containment — not eagerly at composition.
    c.set(
      'logger',
      createRequestTelemetry(c.env, {
        scheduleFlush: (task) => {
          c.executionCtx.waitUntil(task);
        },
      })
    );
    await next();
  });
}
