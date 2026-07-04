import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * Billing's true-up seam: the gateway's authoritative per-generation cost.
 * Structurally compatible with the models slice's GenerationInfoClient (the
 * composition root binds that adapter here); declared as billing's own port
 * so the true-up domain depends only on this slice. Retry lives with the
 * true-up job's backoff, never inside the client.
 */
export interface GenerationCostClient {
  fetchGenerationInfo(generationId: string): ResultAsync<
    {
      readonly generationId: string;
      readonly totalCostUsd: number;
    },
    DomainError
  >;
}
