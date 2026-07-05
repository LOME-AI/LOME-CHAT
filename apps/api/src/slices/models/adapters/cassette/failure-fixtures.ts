/**
 * Hand-curated synthetic failure cassettes. Live 4xx/5xx responses are
 * deliberately never recorded, so error paths could never replay — these
 * fixtures make error handling deterministic by injecting at the same fetch
 * seam the cassette harness uses (the SDK's `fetch` option).
 *
 * ALL fixtures are synthetic: authored from OpenRouter's error envelope
 * (`{ error: { code, message, type?, metadata? } }`) and its OpenAI-compatible
 * chat SSE wire, not recorded from the live provider (implementation agents
 * hold no credentials). If a live shape is ever recorded, replace the fixture
 * body and keep the test contract.
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
    recordedAt: '2026-07-04T00:00:00.000Z',
  };
}

function sseChunk(part: unknown): string {
  return `data: ${JSON.stringify(part)}\n\n`;
}

/**
 * ZDR fail-closed shape: OpenRouter refuses a request that cannot route to a
 * ZDR-eligible endpoint with a logical 404 guardrail error.
 */
const noProvidersAvailable: Cassette = jsonErrorCassette(404, 'Not Found', {
  error: {
    code: 404,
    message: 'No endpoints available matching your guardrail restrictions and data policy',
  },
});

const rateLimited: Cassette = jsonErrorCassette(429, 'Too Many Requests', {
  error: { code: 429, message: 'Rate limit exceeded, please try again later' },
});

/**
 * A 200 SSE stream that fails mid-generation: a text delta flows, then an
 * OpenRouter error chunk (`{ error: … }`) lands — the mid-stream error part the
 * SDK surfaces with `finishReason: 'error'`.
 */
const midStreamError: Cassette = {
  version: 1,
  exchanges: [
    {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
      chunks: [
        base64(
          sseChunk({
            id: 'gen-mid-error',
            provider: 'openai',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'The answer is' } }],
          }) + sseChunk({ error: { code: 503, message: 'Upstream provider unavailable' } })
        ),
      ],
    },
  ],
  recordedAt: '2026-07-04T00:00:00.000Z',
};

export const FAILURE_FIXTURES = {
  noProvidersAvailable,
  rateLimited,
  midStreamError,
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
