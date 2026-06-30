/**
 * SYNTHETIC gateway metadata fixtures (same convention as the adapter's
 * failure fixtures): authored from the gateway's documented metadata format
 * — @ai-sdk/gateway's `GatewayFetchMetadataResponse` for the model list,
 * the synthetic-contract per-model endpoints shape for tier 2 — never
 * recorded from the live gateway (implementation agents hold no
 * credentials, and tests make zero real calls). If live recordings ever
 * land, replace the fixture bodies and keep the test contracts.
 */

export const TEST_GATEWAY_BASE_URL = 'https://gateway.test/v3/ai';

export function configFixture(models: unknown[], zdrProviders?: string[]): unknown {
  return {
    models,
    ...(zdrProviders === undefined ? {} : { zdrProviders }),
  };
}

export function modelEntryFixture(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'openai/gpt-test',
    name: 'GPT Test',
    description: 'A test model',
    pricing: { input: '0.0000025', output: '0.00001' },
    specification: {
      specificationVersion: 'v3',
      provider: 'openai',
      modelId: 'openai/gpt-test',
    },
    modelType: 'language',
    ...overrides,
  };
}

export function endpointsFixture(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['temperature', 'top_p', 'max_output_tokens'],
      context_length: 128_000,
      endpoints: [{ provider: 'openai' }],
      ...overrides,
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface GatewayRouteTable {
  readonly config: () => Response;
  readonly endpoints?: (modelId: string) => Response;
}

/** Routes fixture responses by URL shape: /config or /models/{id}/endpoints. */
export function routedFetch(routes: GatewayRouteTable): typeof globalThis.fetch {
  return function routed(input: RequestInfo | URL): Promise<Response> {
    const url = new Request(input).url;
    if (url === `${TEST_GATEWAY_BASE_URL}/config`) return Promise.resolve(routes.config());
    const match = /\/models\/(.+)\/endpoints$/.exec(url);
    if (match?.[1] !== undefined && routes.endpoints !== undefined) {
      return Promise.resolve(routes.endpoints(match[1]));
    }
    return Promise.reject(new Error(`routedFetch: unrouted URL ${url}`));
  };
}
