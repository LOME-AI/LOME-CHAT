import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FAILURE_FIXTURES, createFixtureFetch } from './failure-fixtures.js';

const errorBodySchema = z.object({ error: z.object({ code: z.number(), message: z.string() }) });

describe('FAILURE_FIXTURES', () => {
  it('shapes no_providers_available as a 404 OpenRouter JSON guardrail error', async () => {
    const fixtureFetch = createFixtureFetch(FAILURE_FIXTURES.noProvidersAvailable);

    const response = await fixtureFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error.code).toBe(404);
    expect(body.error.message).toContain('guardrail');
  });

  it('shapes the rate limit as a 429 OpenRouter JSON error', async () => {
    const fixtureFetch = createFixtureFetch(FAILURE_FIXTURES.rateLimited);

    const response = await fixtureFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
    });

    expect(response.status).toBe(429);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error.code).toBe(429);
  });

  it('shapes the mid-stream error as an SSE response carrying an OpenRouter error chunk', async () => {
    const fixtureFetch = createFixtureFetch(FAILURE_FIXTURES.midStreamError);

    const response = await fixtureFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).toContain('"content":"The answer is"');
    expect(body).toContain('"error"');
  });

  it('replays the same fixture for any request shape', async () => {
    const fixtureFetch = createFixtureFetch(FAILURE_FIXTURES.rateLimited);

    const first = await fixtureFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: 'one',
    });
    const second = await fixtureFetch('https://example.com/other');

    expect(first.status).toBe(429);
    expect(second.status).toBe(429);
  });
});
