import { createJobDispatcherClass } from '@hushbox/realtime';
import { createJobDispatcherBindings } from '../lib/jobs/index.js';
import { createDispatcherJobRegistry, openDispatcherDbFromEnv } from './dispatcher-job-registry.js';
import type { Bindings } from '../lib/context/app-env.js';

/**
 * The bound JobDispatcher class behind the wrangler DO binding (JOB_DISPATCHER),
 * one instance per shard (`default` | `bulk`, addressed via `idFromName`).
 *
 * Composition only — this module imports `cloudflare:workers` transitively (via
 * `@hushbox/realtime`) and therefore cannot load in the node-environment test
 * project; it is coverage-excluded. Its registry is composed here, in an adapter
 * (which may import a slice barrel), rather than in `lib/jobs` (which may not) —
 * so the running dispatcher resolves `payment.verify.v1` to its handler instead
 * of dead-lettering it as an unregistered type. Everything testable lives in
 * `dispatcher-job-registry.ts`, the `lib/jobs` core modules, and
 * `@hushbox/realtime`'s plain dispatcher core.
 */
export const JobDispatcher = createJobDispatcherClass<Bindings>((env) =>
  createJobDispatcherBindings(env, createDispatcherJobRegistry(env, openDispatcherDbFromEnv(env)))
);
