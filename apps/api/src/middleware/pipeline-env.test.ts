import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { pipelineEnv } from './pipeline-env.js';
import { isPipelineHandler } from './pipeline-markers.js';
import type { AppEnv } from '../lib/context/index.js';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return await res.json();
}

function createProbeApp(): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', pipelineEnv())
    .get('/probe', (c) => c.json(c.get('envUtils')))
    .onError((err, c) => c.json({ message: err.message }, 500));
}

describe('pipelineEnv', () => {
  it('sets envUtils derived from the request bindings', async () => {
    const res = await createProbeApp().request('/probe', {}, { NODE_ENV: 'development' });
    expect(res.status).toBe(200);
    const body = await jsonBody<{ isDev: boolean; isProduction: boolean }>(res);
    expect(body.isDev).toBe(true);
    expect(body.isProduction).toBe(false);
  });

  it('reports production mode from the bindings', async () => {
    const res = await createProbeApp().request('/probe', {}, { NODE_ENV: 'production' });
    const body = await jsonBody<{ isProduction: boolean }>(res);
    expect(body.isProduction).toBe(true);
  });

  it('fails fast with a clear message when the app runs without bindings', async () => {
    const res = await createProbeApp().request('/probe');
    expect(res.status).toBe(500);
    const body = await jsonBody<{ message: string }>(res);
    expect(body.message).toMatch(/without bindings/);
  });

  it('is marked as a pipeline handler', () => {
    expect(isPipelineHandler(pipelineEnv())).toBe(true);
  });
});
