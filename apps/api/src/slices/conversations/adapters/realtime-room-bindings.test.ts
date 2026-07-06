import { describe, expect, it, vi } from 'vitest';
import { createChatConversationRuntime } from '../../chat/index.js';
import {
  createEpochPublicKeyReader,
  createRoomBindings,
  createRoomTelemetry,
} from './realtime-room-bindings.js';
import type { CreateRoomRuntime } from './realtime-room-bindings.js';
import type { RoomTelemetry } from '@hushbox/realtime';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { Bindings } from '../../../lib/context/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';

/** A minimal drizzle read chain returning the supplied rows. */
function fakeReader(rows: readonly { readonly key: Uint8Array }[]): DbWriter {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as DbWriter;
}

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
});

describe('createEpochPublicKeyReader', () => {
  it('returns the epoch public key when the epoch row exists', async () => {
    const key = new Uint8Array([1, 2, 3]);
    const reader = createEpochPublicKeyReader();
    await expect(reader(fakeReader([{ key }]), 'c1', 1)).resolves.toBe(key);
  });

  it('returns null when the conversation has no such epoch', async () => {
    const reader = createEpochPublicKeyReader();
    await expect(reader(fakeReader([]), 'c1', 99)).resolves.toBeNull();
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
