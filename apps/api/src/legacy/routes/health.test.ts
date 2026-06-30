import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { healthRoute } from './health.js';

describe('GET /health', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns status ok with 200', async () => {
    const app = new Hono().route('/', healthRoute);
    const res = await app.request('/');

    expect(res.status).toBe(200);
  });

  it('returns JSON with status field', async () => {
    const app = new Hono().route('/', healthRoute);
    const res = await app.request('/');
    const body: { status: string; timestamp: string } = await res.json();

    expect(body.status).toBe('ok');
  });

  it('returns JSON with timestamp field', async () => {
    const app = new Hono().route('/', healthRoute);
    const res = await app.request('/');
    const body: { status: string; timestamp: string } = await res.json();

    expect(body.timestamp).toBe('2024-01-15T12:00:00.000Z');
  });

  it('returns correct content-type header', async () => {
    const app = new Hono().route('/', healthRoute);
    const res = await app.request('/');

    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
