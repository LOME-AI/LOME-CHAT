import { createConsoleTelemetry } from '../../../lib/telemetry/index.js';
import type { FlowExecutor } from '@hushbox/shared';
import type { MembershipVerifier, RoomBindings, RoomTelemetry } from '@hushbox/realtime';
import type { Telemetry } from '../../../lib/telemetry/index.js';

/**
 * The worker-side dependency set for the ConversationRoom DO. Two of the
 * room's dependencies belong to slices that have not landed yet, so they are
 * bound to fail-fast placeholders: an exception names the missing owner
 * instead of degrading. The room is not reachable from any live route until
 * those slices bind the real implementations.
 *
 * - executor / hook binder → the workflows engine (in-process interpreter)
 * - membership verifier → the conversations slice composes
 *   `createCachedMembershipVerifier` from `@hushbox/realtime` with its Redis
 *   cache and DB source
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

export function createUnboundVerifier(): MembershipVerifier {
  return {
    verify: () => {
      throw new Error(
        'ConversationRoom membership verifier is not bound — the conversations slice composes the Redis cache and DB source'
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

export function createRoomBindings(): RoomBindings {
  return {
    executor: createUnboundExecutor(),
    verifier: createUnboundVerifier(),
    telemetry: createRoomTelemetry(createConsoleTelemetry()),
    bindHooks: createUnboundHookBinder(),
    maxStreamBytes: REALTIME_MAX_STREAM_BYTES,
    now: () => Date.now(),
    newRunId: () => crypto.randomUUID(),
  };
}
