import { describe, expect, it } from 'vitest';
import { createRequestTelemetry } from './request-telemetry.js';
import type { Bindings } from '../context/index.js';
import type { ConsoleSink } from './console-adapter.js';
import type { SentryTransportFactory } from './adapters/sentry-adapter.js';
import type { TelemetryEnv } from './request-telemetry.js';

const DSN = 'https://abc123@o1.ingest.sentry.io/42';

function createRecordingConsole(): {
  sink: ConsoleSink;
  lines: { method: string; line: string }[];
} {
  const lines: { method: string; line: string }[] = [];
  const record =
    (method: string) =>
    (line: string): void => {
      lines.push({ method, line });
    };
  return {
    sink: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    lines,
  };
}

function createSpyTransport(): { factory: SentryTransportFactory; envelopes: unknown[] } {
  const envelopes: unknown[] = [];
  return {
    factory: () => ({
      send: (envelope) => {
        envelopes.push(envelope);
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
    envelopes,
  };
}

function createSpyDataset(): { dataset: AnalyticsEngineDataset; points: unknown[] } {
  const points: unknown[] = [];
  return {
    dataset: {
      writeDataPoint: (point) => {
        points.push(point);
      },
    },
    points,
  };
}

describe('createRequestTelemetry sink-list validation (fail fast)', () => {
  it('throws naming TELEMETRY_SINKS when the variable is missing', () => {
    expect(() => createRequestTelemetry({})).toThrow(/TELEMETRY_SINKS/);
  });

  it('throws when TELEMETRY_SINKS is empty', () => {
    expect(() => createRequestTelemetry({ TELEMETRY_SINKS: '' })).toThrow(/TELEMETRY_SINKS/);
  });

  it('throws naming an unknown sink token', () => {
    expect(() => createRequestTelemetry({ TELEMETRY_SINKS: 'console,statsd' })).toThrow(/statsd/);
  });

  it('throws on a duplicated sink token', () => {
    expect(() => createRequestTelemetry({ TELEMETRY_SINKS: 'console,console' })).toThrow(/console/);
  });

  it('throws naming SENTRY_DSN when the sentry sink is requested without a DSN', () => {
    expect(() => createRequestTelemetry({ TELEMETRY_SINKS: 'console,sentry' })).toThrow(
      /SENTRY_DSN/
    );
  });

  it('throws naming SENTRY_DSN when the DSN is the explicit empty (disabled) value', () => {
    expect(() =>
      createRequestTelemetry({ TELEMETRY_SINKS: 'console,sentry', SENTRY_DSN: '' })
    ).toThrow(/SENTRY_DSN/);
  });
});

describe('createRequestTelemetry console-only composition (dev/test registry value)', () => {
  it('delivers logs to the console sink', () => {
    const recording = createRecordingConsole();
    const telemetry = createRequestTelemetry(
      { TELEMETRY_SINKS: 'console' },
      { consoleSink: recording.sink }
    );

    telemetry.info('pipeline probe', { requestId: 'r-1' });

    expect(recording.lines).toHaveLength(1);
    expect(JSON.parse(recording.lines[0]?.line ?? '')).toEqual({
      level: 'info',
      msg: 'pipeline probe',
      requestId: 'r-1',
    });
  });

  it('never reads the Sentry or WAE configuration', () => {
    // No DSN, no binding: a console-only list must not even look at them.
    expect(() => createRequestTelemetry({ TELEMETRY_SINKS: 'console' })).not.toThrow();
  });
});

describe('createRequestTelemetry full composition (production registry value)', () => {
  function fullEnv(dataset: AnalyticsEngineDataset): TelemetryEnv {
    return { TELEMETRY_SINKS: 'console,sentry,wae', SENTRY_DSN: DSN, WAE_METRICS: dataset };
  }

  it('fans a captured error out to console and Sentry', async () => {
    const recording = createRecordingConsole();
    const transport = createSpyTransport();
    const { dataset } = createSpyDataset();
    const tasks: Promise<unknown>[] = [];
    const telemetry = createRequestTelemetry(fullEnv(dataset), {
      consoleSink: recording.sink,
      sentryTransport: transport.factory,
      scheduleFlush: (task) => tasks.push(task),
    });

    telemetry.captureError(new Error('boom'), 'db_query_failed');

    expect(recording.lines.map((entry) => entry.method)).toEqual(['error']);
    await Promise.all(tasks);
    expect(transport.envelopes).toHaveLength(1);
  });

  it('schedules the Sentry flush through the provided scheduler', () => {
    const transport = createSpyTransport();
    const { dataset } = createSpyDataset();
    const tasks: Promise<unknown>[] = [];
    const telemetry = createRequestTelemetry(fullEnv(dataset), {
      consoleSink: createRecordingConsole().sink,
      sentryTransport: transport.factory,
      scheduleFlush: (task) => tasks.push(task),
    });

    telemetry.captureError(new Error('boom'), 'defect');

    expect(tasks).toHaveLength(1);
  });

  it('fans a metric out to console and WAE', () => {
    const recording = createRecordingConsole();
    const spy = createSpyDataset();
    const telemetry = createRequestTelemetry(fullEnv(spy.dataset), {
      consoleSink: recording.sink,
      sentryTransport: createSpyTransport().factory,
    });

    telemetry.emitMetric('chat.tokens', 1280, { modelName: 'gpt-4o' });

    expect(recording.lines.map((entry) => entry.method)).toEqual(['info']);
    expect(spy.points).toHaveLength(1);
  });

  it('keeps delivering to the remaining sinks when one sink fails', () => {
    const explode = (): never => {
      throw new Error('console sink down');
    };
    const spy = createSpyDataset();
    const telemetry = createRequestTelemetry(fullEnv(spy.dataset), {
      consoleSink: { debug: explode, info: explode, warn: explode, error: explode },
      sentryTransport: createSpyTransport().factory,
    });

    expect(() => {
      telemetry.emitMetric('chat.tokens', 1);
    }).not.toThrow();
    expect(spy.points).toHaveLength(1);
  });
});

describe('createRequestTelemetry env surface', () => {
  it('accepts the canonical Worker Bindings type directly', () => {
    const recording = createRecordingConsole();
    const env: Bindings = { TELEMETRY_SINKS: 'console', SENTRY_DSN: DSN };
    const telemetry = createRequestTelemetry(env, { consoleSink: recording.sink });

    telemetry.info('pipeline probe');

    expect(recording.lines).toHaveLength(1);
  });
});

describe('createRequestTelemetry with the WAE binding absent', () => {
  it('composes without WAE and records the degradation on the warn channel', () => {
    // The WAE_METRICS binding is documented optional-forever: absence
    // degrades metrics, never a request — so this is a loud warn, not a
    // fail-fast (unlike a missing DSN for a requested sentry sink).
    const recording = createRecordingConsole();
    const telemetry = createRequestTelemetry(
      { TELEMETRY_SINKS: 'console,wae' },
      { consoleSink: recording.sink }
    );

    telemetry.emitMetric('chat.tokens', 1);

    expect(recording.lines[0]?.method).toBe('warn');
    expect(recording.lines[0]?.line).toContain('telemetry wae binding missing');
    // The metric still rides the console channel.
    expect(recording.lines[1]?.method).toBe('info');
  });
});
