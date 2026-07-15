import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_EXEMPTION_CLASSES,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  idempotencyExempt,
  idempotencyKeyStage,
  readIdempotencyExemption,
  readIdempotencyKey,
} from './middleware.js';
import type { AppEnv } from '../context/index.js';
import type { IdempotencyExemptionClass } from './middleware.js';

function appWithStage(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', idempotencyKeyStage());
  return app;
}

describe('idempotencyKeyStage', () => {
  it('rejects a mutating request without the header on a non-exempt route', async () => {
    const app = appWithStage().post('/things', (c) => c.json({ done: true }));
    const response = await app.request('/things', { method: 'POST' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('serializes the missing-key rejection as the exact error-contract bytes', async () => {
    const app = appWithStage().post('/things', (c) => c.json({ done: true }));
    const response = await app.request('/things', { method: 'POST' });
    expect(await response.text()).toBe('{"code":"IDEMPOTENCY_KEY_REQUIRED"}');
  });

  it('serializes the invalid-key rejection as the exact error-contract bytes', async () => {
    const app = appWithStage().post('/things', (c) => c.json({ done: true }));
    const response = await app.request('/things', {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: 'k'.repeat(4096) },
    });
    expect(await response.text()).toBe(
      '{"code":"VALIDATION","details":{"header":"Idempotency-Key"}}'
    );
  });

  it('passes a mutating request that carries the header', async () => {
    const app = appWithStage().post('/things', (c) => c.json({ done: true }));
    const response = await app.request('/things', {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: 'key-1' },
    });
    expect(response.status).toBe(200);
  });

  it('treats a blank header as missing', async () => {
    const app = appWithStage().post('/things', (c) => c.json({ done: true }));
    const response = await app.request('/things', {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: '   ' },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a multi-kilobyte key with a 400 validation error', async () => {
    const app = appWithStage().post('/things', (c) => c.json({ done: true }));
    const response = await app.request('/things', {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: 'k'.repeat(4096) },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 'VALIDATION',
      details: { header: IDEMPOTENCY_KEY_HEADER },
    });
  });

  it('rejects a key containing control characters', async () => {
    const app = appWithStage().post('/things', (c) => c.json({ done: true }));
    const response = await app.request('/things', {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: 'key\twith\ttabs' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 'VALIDATION',
      details: { header: IDEMPOTENCY_KEY_HEADER },
    });
  });

  it('passes a key exactly at the documented length cap', async () => {
    const app = appWithStage().post('/things', (c) => c.json({ done: true }));
    const response = await app.request('/things', {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: 'k'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH) },
    });
    expect(response.status).toBe(200);
  });

  it('ignores non-mutating methods', async () => {
    const app = appWithStage().get('/things', (c) => c.json({ items: [] }));
    const response = await app.request('/things');
    expect(response.status).toBe(200);
  });

  it.each([...IDEMPOTENCY_EXEMPTION_CLASSES])(
    'passes a keyless mutating request on a route declaring %s',
    async (cls: IdempotencyExemptionClass) => {
      const app = appWithStage().post('/exempted', idempotencyExempt(cls), (c) =>
        c.json({ done: true })
      );
      const response = await app.request('/exempted', { method: 'POST' });
      expect(response.status).toBe(200);
    }
  );

  it('reads an exemption through sub-app handler composition', async () => {
    // A sub-app with its own onError makes Hono wrap every handler at mount
    // time (COMPOSED_HANDLER); the declaration must survive the wrapping.
    const sub = new Hono<AppEnv>();
    sub.onError((_error, c) => c.json({ code: 'INTERNAL' }, 500));
    sub.post('/helcim', idempotencyExempt('webhook-event-id'), (c) => c.json({ done: true }));
    const app = appWithStage().route('/webhooks', sub);
    const response = await app.request('/webhooks/helcim', { method: 'POST' });
    expect(response.status).toBe(200);
  });

  it('honors an exemption declared on a subtree', async () => {
    const app = appWithStage();
    app.use('/webhooks/*', idempotencyExempt('webhook-event-id'));
    app.post('/webhooks/helcim', (c) => c.json({ done: true }));
    const response = await app.request('/webhooks/helcim', { method: 'POST' });
    expect(response.status).toBe(200);
  });

  it('falls through to 404 for an unmatched mutating path', async () => {
    const app = appWithStage();
    const response = await app.request('/nowhere', { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('treats conflicting exemption declarations as a defect', async () => {
    const defects: unknown[] = [];
    const app = appWithStage();
    app.onError((error, c) => {
      defects.push(error);
      return c.json({ code: 'INTERNAL' }, 500);
    });
    app.post(
      '/conflicted',
      idempotencyExempt('opaque-protocol'),
      idempotencyExempt('token-is-key'),
      (c) => c.json({ done: true })
    );
    const response = await app.request('/conflicted', { method: 'POST' });
    expect(response.status).toBe(500);
    expect(defects).toHaveLength(1);
    expect(String(defects[0])).toMatch(/conflicting exemption classes/);
  });
});

describe('idempotencyExempt', () => {
  it('fails fast at registration on an unknown class', () => {
    expect(() => idempotencyExempt('not-a-class' as IdempotencyExemptionClass)).toThrow(
      /exemption class/
    );
  });

  it('admits the admin-engine class (the admin op engine dedups on the key row itself)', async () => {
    const app = appWithStage().post(
      '/admin/ops/x/execute',
      idempotencyExempt('admin-engine'),
      (c) => c.json({ done: true })
    );
    const response = await app.request('/admin/ops/x/execute', { method: 'POST' });
    expect(response.status).toBe(200);
  });
});

describe('readIdempotencyExemption', () => {
  it('returns the class declared on a marker', () => {
    expect(readIdempotencyExemption(idempotencyExempt('token-is-key'))).toBe('token-is-key');
  });

  it('returns undefined for a handler without a declaration', () => {
    expect(readIdempotencyExemption(() => null)).toBeUndefined();
  });

  it('returns undefined for a non-function', () => {
    expect(readIdempotencyExemption('not a handler')).toBeUndefined();
  });
});

describe('readIdempotencyKey', () => {
  it('returns the header value to the handler', async () => {
    const app = appWithStage().post('/things', (c) =>
      c.json({ key: readIdempotencyKey(c) ?? null })
    );
    const response = await app.request('/things', {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: 'key-9' },
    });
    expect(await response.json()).toEqual({ key: 'key-9' });
  });
});
