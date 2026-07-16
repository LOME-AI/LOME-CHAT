import {
  adminOpExecuteResultSchema,
  adminOpPreviewResultSchema,
  type AdminOpExecuteResult,
  type AdminOpPreviewResult,
} from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';

// Both run responses are re-validated with the shared wire schemas (the web
// app's response re-validation mechanic) before anything renders from them.

/** Engine dry-run: same code path as execute, rolled back server-side. */
export async function previewOp(
  name: string,
  input: Record<string, unknown>
): Promise<AdminOpPreviewResult> {
  const raw = await fetchJson<unknown>(
    client.admin.ops[':name'].preview.$post({ param: { name }, json: { input } })
  );
  return adminOpPreviewResultSchema.parse(raw);
}

export interface ExecuteOpParams {
  readonly name: string;
  readonly input: Record<string, unknown>;
  /**
   * Minted once at form-submit time and reused for retries of that
   * submission, so a retried execute replays instead of double-applying.
   */
  readonly idempotencyKey: string;
  /** Audit row id being undone when this execute runs an inverse op. */
  readonly undoes?: string;
}

export async function executeOp(params: ExecuteOpParams): Promise<AdminOpExecuteResult> {
  const raw = await fetchJson<unknown>(
    client.admin.ops[':name'].execute.$post(
      {
        param: { name: params.name },
        json: {
          input: params.input,
          ...(params.undoes === undefined ? {} : { undoes: params.undoes }),
        },
      },
      { headers: { 'Idempotency-Key': params.idempotencyKey } }
    )
  );
  return adminOpExecuteResultSchema.parse(raw);
}
