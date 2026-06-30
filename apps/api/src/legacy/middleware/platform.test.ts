import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { platformMiddleware } from './platform.js';
import type { Platform } from '@hushbox/shared';

interface TestEnv {
  Variables: { platform: Platform };
}

function createApp(): Hono<TestEnv> {
  const app = new Hono<TestEnv>();
  app.use('*', platformMiddleware());
  app.get('/test', (c) => c.json({ platform: c.get('platform') }));
  return app;
}

describe('platformMiddleware', () => {
  it('defaults to web when no header is present', async () => {
    const app = createApp();

    const res = await app.request('/test');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ platform: 'web' });
  });

  it('reads platform from X-HushBox-Platform header', async () => {
    const app = createApp();

    const res = await app.request('/test', {
      headers: { 'X-HushBox-Platform': 'ios' },
    });
    const body = await res.json();

    expect(body).toEqual({ platform: 'ios' });
  });

  it('accepts android platform', async () => {
    const app = createApp();

    const res = await app.request('/test', {
      headers: { 'X-HushBox-Platform': 'android' },
    });
    const body = await res.json();

    expect(body).toEqual({ platform: 'android' });
  });

  it('accepts android-direct platform', async () => {
    const app = createApp();

    const res = await app.request('/test', {
      headers: { 'X-HushBox-Platform': 'android-direct' },
    });
    const body = await res.json();

    expect(body).toEqual({ platform: 'android-direct' });
  });

  it('falls back to web for invalid platform values', async () => {
    const app = createApp();

    const res = await app.request('/test', {
      headers: { 'X-HushBox-Platform': 'invalid-platform' },
    });
    const body = await res.json();

    expect(body).toEqual({ platform: 'web' });
  });

  it('falls back to web for empty header', async () => {
    const app = createApp();

    const res = await app.request('/test', {
      headers: { 'X-HushBox-Platform': '' },
    });
    const body = await res.json();

    expect(body).toEqual({ platform: 'web' });
  });
});
