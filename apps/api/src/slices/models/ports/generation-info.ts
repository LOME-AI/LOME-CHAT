import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The gateway's authoritative per-generation record. `totalCostUsd` is the
 * gateway's float-USD billing truth — conversion to nano-USD happens at the
 * billing seam, never here. `raw` passes the full record through for stats.
 */
export interface RawGenerationInfo {
  readonly generationId: string;
  readonly totalCostUsd: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * Raw per-generation cost/stats fetch. Deliberately retry-free: the true-up
 * flow (billing slice) owns retry via its job backoff — a second retry
 * mechanism here would be a backup mechanism. The endpoint 404s for a brief
 * window after a generation completes (gateway eventual consistency); that
 * surfaces as `not_found` for the caller's schedule to absorb.
 */
export interface GenerationInfoClient {
  fetchGenerationInfo(generationId: string): ResultAsync<RawGenerationInfo, DomainError>;
}
