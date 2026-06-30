import { createJobDispatcherClass } from '@hushbox/realtime';
import { createAppJobRegistry, createJobDispatcherBindings } from './dispatcher-bindings.js';
import type { Bindings } from '../context/app-env.js';

/**
 * The bound JobDispatcher class behind the wrangler DO binding
 * (JOB_DISPATCHER), one instance per shard (`default` | `bulk`, addressed
 * via `idFromName`). Composition only — this module imports
 * `cloudflare:workers` transitively and therefore cannot load in the
 * node-environment test project; everything testable lives in
 * dispatcher-bindings.ts, the lib/jobs core modules, and
 * `@hushbox/realtime`'s plain dispatcher core.
 */
export const JobDispatcher = createJobDispatcherClass<Bindings>((env) =>
  createJobDispatcherBindings(env, createAppJobRegistry())
);
