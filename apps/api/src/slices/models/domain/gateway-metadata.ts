import { z } from 'zod';
import { unavailableError, validationError } from '../../../lib/errors/index.js';
import { ResultAsync, errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * Two-tier gateway metadata fetch.
 *
 * Tier 1 is the gateway's model-list endpoint (`{baseUrl}/config`, the shape
 * behind @ai-sdk/gateway's `getAvailableModels`). Tier 2 is the per-model
 * `/endpoints` detail carrying modalities, supported parameters, and the
 * serving providers — an N+1 bounded to the platform's six-connection cap.
 *
 * SYNTHETIC-CONTRACT NOTE (same convention as the adapter failure
 * fixtures): implementation agents hold no gateway credentials, so the
 * tier-2 response shape and the tier-1 `zdrProviders` field are authored
 * from the documented metadata format, not recorded from the live gateway.
 * When real recordings land, revise the wire schemas here — the typed
 * `GatewayCatalog` seam consumed by normalization stays.
 */

const gatewayModelEntrySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().nullish(),
  pricing: z
    .looseObject({
      input: z.string().optional(),
      output: z.string().optional(),
      cachedInputTokens: z.string().optional(),
    })
    .nullish(),
  specification: z.looseObject({ provider: z.string().min(1) }),
  modelType: z.string().nullish(),
});

const gatewayConfigResponseSchema = z.looseObject({
  models: z.array(gatewayModelEntrySchema),
  /** The gateway's ZDR provider list. Absent ⇒ empty ⇒ nothing reachable. */
  zdrProviders: z.array(z.string()).optional(),
});

const gatewayEndpointsResponseSchema = z.looseObject({
  data: z.looseObject({
    architecture: z
      .looseObject({
        input_modalities: z.array(z.string()),
        output_modalities: z.array(z.string()),
      })
      .optional(),
    supported_parameters: z.array(z.string()).optional(),
    context_length: z.number().optional(),
    endpoints: z.array(z.looseObject({ provider: z.string().min(1) })).optional(),
  }),
});

/** Token rates as decimal USD strings, exactly as the gateway reports them. */
export interface GatewayTokenPricing {
  readonly input?: string | undefined;
  readonly output?: string | undefined;
  readonly cachedInputTokens?: string | undefined;
}

/** One model's merged tier-1 + tier-2 metadata. */
export interface GatewayModelMetadata {
  readonly id: string;
  readonly provider: string;
  readonly modelType: string | undefined;
  readonly pricing: GatewayTokenPricing | undefined;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly supportedParameters: readonly string[];
  readonly contextLength: number | undefined;
  readonly endpointProviders: readonly string[];
}

export interface GatewayCatalog {
  readonly models: readonly GatewayModelMetadata[];
  readonly zdrProviders: ReadonlySet<string>;
}

export interface FetchGatewayCatalogOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}

/** Cloudflare Workers allow six simultaneous outbound connections per
 * invocation; the tier-2 fan-out batches to that cap. */
const ENDPOINT_FETCH_CONCURRENCY = 6;

function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  what: 'gateway model list' | 'gateway model endpoints'
): ResultAsync<unknown, DomainError> {
  return fromPromise(fetchImpl(url), (cause) =>
    unavailableError(`${what} fetch failed`, cause)
  ).andThen((response) => {
    if (!response.ok) {
      return errAsync<unknown, DomainError>(
        unavailableError(`${what} returned HTTP ${String(response.status)}`)
      );
    }
    return fromPromise(response.json(), (cause) =>
      validationError(`${what} returned a non-JSON body`, cause)
    );
  });
}

type GatewayModelEntry = z.infer<typeof gatewayModelEntrySchema>;

function mergeModelMetadata(
  entry: GatewayModelEntry,
  endpointsBody: unknown
): GatewayModelMetadata {
  const parsed = gatewayEndpointsResponseSchema.parse(endpointsBody);
  const detail = parsed.data;
  return {
    id: entry.id,
    provider: entry.specification.provider,
    modelType: entry.modelType ?? undefined,
    pricing: entry.pricing ?? undefined,
    inputModalities: detail.architecture?.input_modalities ?? [],
    outputModalities: detail.architecture?.output_modalities ?? [],
    supportedParameters: detail.supported_parameters ?? [],
    contextLength: detail.context_length,
    endpointProviders: (detail.endpoints ?? []).map((endpoint) => endpoint.provider),
  };
}

function fetchModelMetadata(
  options: FetchGatewayCatalogOptions,
  entry: GatewayModelEntry
): ResultAsync<GatewayModelMetadata, DomainError> {
  const url = `${options.baseUrl}/models/${entry.id}/endpoints`;
  return fetchJson(options.fetch, url, 'gateway model endpoints').andThen((body) => {
    try {
      return okAsync<GatewayModelMetadata, DomainError>(mergeModelMetadata(entry, body));
    } catch (error) {
      return errAsync<GatewayModelMetadata, DomainError>(
        validationError('gateway model endpoints schema drift', error)
      );
    }
  });
}

function fetchAllModelMetadata(
  options: FetchGatewayCatalogOptions,
  entries: readonly GatewayModelEntry[]
): ResultAsync<GatewayModelMetadata[], DomainError> {
  const chunks: GatewayModelEntry[][] = [];
  for (let index = 0; index < entries.length; index += ENDPOINT_FETCH_CONCURRENCY) {
    chunks.push(entries.slice(index, index + ENDPOINT_FETCH_CONCURRENCY));
  }
  let chain: ResultAsync<GatewayModelMetadata[], DomainError> = okAsync([]);
  for (const chunk of chunks) {
    chain = chain.andThen((collected) =>
      ResultAsync.combine(chunk.map((entry) => fetchModelMetadata(options, entry))).map((batch) => [
        ...collected,
        ...batch,
      ])
    );
  }
  return chain;
}

export function fetchGatewayCatalog(
  options: FetchGatewayCatalogOptions
): ResultAsync<GatewayCatalog, DomainError> {
  return fetchJson(options.fetch, `${options.baseUrl}/config`, 'gateway model list').andThen(
    (body) => {
      const parsed = gatewayConfigResponseSchema.safeParse(body);
      if (!parsed.success) {
        return errAsync<GatewayCatalog, DomainError>(
          validationError('gateway model list schema drift', parsed.error)
        );
      }
      const zdrProviders: ReadonlySet<string> = new Set(parsed.data.zdrProviders);
      return fetchAllModelMetadata(options, parsed.data.models).map((models) => ({
        models,
        zdrProviders,
      }));
    }
  );
}
