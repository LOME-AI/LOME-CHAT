import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { EnvContext, EnvUtilities } from '@hushbox/shared';
import type { Telemetry } from '../telemetry/index.js';
import type { Principal } from './principal.js';

/**
 * Worker bindings the app reads. All request-critical bindings are typed
 * optional because the runtime cannot guarantee them — `assertRequiredBindings`
 * is the single place that narrows them, failing fast per request. Extends
 * `EnvContext` so `createEnvUtilities(c.env)` is the only env-detection path.
 */
export interface Bindings extends EnvContext {
  DATABASE_URL?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  IRON_SESSION_SECRET?: string;
  // OPAQUE server master secret. Consumed only by the identity slice, which
  // owns its own per-request fail-fast — deliberately NOT in
  // `assertRequiredBindings`, so surfaces that never touch OPAQUE (and their
  // test environments) don't have to carry it.
  OPAQUE_MASTER_SECRET?: string;
  // OpenRouter inference key. Consumed only by the chat conversation runtime
  // (the DO's model provider), which owns its own fail-fast — deliberately NOT
  // in `assertRequiredBindings`, so surfaces that never run inference (and
  // their test environments) don't have to carry it.
  OPENROUTER_API_KEY?: string;
  // Telemetry composition vars. TELEMETRY_SINKS is the per-mode sink registry
  // value (every mode declares one; `createRequestTelemetry` fails fast when
  // it is missing); SENTRY_DSN is required only when that list names the
  // sentry sink. Neither is gated by `assertRequiredBindings` — the telemetry
  // composition owns its own fail-fast.
  TELEMETRY_SINKS?: string;
  SENTRY_DSN?: string;
  // Workers Analytics Engine metrics sink (the WAE telemetry adapter).
  // Telemetry is best-effort by doctrine, so unlike the secrets above this
  // binding is optional forever — absence degrades metrics, never a request —
  // and `assertRequiredBindings` must not gate on it.
  WAE_METRICS?: AnalyticsEngineDataset;
}

/** The required subset after the fail-fast gate has run. */
export interface RequiredBindings {
  readonly DATABASE_URL: string;
  readonly UPSTASH_REDIS_REST_URL: string;
  readonly UPSTASH_REDIS_REST_TOKEN: string;
  readonly IRON_SESSION_SECRET: string;
}

/**
 * Per-request DI surface. Populated by the pipeline middleware in order
 * (env → bindings → session → authorize); handlers and slice code consume
 * these and never touch raw `c.env`.
 */
export interface Variables {
  envUtils: EnvUtilities;
  bindings: RequiredBindings;
  db: Database;
  redis: Redis;
  // The typed SafeLogFields port (compile-time-literal messages, allowlisted
  // fields) — routes and slices type against this, never a permissive logger.
  logger: Telemetry;
  principal: Principal;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: Variables;
}
