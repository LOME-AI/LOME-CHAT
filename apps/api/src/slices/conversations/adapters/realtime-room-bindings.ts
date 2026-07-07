import { Redis } from '@upstash/redis';
import { and, eq } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, epochs } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { isTrialRoomSelf } from '@hushbox/realtime';
import { createConsoleTelemetry } from '../../../lib/telemetry/index.js';
import { createDbMembershipSource, createRedisMembershipCache } from './membership.js';
import { composeMembershipVerifier } from './membership-verifier.js';
import type { Database } from '@hushbox/db';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type {
  ClaimRun,
  EnvUtilities,
  FlowExecutor,
  FlowHookBindings,
  RunContext,
  WorkflowDefinition,
} from '@hushbox/shared';
import type {
  MembershipSource,
  MembershipVerifier,
  RoomBindings,
  RoomTelemetry,
} from '@hushbox/realtime';
import type { Bindings } from '../../../lib/context/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';

/**
 * The worker-side dependency set for the ConversationRoom DO. This adapter is
 * an infra edge: it composes the membership verifier (Redis cache +
 * authoritative DB source — rationale in membership.ts), opens the DO's
 * connections, and supplies the `epochs` read the settlement wraps to. The DO
 * RUNTIME (executor + policy-hook binder + run referee) needs the
 * workflows/models/billing barrels, which the architecture permits only in a
 * domain layer, so it is INJECTED here as `createRuntime` — the chat slice's
 * conversation-runtime factory, wired by the app root (`createConversationRoom`
 * in src/index.ts, a later assembly task). The adapter therefore imports no
 * chat/workflows/billing barrel and boundaries hold with no rule relaxation.
 */

/**
 * Per-stream replay budget. Sized for text turns (a 5-minute text stream is
 * tens of KB; 2 MiB is generous headroom) while bounding DO memory — replay
 * overflow answers the explicit stream-gone signal and the client falls back
 * to fetch-after-settlement.
 */
export const REALTIME_MAX_STREAM_BYTES = 2_097_152;

/** The `epochs` read the injected runtime's settlement hook wraps content to. */
export type RoomEpochPublicKeyReader = (
  tx: DbWriter,
  conversationId: string,
  epochNumber: number
) => Promise<Uint8Array | null>;

/**
 * The DO runtime the room binds. Structurally the chat slice's
 * `ConversationRuntime`; typed here from shared primitives only, so the
 * adapter never imports the chat barrel.
 */
export interface RoomRuntime {
  readonly executor: FlowExecutor;
  readonly bindHooks: (context: RunContext, definition: WorkflowDefinition) => FlowHookBindings;
  readonly claimRun: ClaimRun;
}

/** Infra the adapter builds and hands the injected runtime factory. */
export interface RoomRuntimeDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly telemetry: Telemetry;
  readonly env: Bindings;
  readonly readEpochPublicKey: RoomEpochPublicKeyReader;
}

export type CreateRoomRuntime = (deps: RoomRuntimeDeps) => RoomRuntime;

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
    // WAE metrics (not logs): each names its watcher on the RoomTelemetry port.
    // The upgrade-failure metric feeds the WAE-metrics auditor's measure of the
    // WS-upgrade-blocked population; the per-generation metric feeds the
    // OpenRouter-usage reconciliation auditor, dimensioned by the actual
    // generationId (plus runId to group the run and conversationId to scope it)
    // so a killed run's generation is reconcilable though it committed no
    // usage_records row.
    upgradeRejected: (fields) => {
      telemetry.emitMetric('realtime_ws_upgrade_failure', 1, fields);
    },
    billableGeneration: (fields) => {
      telemetry.emitMetric('realtime_billable_generation', 1, fields);
    },
  };
}

/**
 * The epoch public key read the chat settlement wraps its content to — the
 * conversations slice is the single writer of `epochs`, so it supplies this
 * read; the chat commit never reaches the `epochs` table itself. Runs on the
 * settlement transaction it is handed.
 */
async function readEpochPublicKey(
  tx: DbWriter,
  conversationId: string,
  epochNumber: number
): Promise<Uint8Array | null> {
  const rows = await tx
    .select({ key: epochs.epochPublicKey })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
  return rows[0]?.key ?? null;
}

export function createEpochPublicKeyReader(): RoomEpochPublicKeyReader {
  return readEpochPublicKey;
}

/**
 * The default runtime factory: the room is unusable until the app root injects
 * the chat conversation-runtime. A fail-fast here names the missing wiring
 * rather than degrading (the executor/binder/referee cannot live in this
 * infra adapter — boundaries).
 */
function throwUnwiredRuntime(): RoomRuntime {
  throw new Error(
    'ConversationRoom runtime not injected — the app root must pass the chat ' +
      'conversation-runtime factory into createRoomBindings(env, createRuntime).'
  );
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

/**
 * Wraps the authoritative membership verifier with the trial-room carve-out: a
 * trial session is authorized to stream ONLY its own trial room (the DO whose
 * id is the session's sentinel-prefixed principal id). Every other pair —
 * including a trial principal addressing a different room and every
 * conversation member — falls through to the DB-backed verifier, so no trial
 * principal can ever open a conversation room and no member's gating is
 * loosened. Scoped tightly by construction: `isTrialRoomSelf` matches only
 * prefix-equal ids, which a bare conversation/user uuid never satisfies.
 */
export function composeTrialAwareVerifier(inner: MembershipVerifier): MembershipVerifier {
  return {
    verify: (conversationId, principalId) =>
      isTrialRoomSelf(conversationId, principalId)
        ? Promise.resolve('member')
        : inner.verify(conversationId, principalId),
  };
}

export function createRoomBindings(
  env: Bindings,
  createRuntime: CreateRoomRuntime = throwUnwiredRuntime
): RoomBindings {
  const databaseUrl = requiredRoomBinding(env, 'DATABASE_URL');
  const redisUrl = requiredRoomBinding(env, 'UPSTASH_REDIS_REST_URL');
  const redisToken = requiredRoomBinding(env, 'UPSTASH_REDIS_REST_TOKEN');
  const envUtilities = createEnvUtilities(env);
  const redis = new Redis({ url: redisUrl, token: redisToken });
  const telemetry = createConsoleTelemetry();
  // One DO-scoped connection backs the executor, referee, and settlement (the
  // membership verifier keeps its own open-then-close-per-check connection).
  const runtimeDb = openRoomSourceDb(databaseUrl, envUtilities);
  const runtime = createRuntime({
    db: runtimeDb,
    redis,
    telemetry,
    env,
    readEpochPublicKey: createEpochPublicKeyReader(),
  });
  return {
    executor: runtime.executor,
    verifier: composeTrialAwareVerifier(
      composeMembershipVerifier({
        cache: createRedisMembershipCache(redis),
        source: createRoomMembershipSource(databaseUrl, envUtilities),
      })
    ),
    telemetry: createRoomTelemetry(telemetry),
    claimRun: runtime.claimRun,
    bindHooks: runtime.bindHooks,
    maxStreamBytes: REALTIME_MAX_STREAM_BYTES,
    now: () => Date.now(),
    newRunId: () => crypto.randomUUID(),
  };
}
