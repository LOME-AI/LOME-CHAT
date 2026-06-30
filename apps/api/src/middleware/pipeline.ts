import { pipelineEnv } from './pipeline-env.js';
import { pipelineBindings } from './pipeline-bindings.js';
import { pipelineSession } from './pipeline-session.js';
import { pipelineAuthorize } from './pipeline-authorize.js';
import { markPipelineHandler } from './pipeline-markers.js';
import { idempotencyKeyStage } from '../lib/idempotency/index.js';
import type { PipelineSessionOptions } from './pipeline-session.js';
import type { AppEnv } from '../lib/context/index.js';
import type { Hono, Schema } from 'hono';

export interface PipelineOptions {
  /**
   * Session-stage composition (the injected revocation check). The
   * composition root passes the identity slice's implementation here;
   * omitting it leaves principal resolution purely cookie-derived.
   */
  readonly session?: PipelineSessionOptions;
}

/**
 * The one per-request chain, applied by the app assembly to EVERYTHING mounted under
 * it. The order is load-bearing:
 *
 * 1. `pipelineEnv` — envUtils first, because every later stage branches on
 *    mode (dev DB config, cookie security flags, dev-only routes) and
 *    CODE-RULES allows env detection only through envUtils.
 * 2. `pipelineBindings` — fail-fast binding validation + per-request DI
 *    (bindings, db, redis, logger). Runs before any auth logic so a
 *    misconfigured deployment dies with a named-binding defect instead of a
 *    mid-auth crash, and so the session stage reads the VALIDATED secret.
 * 3. `pipelineSession` — principal resolution from the session cookie; needs
 *    the validated secret (2) and the production flag (1).
 * 4. `pipelineAuthorize` — default-deny route-class enforcement; needs the
 *    principal (3) and must be the last authorization gate before any handler.
 * 5. `idempotencyKeyStage` — Idempotency-Key enforcement on mutating routes;
 *    runs after authorization (4) so an unauthorized request is denied (403)
 *    before any missing-key error (400) reveals a route's mutation contract.
 *
 * Each stage asserts its prerequisites, so a mis-ordered composition fails
 * loudly on the first request rather than silently skipping a gate.
 */
export function applyPipeline<S extends Schema, P extends string>(
  app: Hono<AppEnv, S, P>,
  options?: PipelineOptions
): Hono<AppEnv, S, P> {
  app.use('*', pipelineEnv());
  app.use('*', pipelineBindings());
  app.use('*', pipelineSession(options?.session));
  app.use('*', pipelineAuthorize());
  // Marked pipeline-owned here (the lib module may not import middleware):
  // unmarked, the authorizer would count this wildcard as a matched
  // undeclared handler and default-deny unknown paths instead of 404ing.
  app.use('*', markPipelineHandler(idempotencyKeyStage()));
  return app;
}
