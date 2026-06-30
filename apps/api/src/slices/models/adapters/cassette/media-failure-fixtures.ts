/**
 * Hand-curated synthetic failure cassettes for the media generate families
 * (image: JSON endpoint; video: SSE endpoint). Same rationale as the
 * language failure fixtures: live 4xx/5xx responses are never recorded, so
 * error paths replay only from these — injected via `createFixtureFetch` at
 * the SDK's `fetch` seam.
 *
 * ALL fixtures are synthetic: authored from the gateway error contract
 * (@ai-sdk/gateway's `gatewayErrorResponseSchema`) and the gateway
 * image/video wire schemas (`gatewayImageResponseSchema`, the video SSE
 * event union), not recorded from the live gateway (implementation agents
 * hold no credentials).
 */

import { type Cassette } from './cassette-store.js';

interface ErrorCassetteInput {
  readonly status: number;
  readonly statusText: string;
  readonly errorType: string;
  readonly message: string;
}

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
    recordedAt: '2026-06-12T00:00:00.000Z',
  };
}

function gatewayErrorCassette(input: ErrorCassetteInput): Cassette {
  return singleExchangeCassette({
    status: input.status,
    statusText: input.statusText,
    contentType: 'application/json',
    bodyText: JSON.stringify({ error: { message: input.message, type: input.errorType } }),
  });
}

/**
 * ZDR fail-closed shape: the gateway routes only to providers under a ZDR
 * agreement and reports `no_providers_available` when none qualify.
 */
const noProvidersAvailable: Cassette = gatewayErrorCassette({
  status: 503,
  statusText: 'Service Unavailable',
  errorType: 'no_providers_available',
  message: 'No providers available for the requested model with Zero Data Retention enabled',
});

const rateLimited: Cassette = gatewayErrorCassette({
  status: 429,
  statusText: 'Too Many Requests',
  errorType: 'rate_limit_exceeded',
  message: 'Rate limit exceeded, please try again later',
});

/**
 * A 200 whose JSON body violates the gateway image response schema
 * (`images` must be a base64-string array) — the SDK's response parser
 * rejects it.
 */
const imageMalformedResponse: Cassette = singleExchangeCassette({
  status: 200,
  statusText: 'OK',
  contentType: 'application/json',
  bodyText: JSON.stringify({ images: 'not-an-array' }),
});

/**
 * A 200 SSE response that dies before any data event arrives (one comment
 * line, then EOF) — the gateway video model requires exactly one terminal
 * `result`/`error` data event.
 */
const videoTruncatedStream: Cassette = singleExchangeCassette({
  status: 200,
  statusText: 'OK',
  contentType: 'text/event-stream',
  bodyText: ': keepalive\n\n',
});

export const IMAGE_FAILURE_FIXTURES = {
  noProvidersAvailable,
  rateLimited,
  malformedResponse: imageMalformedResponse,
} as const;

export const VIDEO_FAILURE_FIXTURES = {
  noProvidersAvailable,
  rateLimited,
  truncatedStream: videoTruncatedStream,
} as const;
