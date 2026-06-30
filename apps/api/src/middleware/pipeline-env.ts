import { createEnvUtilities } from '@hushbox/shared';
import { markPipelineHandler } from './pipeline-markers.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { MiddlewareHandler } from 'hono';

/**
 * Pipeline stage 1: environment detection. Runs before everything else
 * because every later stage branches on mode (CODE-RULES: middleware ahead of
 * the env stage calls `createEnvUtilities(c.env)` directly — this IS that
 * stage; everything after reads `c.get('envUtils')`).
 */
export function pipelineEnv(): MiddlewareHandler<AppEnv> {
  return markPipelineHandler(async (c, next) => {
    // Hono types c.env as always-present, but app.request() without an env
    // argument leaves it undefined at runtime — surface that as a clear
    // defect instead of a property read on undefined inside env detection.
    const env = c.env as Bindings | undefined;
    if (env === undefined) {
      throw new Error('pipeline: c.env is undefined — the app was invoked without bindings.');
    }
    c.set('envUtils', createEnvUtilities(env));
    await next();
  });
}
