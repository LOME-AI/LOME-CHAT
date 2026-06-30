import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { createConsoleTelemetry } from '../telemetry/index.js';
import { createJobExecutor } from './pass.js';
import { createJobRegistry } from './registry.js';
import type { Database } from '@hushbox/db';
import type { DispatcherTelemetry, JobDispatcherBindings } from '@hushbox/realtime';
import type { Bindings } from '../context/app-env.js';
import type { Telemetry } from '../telemetry/index.js';
import type { JobRegistry } from './registry.js';

/**
 * The worker-side dependency set for the JobDispatcher DO. Everything here
 * is plain and node-testable; the composition module (dispatcher-binding.ts)
 * is the only file that touches the platform class factory.
 */

/**
 * Wall budget for one pass's drain chaining — far inside the platform's
 * 15-minute alarm cap so a busy shard re-fires instead of hitting the wall.
 */
export const JOB_DISPATCHER_PASS_BUDGET_MS = 60_000;

/** The product registry: job types register here as their owning slices land. */
export function createAppJobRegistry(): JobRegistry {
  return createJobRegistry();
}

/** Maps the dispatcher's closed telemetry event set onto the typed port. */
export function createDispatcherTelemetry(telemetry: Telemetry): DispatcherTelemetry {
  return {
    passFailed: ({ shard }) => {
      telemetry.error('job dispatcher pass failed');
      // The shard name is infrastructure vocabulary (default|bulk), never
      // content — safe inside the captured error's message.
      telemetry.captureError(
        new Error(`job dispatcher pass failed on shard ${shard}`),
        'job_pass_failed'
      );
    },
  };
}

export function openDispatcherDb(
  databaseUrl: string,
  envUtilities: { readonly isDev: boolean }
): Database {
  return envUtilities.isDev
    ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })
    : createDb(databaseUrl);
}

export function createJobDispatcherBindings(
  env: Bindings,
  registry: JobRegistry
): JobDispatcherBindings {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'JobDispatcher: missing required binding DATABASE_URL. ' +
        'Set it in wrangler config / .dev.vars — the dispatcher fails fast instead of degrading.'
    );
  }
  const envUtilities = createEnvUtilities(env);
  const telemetry = createConsoleTelemetry();
  const executor = createJobExecutor({
    // Fresh Neon connection per invocation; closed when the pass ends so an
    // idle dispatcher holds no sockets across its decaying alarms.
    withDb: async <T>(use: (db: Database) => Promise<T>): Promise<T> => {
      const db = openDispatcherDb(databaseUrl, envUtilities);
      try {
        return await use(db);
      } finally {
        await db.$client.end();
      }
    },
    registry,
    telemetry,
    claimantId: crypto.randomUUID(),
    random: Math.random,
    now: () => Date.now(),
    passBudgetMs: JOB_DISPATCHER_PASS_BUDGET_MS,
  });
  return {
    executor,
    telemetry: createDispatcherTelemetry(telemetry),
    now: () => Date.now(),
  };
}
