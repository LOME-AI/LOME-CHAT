import { describe, expect, it, vi } from 'vitest';
import { createChatConversationRuntime } from '../../chat/index.js';
import { checkSessionLiveness } from '../../identity/index.js';
import { trialRoomName } from '@hushbox/realtime';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import {
  composeSessionVerifier,
  composeTrialAwareVerifier,
  createPushMembershipReader,
  createRoomBindings,
  createRoomTelemetry,
} from './realtime-room-bindings.js';
import type {
  CreateRoomRuntime,
  PushNotifyCompositionDeps,
  RoomSessionLivenessCheck,
} from './realtime-room-bindings.js';
import type {
  MembershipDecision,
  MembershipVerifier,
  RoomNotify,
  RoomTelemetry,
  SessionSnapshot,
} from '@hushbox/realtime';
import type { Database } from '@hushbox/db';
import type { Bindings } from '../../../lib/context/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';

/** A runtime factory double — the room's infra wiring is what these tests exercise. */
const fakeRuntime: CreateRoomRuntime = () => ({
  executor: {
    start: () => {
      throw new Error('unused in binding tests');
    },
  },
  bindHooks: () => ({
    admission: () => Promise.resolve({ admitted: false, code: 'INTERNAL' }),
    settlement: () => Promise.resolve(),
  }),
  claimRun: () => Promise.resolve({ outcome: 'attach' }),
  releaseHold: () => Promise.resolve(),
  heartbeat: () => Promise.resolve('alive'),
  failRun: () => Promise.resolve(),
});

// The verifier composition value-imports the realtime barrel, which
// transitively imports the workerd-only platform module; stubbed in node.
vi.mock('cloudflare:workers', () => ({
  // Never instantiated here — the stub only satisfies `extends` at load time.
  DurableObject: class {
    constructor(protected readonly ctx: unknown) {}
  },
}));

const ENV: Bindings = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/unused',
  UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:9',
  UPSTASH_REDIS_REST_TOKEN: 'unused',
  OPENROUTER_API_KEY: 'test-openrouter-key',
  // The chat runtime factory constructs (never exercises) the R2 storage
  // adapter, which fail-fasts on absent bindings; unused placeholder values.
  R2_S3_ENDPOINT: 'http://127.0.0.1:9',
  R2_BUCKET_MEDIA: 'unused',
  R2_ACCESS_KEY_ID: 'unused',
  R2_SECRET_ACCESS_KEY: 'unused',
} as Bindings;

interface Entry {
  level: string;
  msg: string;
  fields: unknown;
}

function recordingTelemetry(): { telemetry: Telemetry; entries: Entry[] } {
  const entries: Entry[] = [];
  const record =
    (level: string) =>
    (msg: string, fields?: unknown): void => {
      entries.push({ level, msg, fields });
    };
  const telemetry = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    emitMetric: (name: string, value: number, dimensions?: unknown): void => {
      entries.push({ level: 'metric', msg: name, fields: { value, dimensions } });
    },
    captureError: (error: Error, errorCode: string): void => {
      entries.push({ level: 'capture', msg: errorCode, fields: error });
    },
  } as Telemetry;
  return { telemetry, entries };
}

describe('createRoomTelemetry', () => {
  const cases: {
    event: keyof RoomTelemetry;
    level: string;
    msg: string;
    fields: Record<string, string>;
  }[] = [
    {
      event: 'runStarted',
      level: 'info',
      msg: 'realtime run started',
      fields: { conversationId: 'c1', runId: 'r1' },
    },
    {
      event: 'runFinished',
      level: 'info',
      msg: 'realtime run finished',
      fields: { conversationId: 'c1', runId: 'r1', errorCode: 'TIMEOUT' },
    },
    {
      event: 'runRejected',
      level: 'warn',
      msg: 'realtime run rejected',
      fields: { conversationId: 'c1', errorCode: 'CONCURRENT_RUN' },
    },
    {
      event: 'deadlineFired',
      level: 'warn',
      msg: 'realtime run deadline fired',
      fields: { conversationId: 'c1', runId: 'r1' },
    },
    {
      event: 'principalEvicted',
      level: 'warn',
      msg: 'realtime principal evicted at broadcast',
      fields: { conversationId: 'c1' },
    },
    {
      event: 'deliveryPaused',
      level: 'warn',
      msg: 'realtime delivery paused',
      fields: { conversationId: 'c1' },
    },
    {
      event: 'clientMessageRejected',
      level: 'warn',
      msg: 'realtime client message rejected',
      fields: { conversationId: 'c1' },
    },
  ];

  it.each(cases)('maps $event to a $level log with allowlisted fields', (testCase) => {
    const { telemetry, entries } = recordingTelemetry();
    const roomTelemetry = createRoomTelemetry(telemetry);
    (roomTelemetry[testCase.event] as (fields: Record<string, string>) => void)(testCase.fields);
    expect(entries).toEqual([
      { level: testCase.level, msg: testCase.msg, fields: testCase.fields },
    ]);
  });

  it('maps upgradeRejected to a warn log line', () => {
    const { telemetry, entries } = recordingTelemetry();
    createRoomTelemetry(telemetry).upgradeRejected({ conversationId: 'c1' });
    expect(entries).toEqual([
      { level: 'warn', msg: 'realtime ws upgrade rejected', fields: { conversationId: 'c1' } },
    ]);
  });

  it('maps billableGeneration to an info log line dimensioned by run and generation id', () => {
    const { telemetry, entries } = recordingTelemetry();
    createRoomTelemetry(telemetry).billableGeneration({
      conversationId: 'c1',
      runId: 'r1',
      generationId: 'gen-1',
    });
    expect(entries).toEqual([
      {
        level: 'info',
        msg: 'realtime billable generation',
        fields: { conversationId: 'c1', runId: 'r1', generationId: 'gen-1' },
      },
    ]);
  });
});

