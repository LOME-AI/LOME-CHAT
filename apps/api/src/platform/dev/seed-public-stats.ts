import { usageRecords } from '@hushbox/db';
import type { Modality } from '@hushbox/shared';
import type { SeedBillingDeps } from './seed-billing-history.js';

/**
 * Dev-only producer for the public /stats page: anonymous, backdated
 * `usage_records` rows with NO user/wallet/conversation/content linkage and
 * deliberately no ledger legs — the public-stats aggregation reads
 * `usage_records` alone, and a charge leg pair would require a wallet these
 * user-less rows don't have. Idempotency rides the caller-supplied stable key
 * (unique `idempotency_key`), so a re-run inserts nothing.
 */

/** One anonymous public-stats usage record, backdated. */
export interface PublicUsageRecordSpec {
  /** Stable arbitration key: the row's idempotency key derives from it. */
  readonly stableKey: string;
  readonly modelId: string;
  readonly providerName: string;
  readonly modality: Modality;
  readonly costNanoUsd: bigint;
  /** Defaults to false (text/video inline-cost semantics); image seeds pass true. */
  readonly isEstimated?: boolean;
  /** Backdated timestamp stamped on the usage record. */
  readonly createdAt: Date;
}

export interface SeedPublicUsageRecordsParams {
  readonly records: readonly PublicUsageRecordSpec[];
}

export interface SeedPublicUsageRecordsResult {
  /** Usage records actually inserted (0 on a full idempotent re-run). */
  readonly usageRecordsCreated: number;
}

export async function seedPublicUsageRecords(
  deps: SeedBillingDeps,
  params: SeedPublicUsageRecordsParams
): Promise<SeedPublicUsageRecordsResult> {
  if (params.records.length === 0) return { usageRecordsCreated: 0 };
  const inserted = await deps.db
    .insert(usageRecords)
    .values(
      params.records.map((spec) => ({
        payerUserId: null,
        contentItemId: null,
        conversationId: null,
        runId: crypto.randomUUID(),
        modelId: spec.modelId,
        providerName: spec.providerName,
        modality: spec.modality,
        costNanoUsd: spec.costNanoUsd,
        isEstimated: spec.isEstimated ?? false,
        idempotencyKey: `seed:public-usage:${spec.stableKey}`,
        createdAt: spec.createdAt,
      }))
    )
    .onConflictDoNothing({ target: usageRecords.idempotencyKey })
    .returning({ id: usageRecords.id });
  return { usageRecordsCreated: inserted.length };
}
