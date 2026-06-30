import { describe, expect, it } from 'vitest';
import {
  createAppJobRegistry,
  createDispatcherTelemetry,
  createJobDispatcherBindings,
  openDispatcherDb,
} from './dispatcher-bindings.js';
import type { Telemetry } from '../telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for jobs integration tests');
}

interface Recorded {
  readonly port: Telemetry;
  readonly errors: string[];
  readonly captured: { message: string; errorCode: string }[];
}

function recordingTelemetry(): Recorded {
  const errors: string[] = [];
  const captured: { message: string; errorCode: string }[] = [];
  return {
    port: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg) => {
        errors.push(msg);
      },
      emitMetric: () => {},
      captureError: (error, errorCode) => {
        captured.push({ message: error.message, errorCode });
      },
    },
    errors,
    captured,
  };
}

describe('createDispatcherTelemetry', () => {
  it('maps a failed pass onto the typed port with an error capture', () => {
    const recorded = recordingTelemetry();
    createDispatcherTelemetry(recorded.port).passFailed({ shard: 'bulk' });
    expect(recorded.errors).toEqual(['job dispatcher pass failed']);
    expect(recorded.captured).toEqual([
      { message: 'job dispatcher pass failed on shard bulk', errorCode: 'job_pass_failed' },
    ]);
  });
});

describe('createAppJobRegistry', () => {
  it('starts empty — job types register as their owning slices land', () => {
    expect(createAppJobRegistry().types()).toEqual([]);
  });
});

describe('openDispatcherDb', () => {
  it('builds a local-proxy client in dev and a direct client otherwise', async () => {
    const dev = openDispatcherDb(DATABASE_URL, { isDev: true });
    const production = openDispatcherDb(DATABASE_URL, { isDev: false });
    expect(dev).toBeDefined();
    expect(production).toBeDefined();
    await dev.$client.end();
    await production.$client.end();
  });
});

describe('createJobDispatcherBindings', () => {
  it('fails fast when DATABASE_URL is missing', () => {
    expect(() =>
      createJobDispatcherBindings({ NODE_ENV: 'development' }, createAppJobRegistry())
    ).toThrow('DATABASE_URL');
  });

  it('binds an executor that runs a real pass per invocation', async () => {
    const bindings = createJobDispatcherBindings(
      { NODE_ENV: 'development', DATABASE_URL },
      createAppJobRegistry()
    );
    // No committed claimable rows exist outside the pass-test file, so an
    // empty registry's pass reports an idle shard.
    await expect(bindings.executor.runPass('bulk')).resolves.toEqual({ kind: 'idle' });
    expect(typeof bindings.now()).toBe('number');
  });
});
