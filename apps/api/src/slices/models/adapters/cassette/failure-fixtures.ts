/**
 * Hand-curated synthetic failure cassettes. Live 4xx/5xx responses are
 * deliberately never recorded, so error paths could never replay — these
 * fixtures make error handling deterministic by injecting at the same fetch
 * seam the cassette harness uses (the SDK's `fetch` option).
 *
 * ALL fixtures are synthetic: authored from the gateway error contract
 * (@ai-sdk/gateway's `gatewayErrorResponseSchema`: `{ error: { message,
 * type, … } }`) and the LanguageModelV3 SSE wire shape, not recorded from
 * the live gateway (implementation agents hold no credentials). If the live
 * gateway's `no_providers_available` shape is ever recorded, replace the
 * fixture body and keep the test contract.
 */

import { type Cassette } from './cassette-store.js';
import { replayFromCassette } from './recording-fetch.js';

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function jsonErrorCassette(status: number, statusText: string, body: unknown): Cassette {
  return {
    version: 1,
    exchanges: [
      {
        status,
        statusText,
        headers: { 'content-type': 'application/json' },
        chunks: [base64(JSON.stringify(body))],
      },
    ],
    recordedAt: '2026-06-11T00:00:00.000Z',
  };
}

function sseChunk(part: unknown): string {
  return `data: ${JSON.stringify(part)}\n\n`;
}

/**
 * ZDR fail-closed shape: the gateway routes only to providers under a ZDR
 * agreement and reports `no_providers_available` when none qualify.
 */
const noProvidersAvailable: Cassette = jsonErrorCassette(503, 'Service Unavailable', {
  error: {
    message: 'No providers available for the requested model with Zero Data Retention enabled',
    type: 'no_providers_available',
  },
});

const rateLimited: Cassette = jsonErrorCassette(429, 'Too Many Requests', {
  error: {
    message: 'Rate limit exceeded, please try again later',
    type: 'rate_limit_exceeded',
  },
});

/**
 * A 200 SSE stream that dies mid-generation: text starts flowing, then the
 * stream closes without the provider's terminal `finish` part (and therefore
 * without the gateway generation metadata that carries `generationId`).
 */
const truncatedStream: Cassette = {
  version: 1,
  exchanges: [
    {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
      chunks: [
        base64(
          sseChunk({ type: 'stream-start', warnings: [] }) +
            sseChunk({
              type: 'response-metadata',
              id: 'resp-truncated',
              modelId: 'openai/gpt-4o',
            }) +
            sseChunk({ type: 'text-start', id: 'txt-1' }) +
            sseChunk({ type: 'text-delta', id: 'txt-1', delta: 'The answer is' })
        ),
      ],
    },
  ],
  recordedAt: '2026-06-11T00:00:00.000Z',
};

export const FAILURE_FIXTURES = {
  noProvidersAvailable,
  rateLimited,
  truncatedStream,
} as const;

/**
 * A fetch that replays the given cassette for every request — the failure
 * fixtures' injection point, sitting at the exact seam the recording fetch
 * occupies so the SDK exercises its real response handling.
 */
export function createFixtureFetch(cassette: Cassette): typeof globalThis.fetch {
  return function fixtureFetch(): Promise<Response> {
    return Promise.resolve(replayFromCassette(cassette));
  };
}
