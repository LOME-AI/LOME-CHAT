/**
 * Hand-curated synthetic failure cassettes for the media generate families
 * (image: `/images` JSON endpoint; video: `/videos` submit JSON endpoint).
 * Same rationale as the language failure fixtures: live 4xx/5xx responses are
 * never recorded, so error paths replay only from these — injected via
 * `createFixtureFetch` at the SDK's `fetch` seam.
 *
 * ALL fixtures are synthetic: authored from OpenRouter's error envelope
 * (`{ error: { code, message } }`) and the image/video response schemas, not
 * recorded from the live provider (implementation agents hold no credentials).
 */

import { type Cassette } from './cassette-store.js';

function singleExchangeCassette(input: {
  status: number;
  statusText: string;
  contentType: string;
  bodyText: string;
}): Cassette {
  return {
    version: 1,
    exchanges: [
      {
        status: input.status,
        statusText: input.statusText,
        headers: { 'content-type': input.contentType },
        chunks: [Buffer.from(input.bodyText, 'utf8').toString('base64')],
      },
    ],
    recordedAt: '2026-07-04T00:00:00.000Z',
  };
}

interface ErrorCassetteInput {
  readonly status: number;
  readonly statusText: string;
  readonly code: number;
  readonly message: string;
}

function openrouterErrorCassette(input: ErrorCassetteInput): Cassette {
  return singleExchangeCassette({
    status: input.status,
    statusText: input.statusText,
    contentType: 'application/json',
    bodyText: JSON.stringify({ error: { code: input.code, message: input.message } }),
  });
}

/** ZDR fail-closed: OpenRouter refuses with a logical 404 guardrail error. */
const noProvidersAvailable: Cassette = openrouterErrorCassette({
  status: 404,
  statusText: 'Not Found',
  code: 404,
  message: 'No endpoints available matching your guardrail restrictions and data policy',
});

const rateLimited: Cassette = openrouterErrorCassette({
  status: 429,
  statusText: 'Too Many Requests',
  code: 429,
  message: 'Rate limit exceeded, please try again later',
});

/**
 * A 200 whose JSON body violates the OpenRouter image response schema
 * (`data` must be an array of `{ b64_json }`) — the SDK's response parser
 * rejects it as an upstream error.
 */
const imageMalformedResponse: Cassette = singleExchangeCassette({
  status: 200,
  statusText: 'OK',
  contentType: 'application/json',
  bodyText: JSON.stringify({ data: 'not-an-array' }),
});

/**
 * A 200 whose JSON body violates the OpenRouter video submit schema (missing
 * `id`/`polling_url`/`status`) — the submit call's response parser rejects it.
 */
const videoMalformedResponse: Cassette = singleExchangeCassette({
  status: 200,
  statusText: 'OK',
  contentType: 'application/json',
  bodyText: JSON.stringify({ nope: true }),
});

export const IMAGE_FAILURE_FIXTURES = {
  noProvidersAvailable,
  rateLimited,
  malformedResponse: imageMalformedResponse,
} as const;

export const VIDEO_FAILURE_FIXTURES = {
  noProvidersAvailable,
  rateLimited,
  malformedResponse: videoMalformedResponse,
} as const;
