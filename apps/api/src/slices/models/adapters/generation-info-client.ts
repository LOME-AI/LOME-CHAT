import { createGateway } from 'ai';
import { fromPromise } from '../../../lib/result/index.js';
import { notFoundError, rateLimitedError, unavailableError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { GenerationInfoClient, RawGenerationInfo } from '../ports/index.js';

/**
 * Raw per-generation cost/stats via the gateway's `/v1/generation` endpoint.
 * No retry here: the gateway 404s for a brief window after a generation
 * completes (usage events batch post-stream), and the caller's schedule —
 * inline true-up then the job system's backoff — is the one retry mechanism.
 */
export interface CreateGenerationInfoClientOptions {
  readonly apiKey: string;
  /** Cassette seam; production omits it and the SDK uses `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

function toDomainError(cause: unknown): DomainError {
  // Every rejection from the gateway SDK is a GatewayError object carrying a
  // numeric statusCode (base-class default 500) — network failures included,
  // since asGatewayError wraps them before they surface.
  const status = (cause as { statusCode?: number }).statusCode;
  if (status === 404) {
    return notFoundError('Generation not yet visible on the gateway', cause);
  }
  if (status === 429) {
    return rateLimitedError('Gateway rate limit exceeded', cause);
  }
  return unavailableError('Generation info fetch failed', cause);
}

export function createGenerationInfoClient(
  options: CreateGenerationInfoClientOptions
): GenerationInfoClient {
  const gateway = createGateway({
    apiKey: options.apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    fetchGenerationInfo(generationId: string): ResultAsync<RawGenerationInfo, DomainError> {
      return fromPromise(gateway.getGenerationInfo({ id: generationId }), toDomainError).map(
        (info): RawGenerationInfo => ({
          generationId: info.id,
          totalCostUsd: info.totalCost,
          raw: { ...info },
        })
      );
    },
  };
}
