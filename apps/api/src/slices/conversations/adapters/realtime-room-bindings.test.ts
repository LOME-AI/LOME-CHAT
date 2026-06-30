import { describe, expect, it } from 'vitest';
import {
  createRoomBindings,
  createRoomTelemetry,
  createUnboundExecutor,
  createUnboundHookBinder,
  createUnboundVerifier,
} from './realtime-room-bindings.js';
import type { WorkflowDefinition } from '@hushbox/shared';
import type { RoomTelemetry } from '@hushbox/realtime';
import type { Telemetry } from '../../../lib/telemetry/index.js';

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

describe('unbound placeholders (fail fast until sibling slices bind them)', () => {
  it('throws from the executor naming the workflows engine', () => {
    const executor = createUnboundExecutor();
    expect(() =>
      executor.start({
        definition: {} as WorkflowDefinition,
        inputs: {},
        hooks: {
          admission: () => Promise.resolve({ admitted: true, holdRef: 'h' }),
          settlement: () => Promise.resolve(),
        },
        runKey: 'k',
        emit: () => {},
      })
    ).toThrow(/workflows engine/);
  });

  it('throws from the verifier naming the conversations slice', () => {
    const verifier = createUnboundVerifier();
    expect(() => verifier.verify('c1', 'u1')).toThrow(/conversations slice/);
  });

  it('throws from the hook binder naming the workflows engine', () => {
    const bindHooks = createUnboundHookBinder();
    expect(() => bindHooks({} as WorkflowDefinition)).toThrow(/workflows engine/);
  });
});

describe('createRoomBindings', () => {
  it('mints unique run ids', () => {
    const bindings = createRoomBindings();
    expect(bindings.newRunId()).not.toBe(bindings.newRunId());
  });

  it('reads the wall clock', () => {
    const bindings = createRoomBindings();
    const before = Date.now();
    const now = bindings.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('caps the replay buffer with a positive byte budget', () => {
    expect(createRoomBindings().maxStreamBytes).toBeGreaterThan(0);
  });
});
