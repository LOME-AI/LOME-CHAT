/**
 * SYNTHETIC OpenRouter catalog fixtures (same convention as the adapter's
 * failure fixtures): authored from OpenRouter's documented metadata format
 * for `/models`, `/endpoints/zdr`, `/images/models` (+ the N+1
 * `/images/models/{id}/endpoints`), and `/videos/models` — never recorded
 * from the live gateway (implementation agents hold no credentials, and
 * tests make zero real calls). If live recordings ever land, replace the
 * fixture bodies and keep the test contracts.
 */

export const TEST_GATEWAY_BASE_URL = 'https://openrouter.test/api/v1';

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A `/models` (language / multimodal) entry. */
export function modelEntryFixture(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'openai/gpt-test',
    name: 'GPT Test',
    description: 'A test model',
    created: 1_700_000_000,
    context_length: 128_000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.0000025', completion: '0.00001' },
    supported_parameters: ['temperature', 'top_p', 'max_output_tokens'],
    expiration_date: null,
    ...overrides,
  };
}

/** An `/images/models` entry. */
export function imageModelFixture(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'google/test-image',
    name: 'Test Image',
    created: 1_700_000_000,
    architecture: { input_modalities: ['text'], output_modalities: ['image'] },
    supported_parameters: {
      aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
      n: { type: 'range', min: 1, max: 4 },
    },
    supports_streaming: false,
    endpoints: `${TEST_GATEWAY_BASE_URL}/images/models/google/test-image/endpoints`,
    ...overrides,
  };
}

/** The N+1 `/images/models/{id}/endpoints` body: `{id, endpoints:[{pricing}]}`.
 * `cost_usd` is numeric on the wire; `billable` is a role string. */
export function imageEndpointsFixture(
  pricing: unknown[] = [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }]
): unknown {
  return { id: 'google/test-image', endpoints: [{ pricing }] };
}

/** A `/videos/models` entry. */
export function videoModelFixture(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'google/test-video',
    name: 'Test Video',
    created: 1_700_000_000,
    architecture: null,
    supported_parameters: null,
    supported_resolutions: ['720p', '1080p'],
    supported_aspect_ratios: ['16:9'],
    supported_durations: [4, 8],
    supported_frame_images: null,
    generate_audio: true,
    seed: true,
    pricing_skus: { duration_seconds_720p: '0.0988', duration_seconds_1080p: '0.15' },
    ...overrides,
  };
}

/** The `/endpoints/zdr` body from the reachable model ids. Endpoint-granular
 * in production (provider × model); the discovery reads only `model_id`. */
export function zdrBody(modelIds: readonly string[]): unknown {
  return { data: modelIds.map((id) => ({ model_id: id, provider_name: id })) };
}

export interface GatewayRouteTable {
  readonly models?: () => Response;
  readonly zdr?: () => Response;
  readonly images?: () => Response;
  readonly imageEndpoints?: (modelId: string) => Response;
  readonly videos?: () => Response;
}

const EMPTY_LIST = (): Response => jsonResponse({ data: [] });

// Match by URL pathname, ignoring any query string: the language `/models`
// fetch carries `?sort=top-weekly`, and routing on the full URL would miss it.
const pathOf = (url: string): string => new URL(url).pathname;

/** Routes fixture responses by URL shape across the four catalog endpoints.
 * Missing list routes default to an empty `{ data: [] }` so a test can
 * exercise one endpoint without stubbing the others. */
export function routedFetch(routes: GatewayRouteTable): typeof globalThis.fetch {
  const listRoutes: Record<string, () => Response> = {
    [pathOf(`${TEST_GATEWAY_BASE_URL}/models`)]: routes.models ?? EMPTY_LIST,
    [pathOf(`${TEST_GATEWAY_BASE_URL}/endpoints/zdr`)]: routes.zdr ?? EMPTY_LIST,
    [pathOf(`${TEST_GATEWAY_BASE_URL}/images/models`)]: routes.images ?? EMPTY_LIST,
    [pathOf(`${TEST_GATEWAY_BASE_URL}/videos/models`)]: routes.videos ?? EMPTY_LIST,
  };
  return function routed(input: RequestInfo | URL): Promise<Response> {
    const url = new Request(input).url;
    const pathname = pathOf(url);
    const endpointsMatch = /\/images\/models\/(.+)\/endpoints$/.exec(pathname);
    if (endpointsMatch?.[1] !== undefined) {
      return routes.imageEndpoints === undefined
        ? Promise.reject(new Error(`routedFetch: no imageEndpoints route for ${url}`))
        : Promise.resolve(routes.imageEndpoints(endpointsMatch[1]));
    }
    const listRoute = listRoutes[pathname];
    return listRoute === undefined
      ? Promise.reject(new Error(`routedFetch: unrouted URL ${url}`))
      : Promise.resolve(listRoute());
  };
}

export interface CatalogFixture {
  readonly models?: unknown[];
  readonly zdrModelIds?: readonly string[];
  readonly images?: unknown[];
  readonly imageEndpoints?: (modelId: string) => unknown;
  readonly videos?: unknown[];
}

/** Data-level convenience over `routedFetch`: build a catalog fetch from
 * model lists and the ZDR membership, defaulting every endpoint to empty. */
export function catalogFetch(fixture: CatalogFixture): typeof globalThis.fetch {
  return routedFetch({
    models: () => jsonResponse({ data: fixture.models ?? [] }),
    zdr: () => jsonResponse(zdrBody(fixture.zdrModelIds ?? [])),
    images: () => jsonResponse({ data: fixture.images ?? [] }),
    imageEndpoints: (id) => jsonResponse(fixture.imageEndpoints?.(id) ?? imageEndpointsFixture()),
    videos: () => jsonResponse({ data: fixture.videos ?? [] }),
  });
}
