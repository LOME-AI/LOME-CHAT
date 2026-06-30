import { describe, expect, it } from 'vitest';
import { createTelemetryFanOut } from './fan-out.js';
import type { Telemetry } from './port.js';

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function createRecordingSink(): { sink: Telemetry; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  return {
    sink: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      emitMetric: record('emitMetric'),
      captureError: record('captureError'),
    },
    calls,
  };
}

/** A sink that violates the port's never-throw contract on every method. */
function createThrowingSink(): Telemetry {
  const explode = (): never => {
    throw new Error('sink defect');
  };
  return {
    debug: explode,
    info: explode,
    warn: explode,
    error: explode,
    emitMetric: explode,
    captureError: explode,
  };
}

describe('createTelemetryFanOut forwarding', () => {
  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'forwards %s with msg and fields to every sink',
    (level) => {
      const first = createRecordingSink();
      const second = createRecordingSink();
      const telemetry = createTelemetryFanOut([first.sink, second.sink]);

      telemetry[level]('turn settled', { requestId: 'r-1' });

      for (const { calls } of [first, second]) {
        expect(calls).toEqual([{ method: level, args: ['turn settled', { requestId: 'r-1' }] }]);
      }
    }
  );

  it('forwards emitMetric with name, value, and dimensions to every sink', () => {
    const first = createRecordingSink();
    const second = createRecordingSink();
    const telemetry = createTelemetryFanOut([first.sink, second.sink]);

    telemetry.emitMetric('chat.tokens', 1280, { modelName: 'gpt-4o' });

    for (const { calls } of [first, second]) {
      expect(calls).toEqual([
        { method: 'emitMetric', args: ['chat.tokens', 1280, { modelName: 'gpt-4o' }] },
      ]);
    }
  });

  it('forwards captureError with the error and code to every sink', () => {
    const first = createRecordingSink();
    const second = createRecordingSink();
    const telemetry = createTelemetryFanOut([first.sink, second.sink]);
    const defect = new Error('boom');

    telemetry.captureError(defect, 'db_query_failed');

    for (const { calls } of [first, second]) {
      expect(calls).toEqual([{ method: 'captureError', args: [defect, 'db_query_failed'] }]);
    }
  });
});

describe('createTelemetryFanOut sink isolation (error channel is never)', () => {
  it('keeps delivering to later sinks when an earlier sink throws', () => {
    const recorder = createRecordingSink();
    const telemetry = createTelemetryFanOut([createThrowingSink(), recorder.sink]);

    telemetry.info('probe', { requestId: 'r-1' });
    telemetry.emitMetric('chat.tokens', 1);
    telemetry.captureError(new Error('boom'), 'defect');

    expect(recorder.calls.map((call) => call.method)).toEqual([
      'info',
      'emitMetric',
      'captureError',
    ]);
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'contains a throwing sink in %s',
    (level) => {
      const telemetry = createTelemetryFanOut([createThrowingSink()]);
      expect(() => {
        telemetry[level]('probe');
      }).not.toThrow();
    }
  );

  it('contains a throwing sink in emitMetric', () => {
    const telemetry = createTelemetryFanOut([createThrowingSink()]);
    expect(() => {
      telemetry.emitMetric('chat.tokens', 1);
    }).not.toThrow();
  });

  it('contains a throwing sink in captureError', () => {
    const telemetry = createTelemetryFanOut([createThrowingSink()]);
    expect(() => {
      telemetry.captureError(new Error('boom'), 'defect');
    }).not.toThrow();
  });
});
