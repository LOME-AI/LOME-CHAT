import { describe, expect, it } from 'vitest';
import { createWorkerEntry, worker } from './entry.js';
import type { Bindings } from './lib/context/index.js';
import type { TelemetryEnv } from './lib/telemetry/index.js';

const devEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
};

const fakeCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as ExecutionContext;

interface RecordedEntry {
  readonly entry: ReturnType<typeof createWorkerEntry>;
  readonly calls: { kind: 'patch' | 'fetch'; env: Bindings }[];
  readonly response: Response;
}

function recordedEntry(): RecordedEntry {
  const calls: { kind: 'patch' | 'fetch'; env: Bindings }[] = [];
  const response = new Response('app-response');
  const entry = createWorkerEntry({
    app: {
      fetch: (_request, env) => {
        calls.push({ kind: 'fetch', env });
        return response;
      },
    },
    scheduled: () => Promise.resolve(),
    installConsolePatch: (env) => {
      calls.push({ kind: 'patch', env });
    },
  });
  return { entry, calls, response };
}

describe('createWorkerEntry', () => {
  it('installs the console patch with the invocation env before delegating', async () => {
    const { entry, calls } = recordedEntry();
    await entry.fetch(new Request('http://localhost/health'), devEnv, fakeCtx);
    expect(calls).toEqual([
      { kind: 'patch', env: devEnv },
      { kind: 'fetch', env: devEnv },
    ]);
  });

  it('installs the console patch on every invocation, not only the first', async () => {
    const { entry, calls } = recordedEntry();
    await entry.fetch(new Request('http://localhost/a'), devEnv, fakeCtx);
    await entry.fetch(new Request('http://localhost/b'), devEnv, fakeCtx);
    expect(calls.filter((call) => call.kind === 'patch')).toHaveLength(2);
  });

  it('returns the app response unchanged', async () => {
    const { entry, response } = recordedEntry();
    const result = await entry.fetch(new Request('http://localhost/health'), devEnv, fakeCtx);
    expect(result).toBe(response);
  });

  it('exposes the scheduled handler it was composed with', async () => {
    let scheduledRuns = 0;
    const entry = createWorkerEntry({
      app: { fetch: () => new Response(null) },
      scheduled: () => {
        scheduledRuns += 1;
        return Promise.resolve();
      },
      installConsolePatch: () => {},
    });
    await entry.scheduled();
    expect(scheduledRuns).toBe(1);
  });
});

describe('worker (the composed entry)', () => {
  it('serves the health route end-to-end', async () => {
    const res = await worker.fetch(new Request('http://localhost/health'), devEnv, fakeCtx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