describe('composeTrialAwareVerifier', () => {
  const SESSION = '11111111-1111-4111-8111-111111111111';

  /** An inner verifier that records its calls and answers a fixed decision. */
  function inner(decision: MembershipDecision): {
    verifier: MembershipVerifier;
    calls: [string, string][];
  } {
    const calls: [string, string][] = [];
    return {
      verifier: {
        verify: (conversationId, principalId) => {
          calls.push([conversationId, principalId]);
          return Promise.resolve(decision);
        },
      },
      calls,
    };
  }

  it('authorizes a trial session for its own room without consulting the DB verifier', async () => {
    const room = trialRoomName(SESSION);
    const { verifier, calls } = inner('revoked');
    await expect(composeTrialAwareVerifier(verifier).verify(room, room)).resolves.toBe('member');
    expect(calls).toEqual([]);
  });

  it('delegates a conversation member to the authoritative verifier', async () => {
    const { verifier, calls } = inner('member');
    await expect(composeTrialAwareVerifier(verifier).verify('conv-1', 'user-1')).resolves.toBe(
      'member'
    );
    expect(calls).toEqual([['conv-1', 'user-1']]);
  });

  it('delegates a trial principal addressing another trial room (never self-authorized)', async () => {
    const { verifier, calls } = inner('revoked');
    const decision = await composeTrialAwareVerifier(verifier).verify(
      trialRoomName('other'),
      trialRoomName(SESSION)
    );
    expect(decision).toBe('revoked');
    expect(calls).toEqual([[trialRoomName('other'), trialRoomName(SESSION)]]);
  });
});

