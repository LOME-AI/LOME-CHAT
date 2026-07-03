import { Redis } from '@upstash/redis';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { createConsoleTelemetry } from '../../../lib/telemetry/index.js';
import { createDbMembershipSource, createRedisMembershipCache } from './membership.js';
import { composeMembershipVerifier } from './membership-verifier.js';
import type { Database } from '@hushbox/db';
import type { EnvUtilities, FlowExecutor } from '@hushbox/shared';
import type { MembershipSource, RoomBindings, RoomTelemetry } from '@hushbox/realtime';
import type { Bindings } from '../../../lib/context/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';

/**
 * The worker-side dependency set for the ConversationRoom DO. The membership
 * verifier is composed here for real (Redis cache + authoritative DB source
 * — window constants and their rationale live in membership.ts); the
 * executor and hook binder belong to the workflows engine, which has not
 * landed yet, so they stay bound to fail-fast placeholders: an exception
 * names the missing owner instead of degrading.
 */

/**
 * Per-stream replay budget. Sized for text turns (a 5-minute text stream is
 * tens of KB; 2 MiB is generous headroom) while bounding DO memory — replay
 * overflow answers the explicit stream-gone signal and the client falls back
 * to fetch-after-settlement.
 */
export const REALTIME_MAX_STREAM_BYTES = 2_097_152;

/** Maps the room's closed telemetry event set onto the typed Telemetry port. */
export function createRoomTelemetry(telemetry: Telemetry): RoomTelemetry {
  return {
    runStarted: (fields) => {
      telemetry.info('realtime run started', fields);
    },
    runFinished: (fields) => {
      telemetry.info('realtime run finished', fields);
    },
    runRejected: (fields) => {
      telemetry.warn('realtime run rejected', fields);
    },
    deadlineFired: (fields) => {
      telemetry.warn('realtime run deadline fired', fields);
    },
    principalEvicted: (fields) => {
      telemetry.warn('realtime principal evicted at broadcast', fields);
    },
    deliveryPaused: (fields) => {
      telemetry.warn('realtime delivery paused', fields);
    },
    clientMessageRejected: (fields) => {
      telemetry.warn('realtime client message rejected', fields);
    },
  };
}

export function createUnboundExecutor(): FlowExecutor {
  return {
    start: () => {
      throw new Error(
        'ConversationRoom flow executor is not bound — the in-process interpreter ships with the workflows engine'
      );
    },
  };
}

function throwUnboundHooks(): never {
  throw new Error(
    'ConversationRoom hook binder is not bound — policy hooks resolve with the workflows engine'
  );
}

export function createUnboundHookBinder(): RoomBindings['bindHooks'] {
  return throwUnboundHooks;
}

/** Fail-fast on the DO's own required bindings (dispatcher-bindings precedent). */
function requiredRoomBinding(env: Bindings, name: keyof Bindings): string {
  const value = env[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `ConversationRoom: missing required binding ${name}. ` +
        'Set it in wrangler config / .dev.vars — the room fails fast instead of degrading.'
    );
  }
  return value;
}

/** Local dev routes through the Neon proxy; production connects directly. */
export function openRoomSourceDb(
  databaseUrl: string,
  envUtilities: Pick<EnvUtilities, 'isDev'>
): Database {
  return envUtilities.isDev
    ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })
    : createDb(databaseUrl);
}

/**
 * Authoritative membership over a fresh Neon connection per check, closed
 * when the read ends — a hibernating room must hold no idle sockets across
 * its lifetime, and the verifier only reaches this source on a cache miss.
 */
function createRoomMembershipSource(
  databaseUrl: string,
  envUtilities: EnvUtilities
): MembershipSource {
  return {
    isMember: async (conversationId: string, principalId: string): Promise<boolean> => {
      const db = openRoomSourceDb(databaseUrl, envUtilities);
      try {
        return await createDbMembershipSource(db).isMember(conversationId, principalId);
      } finally {
        await db.$client.end();
      }
    },
  };
}

export function createRoomBindings(env: Bindings): RoomBindings {
  const databaseUrl = requiredRoomBinding(env, 'DATABASE_URL');
  const redisUrl = requiredRoomBinding(env, 'UPSTASH_REDIS_REST_URL');
  const redisToken = requiredRoomBinding(env, 'UPSTASH_REDIS_REST_TOKEN');
  const envUtilities = createEnvUtilities(env);
  const redis = new Redis({ url: redisUrl, token: redisToken });
  return {
    executor: createUnboundExecutor(),
    verifier: composeMembershipVerifier({
      cache: createRedisMembershipCache(redis),
      source: createRoomMembershipSource(databaseUrl, envUtilities),
    }),
    telemetry: createRoomTelemetry(createConsoleTelemetry()),
    bindHooks: createUnboundHookBinder(),
    maxStreamBytes: REALTIME_MAX_STREAM_BYTES,
    now: () => Date.now(),
    newRunId: () => crypto.randomUUID(),
  };
}
