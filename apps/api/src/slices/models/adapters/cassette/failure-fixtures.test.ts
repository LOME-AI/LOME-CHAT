import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FAILURE_FIXTURES, createFixtureFetch } from './failure-fixtures.js';

const errorBodySchema = z.object({ error: z.object({ type: z.string() }) });

describe('FAILURE_FIXTURES', () => {
  it('shapes no_providers_available as a gateway JSON error', async () => {
    const fixtureFetch = createFixtureFetch(FAILURE_FIXTURES.noProvidersAvailable);

    const response = await fixtureFetch('https://ai-gateway.vercel.sh/v3/ai/language-model', {
      method: 'POST',
    });

    expect(response.status).toBe(503);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error.type).toBe('no_providers_available');
  });

  it('shapes the rate limit as a 429 gateway JSON error', async () => {
    const fixtureFetch = createFixtureFetch(FAILURE_FIXTURES.rateLimited);

    const response = await fixtureFetch('https://ai-gateway.vercel.sh/v3/ai/language-model', {
      method: 'POST',
    });

    expect(response.status).toBe(429);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error.type).toBe('rate_limit_exceeded');
  });

  it('shapes the truncated stream as an SSE response without a finish part', async () => {
    const fixtureFetch = createFixtureFetch(FAILURE_FIXTURES.truncatedStream);

    const response = await fixtureFetch('https://ai-gateway.vercel.sh/v3/ai/language-model', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).toContain('"type":"text-delta"');
    expect(body).not.toContain('"type":"finish"');
  });

  it('replays the same fixture for any request shape', async () => {
    const fixtureFetch = createFixtureFetch(FAILURE_FIXTURES.rateLimited);

    const first = await fixtureFetch('https://ai-gateway.vercel.sh/v3/ai/language-model', {
      method: 'POST',
      body: 'one',
    });
    const second = await fixtureFetch('https://example.com/other');

    expect(first.status).toBe(429);
    expect(second.status).toBe(429);
  });
});