describe('createRoomBindings', () => {
  it('binds a complete runtime from the injected chat factory', () => {
    // The real chat conversation-runtime factory — proves the injection seam
    // typechecks and constructs (the app root wires this at assembly).
    const bindings = createRoomBindings(ENV, createChatConversationRuntime);
    expect(typeof bindings.executor.start).toBe('function');
    expect(typeof bindings.bindHooks).toBe('function');
    expect(typeof bindings.claimRun).toBe('function');
  });

  it('fails fast when no runtime factory is injected', () => {
    expect(() => createRoomBindings(ENV)).toThrow(/runtime not injected/);
  });

  it('mints unique run ids', () => {
    const bindings = createRoomBindings(ENV, fakeRuntime);
    expect(bindings.newRunId()).not.toBe(bindings.newRunId());
  });

  it('reads the wall clock', () => {
    const bindings = createRoomBindings(ENV, fakeRuntime);
    const before = Date.now();
    const now = bindings.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('caps the replay buffer with a positive byte budget', () => {
    expect(createRoomBindings(ENV, fakeRuntime).maxStreamBytes).toBeGreaterThan(0);
  });

  it('fails fast on a missing DATABASE_URL naming the binding', () => {
    expect(() => createRoomBindings({ ...ENV, DATABASE_URL: '' }, fakeRuntime)).toThrow(
      /DATABASE_URL/
    );
  });

  it('fails fast on a missing UPSTASH_REDIS_REST_URL naming the binding', () => {
    expect(() => createRoomBindings({ ...ENV, UPSTASH_REDIS_REST_URL: '' }, fakeRuntime)).toThrow(
      /UPSTASH_REDIS_REST_URL/
    );
  });

  it('fails fast on a missing UPSTASH_REDIS_REST_TOKEN naming the binding', () => {
    expect(() => createRoomBindings({ ...ENV, UPSTASH_REDIS_REST_TOKEN: '' }, fakeRuntime)).toThrow(
      /UPSTASH_REDIS_REST_TOKEN/
    );
  });
});

const SNAPSHOT: SessionSnapshot = { userId: 'u1', sessionId: 's1', sessionCreatedAt: 100 };

function livenessCheck(result: ReturnType<RoomSessionLivenessCheck>): {
  check: RoomSessionLivenessCheck;
  calls: { userId: string; sessionId: string; createdAt: number }[];
} {
  const calls: { userId: string; sessionId: string; createdAt: number }[] = [];
  return {
    calls,
    check: (_redis, inputs) => {
      calls.push(inputs);
      return result;
    },
  };
}

describe('composeSessionVerifier', () => {
  const REDIS = {} as never;

  it('delivers to a session identity reports active', async () => {
    const verifier = composeSessionVerifier(REDIS, livenessCheck(okAsync('active')).check);
    await expect(verifier.verify(SNAPSHOT)).resolves.toBe('live');
  });

  it('revokes a session identity reports revoked', async () => {
    const verifier = composeSessionVerifier(REDIS, livenessCheck(okAsync('revoked')).check);
    await expect(verifier.verify(SNAPSHOT)).resolves.toBe('revoked');
  });

  it('pauses (fail-closed) when the liveness read errors', async () => {
    const verifier = composeSessionVerifier(
      REDIS,
      livenessCheck(errAsync(unavailableError('redis down'))).check
    );
    await expect(verifier.verify(SNAPSHOT)).resolves.toBe('pause');
  });

  it('maps the snapshot onto identity’s inputs shape', async () => {
    const { check, calls } = livenessCheck(okAsync('active'));
    await composeSessionVerifier(REDIS, check).verify(SNAPSHOT);
    expect(calls).toEqual([{ userId: 'u1', sessionId: 's1', createdAt: 100 }]);
  });
});

/** A minimal drizzle read chain returning the supplied member rows. */
function fakeMemberDb(
  rows: readonly { readonly userId: string | null; readonly muted: boolean }[]
): Database {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as Database;
}

describe('createPushMembershipReader', () => {
  it('returns active user members with their mute flag', async () => {
    const reader = createPushMembershipReader(
      fakeMemberDb([
        { userId: 'u1', muted: false },
        { userId: 'u2', muted: true },
      ])
    );
    const result = await reader.listActiveUserMembers('c1');
    expect(result._unsafeUnwrap()).toEqual([
      { userId: 'u1', muted: false },
      { userId: 'u2', muted: true },
    ]);
  });

  it('drops a defensive null-userId row', async () => {
    const reader = createPushMembershipReader(
      fakeMemberDb([
        { userId: null, muted: false },
        { userId: 'u2', muted: true },
      ])
    );
    const result = await reader.listActiveUserMembers('c1');
    expect(result._unsafeUnwrap()).toEqual([{ userId: 'u2', muted: true }]);
  });

  it('maps a read failure to an unavailable error', async () => {
    const failing = {
      select: () => ({ from: () => ({ where: () => Promise.reject(new Error('down')) }) }),
    } as unknown as Database;
    const result = await createPushMembershipReader(failing).listActiveUserMembers('c1');
    expect(result.isErr()).toBe(true);
  });
});

describe('createRoomBindings push-notify wiring', () => {
  it('omits notify when no factory is injected', () => {
    expect(createRoomBindings(ENV, fakeRuntime).notify).toBeUndefined();
  });

  it('composes notify from the injected factory with the composed infra deps', () => {
    let received: PushNotifyCompositionDeps | undefined;
    const sentinel: RoomNotify = () => Promise.resolve();
    const bindings = createRoomBindings(ENV, fakeRuntime, undefined, (deps) => {
      received = deps;
      return sentinel;
    });
    expect(bindings.notify).toBe(sentinel);
    expect(received?.env).toBe(ENV);
    expect(typeof received?.membership.listActiveUserMembers).toBe('function');
    expect(typeof received?.db.select).toBe('function');
  });
});

describe('createRoomBindings session-liveness wiring', () => {
  it('omits the session verifier when no liveness read is injected', () => {
    expect(createRoomBindings(ENV, fakeRuntime).sessionVerifier).toBeUndefined();
  });

  it('composes the session verifier from the injected liveness read', async () => {
    const bindings = createRoomBindings(ENV, fakeRuntime, livenessCheck(okAsync('revoked')).check);
    expect(bindings.sessionVerifier).toBeDefined();
    await expect(bindings.sessionVerifier?.verify(SNAPSHOT)).resolves.toBe('revoked');
  });

  it('constructs the production composition — real chat runtime plus identity liveness read', () => {
    // The exact triple the composition root binds behind the DO class (which
    // itself cannot load here — it imports `cloudflare:workers` transitively).
    // Locks identity's published read against drift from the injected shape.
    const bindings = createRoomBindings(ENV, createChatConversationRuntime, checkSessionLiveness);
    expect(typeof bindings.executor.start).toBe('function');
    expect(bindings.sessionVerifier).toBeDefined();
  });
});
