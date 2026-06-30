import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFixtureFetch } from './failure-fixtures.js';
import { IMAGE_FAILURE_FIXTURES, VIDEO_FAILURE_FIXTURES } from './media-failure-fixtures.js';

const errorBodySchema = z.object({ error: z.object({ type: z.string() }) });

describe('IMAGE_FAILURE_FIXTURES', () => {
  it('shapes no_providers_available as a gateway JSON error', async () => {
    const fixtureFetch = createFixtureFetch(IMAGE_FAILURE_FIXTURES.noProvidersAvailable);

    const response = await fixtureFetch('https://ai-gateway.vercel.sh/v3/ai/image-model', {
      method: 'POST',
    });

    expect(response.status).toBe(503);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error.type).toBe('no_providers_available');
  });

  it('shapes the rate limit as a 429 gateway JSON error', async () => {
    const fixtureFetch = createFixtureFetch(IMAGE_FAILURE_FIXTURES.rateLimited);

    const response = await fixtureFetch('https://ai-gateway.vercel.sh/v3/ai/image-model', {
      method: 'POST',
    });

    expect(response.status).toBe(429);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error.type).toBe('rate_limit_exceeded');
  });

  it('shapes the malformed response as a 200 whose images field is not an array', async () => {
    const fixtureFetch = createFixtureFetch(IMAGE_FAILURE_FIXTURES.malformedResponse);

    const response = await fixtureFetch('https://ai-gateway.vercel.sh/v3/ai/image-model', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = z.object({ images: z.unknown() }).parse(await response.json());
    expect(Array.isArray(body.images)).toBe(false);
  });
});

describe('VIDEO_FAILURE_FIXTURES', () => {
  it('shapes no_providers_available as a gateway JSON error', async () => {
    const fixtureFetch = createFixtureFetch(VIDEO_FAILURE_FIXTURES.noProvidersAvailable);

    const response = await fixtureFetch('https://ai-gateway.vercel.sh/v3/ai/video-model', {
      method: 'POST',
    });

    expect(response.status).toBe(503);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error.type).toBe('no_providers_available');
  });

  it('shapes the rate limit as a 429 gateway JSON error', async () => {
    const fixtureFetch = createFixtureFetch(VIDEO_FAILURE_FIXTURES.rateLimited);

    const response = await fixtureFetch('https://ai-gateway.vercel.sh/v3/ai/video-model', {
      method: 'POST',
    });

    expect(response.status).toBe(429);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error.type).toBe('rate_limit_exceeded');
  });

  it('shapes the truncated stream as an SSE response without a data event', async () => {
    const fixtureFetch = createFixtureFetch(VIDEO_FAILURE_FIXTURES.truncatedStream);

    const response = await fixtureFetch('https://ai-gateway.vercel.sh/v3/ai/video-model', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).not.toContain('data:');
  });
});
