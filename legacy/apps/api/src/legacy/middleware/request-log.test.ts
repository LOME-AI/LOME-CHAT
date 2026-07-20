import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { requestLog } from './request-log.js';
import { envMiddleware } from './dependencies.js';
import type { AppEnv } from '../types.js';

function createApp(bindings: { NODE_ENV?: string } = {}): {
  app: Hono<AppEnv>;
  bindings: { NODE_ENV?: string };
} {
  const app = new Hono<AppEnv>();
  app.use('*', envMiddleware());
  app.use('*', requestLog());
  app.get('/api/ok', (c) => c.json({ ok: true }));
  app.get('/api/boom', () => {
    throw new Error('intentional');
  });
  app.post('/api/echo', (c) => c.json({ echoed: true }));
  return { app, bindings };
}

let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe('requestLog middleware', () => {
  it('emits one [req] line per request in dev mode', async () => {
    const { app } = createApp();
    await app.request('/api/ok', {}, {} as never);

    const calls = consoleSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].startsWith('[req] ')
    );
    expect(calls).toHaveLength(1);
  });

  it('skips logging entirely in production', async () => {
    const { app } = createApp();
    await app.request('/api/ok', {}, { NODE_ENV: 'production' } as never);

    const calls = consoleSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].startsWith('[req] ')
    );
    expect(calls).toHaveLength(0);
  });

  it('includes ISO timestamp, method, path, status, duration, and version', async () => {
    const { app } = createApp();
    await app.request(
      '/api/ok',
      { headers: { 'X-App-Version': 'local-mobile-test' } },
      {} as never
    );

    const line = consoleSpy.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].startsWith('[req] ')
    )?.[0] as string;
    expect(line).toMatch(
      /^\[req\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z GET \/api\/ok 200 \d+ms v=local-mobile-test$/
    );
  });

  it('logs v=none when X-App-Version header is missing', async () => {
    const { app } = createApp();
    await app.request('/api/ok', {}, {} as never);

    const line = consoleSpy.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].startsWith('[req] ')
    )?.[0] as string;
    expect(line).toContain(' v=none');
  });

  it('logs the correct HTTP method', async () => {
    const { app } = createApp();
    await app.request('/api/echo', { method: 'POST' }, {} as never);

    const line = consoleSpy.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].startsWith('[req] ')
    )?.[0] as string;
    expect(line).toContain(' POST /api/echo ');
  });

  it('still logs when the route throws (uses 500 status)', async () => {
    const { app } = createApp();
    // Hono onError will catch this; the middleware should still observe a status.
    app.onError((_err, c) => c.json({ code: 'INTERNAL' }, 500));

    await app.request('/api/boom', {}, {} as never);

    const line = consoleSpy.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].startsWith('[req] ')
    )?.[0] as string;
    expect(line).toContain(' GET /api/boom 500 ');
  });
});
