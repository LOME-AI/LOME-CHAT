/**
 * The closed allowlist of structured-log field names.
 * Redaction-by-default: user content is unrepresentable because no field name
 * here can carry it — there is deliberately no message/prompt/content/body/
 * text field, and additions must survive the never-log list (message content,
 * prompts, outputs, keys, ciphertext, PII, request/response bodies).
 *
 * The compile-time layer (this type + `ExactSafeLogFields`) rejects unknown
 * keys; `pickSafeLogFields` is the runtime scrub for callers that arrive
 * through casts or plain JS. Both layers are required: the redaction regex
 * lint is advisory only — the typed logger plus port-side scrubbing are the
 * real mechanisms.
 */

export const SAFE_LOG_FIELD_KEYS = [
  'requestId',
  'userId',
  'conversationId',
  'runId',
  'jobId',
  'route',
  'method',
  'statusCode',
  'latencyMs',
  'modelName',
  'inputTokens',
  'outputTokens',
  'costUsd',
  'errorCode',
  'jobType',
  'attempt',
] as const;

export type SafeLogFieldKey = (typeof SAFE_LOG_FIELD_KEYS)[number];

export interface SafeLogFields {
  readonly requestId?: string;
  readonly userId?: string;
  readonly conversationId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  // The matched route TEMPLATE (`/conversations/:id`), never the concrete
  // URL — query strings and path tokens would leak content.
  readonly route?: string;
  readonly method?: string;
  readonly statusCode?: number;
  readonly latencyMs?: number;
  readonly modelName?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  // Observability dimension only (WAE-style double), never settlement math —
  // ledger money stays nano-USD bigint per the money doctrine.
  readonly costUsd?: number;
  readonly errorCode?: string;
  readonly jobType?: string;
  readonly attempt?: number;
}

/**
 * Exact-object constraint for logger `fields` parameters: any key of F that
 * is not an allowlisted field types as `never`, so excess keys fail to
 * compile even when the argument is a pre-built variable (where TS's literal
 * excess-property check would not fire).
 */
export type ExactSafeLogFields<F extends SafeLogFields> = F &
  Readonly<Record<Exclude<keyof F, keyof SafeLogFields>, never>>;

/**
 * Runtime allowlist scrub applied at emission: keeps only allowlisted keys
 * whose values are primitives (string/number). Objects, arrays, and anything
 * smuggled past the types via a cast are dropped — a string can still carry
 * content, but that is the compile-time and lint layers' job; the runtime
 * layer guarantees shape, not semantics.
 */
export function pickSafeLogFields(
  fields: SafeLogFields
): Partial<Record<SafeLogFieldKey, string | number>> {
  const picked: Partial<Record<SafeLogFieldKey, string | number>> = {};
  for (const key of SAFE_LOG_FIELD_KEYS) {
    // Typed as string | number | undefined, but runtime callers arriving
    // through casts can put anything here — hence the typeof check below.
    const value: unknown = fields[key];
    if (typeof value === 'string' || typeof value === 'number') {
      picked[key] = value;
    }
  }
  return picked;
}
