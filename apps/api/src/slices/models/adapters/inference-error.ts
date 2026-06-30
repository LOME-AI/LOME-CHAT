/**
 * Typed inference errors for the ModelProvider adapters.
 *
 * The port's stream has no error event variant — failures travel as thrown
 * `InferenceError`s carrying a closed code set. Classifications built from an
 * Error-shaped provider/SDK failure preserve it on `cause` (an Error's
 * `name`/`status` must survive classification); a string stream-error payload
 * is interpolated into the message rather than attached as cause;
 * locally-synthesized failures — aborts, truncation, empty completions,
 * invalid requests — carry no cause. Messages carry codes and shapes, never
 * content.
 */

import { z } from 'zod';

export const INFERENCE_ERROR_CODES = [
  'invalid_request',
  'no_providers_available',
  'rate_limited',
  'aborted',
  'truncated_stream',
  'empty_completion',
  'upstream_error',
] as const;

export type InferenceErrorCode = (typeof INFERENCE_ERROR_CODES)[number];

export class InferenceError extends Error {
  readonly code: InferenceErrorCode;

  constructor(code: InferenceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InferenceError';
    this.code = code;
  }
}

export function abortedError(reason?: string): InferenceError {
  return new InferenceError(
    'aborted',
    reason === undefined ? 'Inference aborted' : `Inference aborted: ${reason}`
  );
}

export function truncatedStreamError(): InferenceError {
  return new InferenceError(
    'truncated_stream',
    'Stream ended without the provider finish part or its gateway generation metadata'
  );
}

export function emptyCompletionError(finishReason?: string): InferenceError {
  return new InferenceError(
    'empty_completion',
    `Model produced no output (finishReason: ${finishReason ?? 'unknown'})`
  );
}

export function invalidRequestError(message: string): InferenceError {
  return new InferenceError('invalid_request', message);
}

/** The gateway's error body contract (@ai-sdk/gateway gatewayErrorResponseSchema). */
const gatewayErrorBodySchema = z.looseObject({
  error: z.looseObject({
    type: z.string().nullish(),
  }),
});

function gatewayErrorType(candidate: unknown): string | undefined {
  const parsed = gatewayErrorBodySchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  return parsed.data.error.type ?? undefined;
}

/**
 * Pull the gateway error body off an SDK error. APICallError carries the
 * parsed body on `data`; some wrappers only retain the raw `responseBody`
 * text.
 */
function errorBodyType(error: object): string | undefined {
  const data = (error as { data?: unknown }).data;
  const fromData = gatewayErrorType(data);
  if (fromData !== undefined) return fromData;
  const responseBody = (error as { responseBody?: unknown }).responseBody;
  if (typeof responseBody !== 'string') return undefined;
  try {
    return gatewayErrorType(JSON.parse(responseBody));
  } catch {
    return undefined;
  }
}

function statusCodeOf(error: object): number | undefined {
  const candidates: unknown[] = [
    (error as { statusCode?: unknown }).statusCode,
    (error as { status?: unknown }).status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

interface ChainFacts {
  aborted: boolean;
  status: number | undefined;
  bodyType: string | undefined;
  message: string | undefined;
}

/** Walk the error and its `cause` chain, keeping the first fact of each kind. */
function collectChainFacts(value: unknown): ChainFacts {
  const facts: ChainFacts = {
    aborted: false,
    status: undefined,
    bodyType: undefined,
    message: undefined,
  };
  let current: unknown = value;
  // Bounded walk: a pathological self-referencing cause chain must not spin.
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth++) {
    if (current instanceof Error) {
      if (current.name === 'AbortError') facts.aborted = true;
      facts.message ??= current.message;
    }
    facts.status ??= statusCodeOf(current);
    facts.bodyType ??= errorBodyType(current);
    current = (current as { cause?: unknown }).cause;
  }
  return facts;
}

/**
 * Classify any failure surfaced by the SDK (a fullStream `error` part payload
 * or a thrown iteration error) into a typed InferenceError.
 */
export function classifyInferenceFailure(value: unknown): InferenceError {
  if (value instanceof InferenceError) return value;

  const facts = collectChainFacts(value);
  if (facts.aborted) return abortedError();
  if (facts.bodyType === 'no_providers_available') {
    return new InferenceError(
      'no_providers_available',
      'Gateway reported no providers available for the request',
      { cause: value }
    );
  }
  if (facts.bodyType === 'rate_limit_exceeded' || facts.status === 429) {
    return new InferenceError('rate_limited', 'Gateway rate limit exceeded', { cause: value });
  }
  if (typeof value === 'string') {
    return new InferenceError('upstream_error', `Inference stream error: ${value}`);
  }
  const detail = facts.message === undefined ? '' : `: ${facts.message}`;
  return new InferenceError('upstream_error', `Inference stream error${detail}`, { cause: value });
}
