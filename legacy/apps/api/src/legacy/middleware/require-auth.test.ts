import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requireAuth } from './require-auth';
import type { AppEnv } from '../types';

describe('requireAuth middleware', () => {
  it('returns 401 when user is null', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', async (c, next) => {
      c.set('user', null);
      await next();
    });

    app.use('*', requireAuth());
    app.get('/protected', (c) => c.json({ message: 'success' }));

    const res = await app.request('/protected');

    expect(res.status).toBe(401);
    const data: { code: string } = await res.json();
    expect(data.code).toBe('NOT_AUTHENTICATED');
  });

  it('allows request when user exists', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', async (c, next) => {
      c.set('user', {
        id: 'user-123',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
        publicKey: new Uint8Array(32),
      });
      await next();
    });

    app.use('*', requireAuth());
    app.get('/protected', (c) => c.json({ message: 'success' }));

    const res = await app.request('/protected');

    expect(res.status).toBe(200);
    const data: { message: string } = await res.json();
    expect(data.message).toBe('success');
  });

  it('can be applied to specific routes', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', async (c, next) => {
      c.set('user', null);
      await next();
    });

    app.get('/public', (c) => c.json({ message: 'public' }));
    app.use('/protected/*', requireAuth());
    app.get('/protected/resource', (c) => c.json({ message: 'protected' }));

    const publicRes = await app.request('/public');
    expect(publicRes.status).toBe(200);

    const protectedRes = await app.request('/protected/resource');
    expect(protectedRes.status).toBe(401);
  });
});
