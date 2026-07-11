import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requestLog } from './request-log.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';
import type { SafeLogFields } from '../lib/telemetry/index.js';

interface RecordedLine {
  readonly msg: string;
  readonly fields: SafeLogFields | undefined;
}

function createRecordingLogger(): { telemetry: Telemetry; lines: RecordedLine[] } {
  const lines: RecordedLine[] = [];
  const record = (msg: string, fields?: SafeLogFields): void => {
    lines.push({ msg, fields });
  };
  const telemetry: Telemetry = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    emitMetric: (): void => undefined,
    captureError: (): void => undefined,
  };
  return { telemetry, lines };
}

const devEnv: Bindings = { NODE_ENV: 'development' };
const productionEnv: Bindings = { NODE_ENV: 'production' };

function buildApp(telemetry?: Telemetry): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  if (telemetry !== undefined) {
    app.use('*', async (c, next) => {
      c.set('logger', telemetry);
      await next();
    });
  }
  return app
    .use('*', requestLog())
    .get('/items/:id', (c) => c.json({ ok: true }))
    .post('/items', (c) => c.json({ ok: true }, 201));
}

describe('requestLog', () => {
  it('logs method, route template, status, and latency in dev', async () => {
    const { telemetry, lines } = createRecordingLogger();
    const res = await buildApp(telemetry).request('/items/secret-123', {}, devEnv);
    expect(res.status).toBe(200);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line?.msg).toBe('request completed');
    expect(line?.fields?.method).toBe('GET');
    expect(line?.fields?.statusCode).toBe(200);
    expect(typeof line?.fields?.latencyMs).toBe('number');
    // The route TEMPLATE, never the concrete URL.
    expect(line?.fields?.route).toBe('/items/:id');
  });

  it('never logs the concrete path or query string', async () => {
    const { telemetry, lines } = createRecordingLogger();
    await buildApp(telemetry).request('/items/secret-123?token=leak', {}, devEnv);
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('secret-123');
    expect(serialized).not.toContain('token=leak');
  });

  it('logs the mutating method and its status code', async () => {
    const { telemetry, lines } = createRecordingLogger();
    await buildApp(telemetry).request('/items', { method: 'POST' }, devEnv);
    expect(lines[0]?.fields?.method).toBe('POST');
    expect(lines[0]?.fields?.statusCode).toBe(201);
  });

  it('logs an unmatched request with the route placeholder, not the URL', async () => {
    const { telemetry, lines } = createRecordingLogger();
    const res = await buildApp(telemetry).request('/no/such/route', {}, devEnv);
    expect(res.status).toBe(404);
    expect(lines[0]?.fields?.route).toBe('unmatched');
  });

  it('is a no-op in production', async () => {
    const { telemetry, lines } = createRecordingLogger();
    const res = await buildApp(telemetry).request('/items/1', {}, productionEnv);
    expect(res.status).toBe(200);
    expect(lines).toHaveLength(0);
  });

  it('skips logging when the pipeline logger is absent (early-defect path)', async () => {
    const res = await buildApp().request('/items/1', {}, devEnv);
    expect(res.status).toBe(200);
  });
});
