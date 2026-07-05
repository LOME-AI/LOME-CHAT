import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFixtureFetch } from './failure-fixtures.js';
import { IMAGE_FAILURE_FIXTURES, VIDEO_FAILURE_FIXTURES } from './media-failure-fixtures.js';

const errorBodySchema = z.object({ error: z.object({ code: z.number(), message: z.string() }) });

describe('IMAGE_FAILURE_FIXTURES', () => {
  it('shapes no_providers_available as a 404 OpenRouter JSON error', async () => {
    const fixtureFetch = createFixtureFetch(IMAGE_FAILURE_FIXTURES.noProvidersAvailable);

    const response = await fixtureFetch('https://openrouter.ai/api/v1/images', { method: 'POST' });

    expect(response.status).toBe(404);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error.code).toBe(404);
    expect(body.error.message).toContain('guardrail');
  });

  it('shapes the rate limit as a 429 OpenRouter JSON error', async () => {
    const fixtureFetch = createFixtureFetch(IMAGE_FAILURE_FIXTURES.rateLimited);

    const response = await fixtureFetch('https://openrouter.ai/api/v1/images', { method: 'POST' });

    expect(response.status).toBe(429);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error.code).toBe(429);
  });

  it('shapes the malformed response as a 200 whose data field is not an array', async () => {
    const fixtureFetch = createFixtureFetch(IMAGE_FAILURE_FIXTURES.malformedResponse);

    const response = await fixtureFetch('https://openrouter.ai/api/v1/images', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = z.object({ data: z.unknown() }).parse(await response.json());
    expect(Array.isArray(body.data)).toBe(false);
  });
});

describe('VIDEO_FAILURE_FIXTURES', () => {
  it('shapes no_providers_available as a 404 OpenRouter JSON error', async () => {
    const fixtureFetch = createFixtureFetch(VIDEO_FAILURE_FIXTURES.noProvidersAvailable);

    const response = await fixtureFetch('https://openrouter.ai/api/v1/videos', { method: 'POST' });

    expect(response.status).toBe(404);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error.code).toBe(404);
  });

  it('shapes the rate limit as a 429 OpenRouter JSON error', async () => {
    const fixtureFetch = createFixtureFetch(VIDEO_FAILURE_FIXTURES.rateLimited);

    const response = await fixtureFetch('https://openrouter.ai/api/v1/videos', { method: 'POST' });

    expect(response.status).toBe(429);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error.code).toBe(429);
  });

  it('shapes the malformed submit response as a 200 missing the required job fields', async () => {
    const fixtureFetch = createFixtureFetch(VIDEO_FAILURE_FIXTURES.malformedResponse);

    const response = await fixtureFetch('https://openrouter.ai/api/v1/videos', { method: 'POST' });

    expect(response.status).toBe(200);
    const body = z.object({ nope: z.boolean() }).parse(await response.json());
    expect(body.nope).toBe(true);
  });
});
