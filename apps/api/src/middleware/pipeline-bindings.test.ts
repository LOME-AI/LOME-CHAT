import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { pipelineEnv } from './pipeline-env.js';
import { pipelineBindings } from './pipeline-bindings.js';
import { isPipelineHandler } from './pipeline-markers.js';
import { FINGERPRINT_CODES } from '../lib/telemetry/index.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return await res.json();
}

const completeEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
};

function createProbeApp(): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', pipelineEnv())
    .use('*', pipelineBindings())
    .get('/probe', (c) =>
      c.json({
        hasDb: typeof c.get('db').select === 'function',
        hasRedis: typeof c.get('redis').get === 'function',
        hasLogger: typeof c.get('logger').info === 'function',
        bindings: c.get('bindings'),
      })
    )
    .onError((err, c) => c.json({ message: err.message }, 500));
}

describe('pipelineBindings', () => {
  it('populates db, redis, logger, and the validated bindings on the context', async () => {
    const res = await createProbeApp().request('/probe', {}, completeEnv);
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      hasDb: boolean;
      hasRedis: boolean;
      hasLogger: boolean;
      bindings: Record<string, string>;
    }>(res);
    expect(body.hasDb).toBe(true);
    expect(body.hasRedis).toBe(true);
    expect(body.hasLogger).toBe(true);
    expect(body.bindings['IRON_SESSION_SECRET']).toBe(completeEnv.IRON_SESSION_SECRET);
  });

  it('binds the console telemetry adapter as the logger', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {
      // Silenced: the assertion is on the structured line, not the output.
    });
    const app = new Hono<AppEnv>()
      .use('*', pipelineEnv())
      .use('*', pipelineBindings())
      .get('/probe', (c) => {
        c.get('logger').info('pipeline probe', { requestId: 'r-1' });
        return c.json({ ok: true });
      });

    const res = await app.request('/probe', {}, completeEnv);

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      JSON.stringify({ level: 'info', msg: 'pipeline probe', requestId: 'r-1' })
    );
    spy.mockRestore();
  });

  it('fails fast naming TELEMETRY_SINKS when the sink list is missing', async () => {
    const incomplete = { ...completeEnv };
    delete incomplete.TELEMETRY_SINKS;
    const res = await createProbeApp().request('/probe', {}, incomplete);
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toContain('TELEMETRY_SINKS');
  });

  it('fails fast naming the missing binding', async () => {
    const incomplete = { ...completeEnv };
    delete incomplete.DATABASE_URL;
    const res = await createProbeApp().request('/probe', {}, incomplete);
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toContain('DATABASE_URL');
  });

  it('fails fast when applied without the env stage (pipeline order violated)', async () => {
    const app = new Hono<AppEnv>()
      .use('*', pipelineBindings())
      .get('/probe', (c) => c.json({ ok: true }))
      .onError((err, c) => c.json({ message: err.message }, 500));
    const res = await app.request('/probe', {}, completeEnv);
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/pipeline order/);
  });

  it('is marked as a pipeline handler', () => {
    expect(isPipelineHandler(pipelineBindings())).toBe(true);
  });
});

describe('pipelineBindings Sentry flush seam', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rides a captured defect onto executionCtx.waitUntil', async () => {
    // The fetch transport is the external seam; stubbed so no envelope leaves
    // the process.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          status: 200,
          headers: { get: (): null => null },
          text: () => Promise.resolve(''),
        })
      )
    );
    const sentryEnv: Bindings & TelemetryEnv = {
      ...completeEnv,
      TELEMETRY_SINKS: 'console,sentry',
      SENTRY_DSN: 'https://abc123@o1.ingest.sentry.io/42',
    };
    const tasks: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (task: Promise<unknown>): void => {
        tasks.push(task);
      },
      passThroughOnException: (): void => {
        // Unused by the pipeline; present to satisfy the ExecutionContext shape.
      },
      props: {},
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      // Silenced: the assertion is on waitUntil, not the console channel.
    });
    try {
      const app = new Hono<AppEnv>()
        .use('*', pipelineEnv())
        .use('*', pipelineBindings())
        .get('/probe', (c) => {
          c.get('logger').captureError(new Error('boom'), FINGERPRINT_CODES.workflowNodeDefect);
          return c.json({ ok: true });
        });

      const res = await app.request('/probe', {}, sentryEnv, executionCtx);

      expect(res.status).toBe(200);
      expect(tasks).toHaveLength(1);
      await Promise.all(tasks);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
