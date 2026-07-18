import {
  adminOpExecuteResultSchema,
  adminOpPrefillResultSchema,
  adminOpPreviewResultSchema,
  type AdminOpExecuteResult,
  type AdminOpPreviewResult,
} from '@hushbox/shared';
import { ADMIN_API_BASE, adminFetch, client, fetchJson } from '@/lib/api-client';

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

/**
 * Blind prefill probe fired when an op form opens. Every failure — 404 (no
 * prefill for this op), network error, malformed body — means "open blank":
 * null, no notice, no retry (there is no catalog flag advertising prefill).
 * That is why it rides the raw wrapped fetch instead of `fetchJson`, whose
 * throw-on-failure unwrap would make silence the exceptional path. `reason`
 * is stripped defensively whatever the server sent — the operator always
 * types it.
 */
export async function prefillOp(name: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await adminFetch(
      `${ADMIN_API_BASE}/admin/ops/${encodeURIComponent(name)}/prefill`,
      { credentials: 'include' }
    );
    if (!res.ok) {
      return null;
    }
    const parsed = adminOpPrefillResultSchema.safeParse(await res.json());
    if (!parsed.success) {
      return null;
    }
    return Object.fromEntries(
      Object.entries(parsed.data.input).filter(([field]) => field !== 'reason')
    );
  } catch {
    return null;
  }
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
