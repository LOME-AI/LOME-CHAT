import { describe, expect, it, vi } from 'vitest';
import { createWorkerEntry, worker } from './entry.js';
import type { Bindings } from './lib/context/index.js';
import type { TelemetryEnv } from './lib/telemetry/index.js';

const devEnv: Bindings &
  TelemetryEnv & { FRONTEND_URL: string; MARKETING_URL: string; FRONTEND_PREVIEW_URL: string } = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  // The composed pipeline runs CORS first; it fail-fasts on absent web origins.
  // These match the registry's development-mode origins (not secrets).
  FRONTEND_URL: 'http://localhost:5173',
  MARKETING_URL: 'http://localhost:4321',
  FRONTEND_PREVIEW_URL: 'http://localhost:4173',
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

  it('installs the console patch and delegates the scheduled invocation', async () => {
    const scheduledCalls: { cron: string; env: Bindings }[] = [];
    let patches = 0;
    const entry = createWorkerEntry({
      app: { fetch: () => new Response(null) },
      scheduled: (controller, env) => {
        scheduledCalls.push({ cron: controller.cron, env });
        return Promise.resolve();
      },
      installConsolePatch: () => {
        patches += 1;
      },
    });
    await entry.scheduled({ cron: '0 3 * * *' }, devEnv, fakeCtx);
    expect(scheduledCalls).toEqual([{ cron: '0 3 * * *', env: devEnv }]);
    expect(patches).toBe(1);
  });
});

describe('worker (the composed entry)', () => {
  it('serves the health route end-to-end', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const res = await worker.fetch(new Request('http://localhost/health'), devEnv, fakeCtx);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', timestamp: '2026-01-01T00:00:00.000Z' });
    } finally {
      vi.useRealTimers();
    }
  });
});
