import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { errorHandler } from './error.js';

describe('errorHandler middleware', () => {
  it('returns 500 for unknown errors', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.get('/throw', () => {
      throw new Error('Test error');
    });

    const res = await app.request('/throw');

    expect(res.status).toBe(500);
    const body: { code: string } = await res.json();
    expect(body.code).toBe('INTERNAL');
  });

  it('returns HTTPException response for HTTPException errors', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.get('/http-error', () => {
      throw new HTTPException(404, { message: 'Not found' });
    });

    const res = await app.request('/http-error');

    expect(res.status).toBe(404);
  });

  it('returns HTTPException with custom message', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.get('/bad-request', () => {
      throw new HTTPException(400, { message: 'Invalid input' });
    });

    const res = await app.request('/bad-request');

    expect(res.status).toBe(400);
  });
});
