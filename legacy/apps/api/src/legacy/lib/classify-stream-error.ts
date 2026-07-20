/**
 * Classify a stream error into the API error code that surfaces to the client.
 *
 * Context-length failures get their dedicated code so the frontend can render a
 * targeted message; ForkTipConflict and unique-violation surface as their own
 * codes; rate-limit, content-policy, provider-billing, and network errors get
 * targeted codes so the UI can suggest the right next action; AI SDK errors
 * with no other specific bucket fall to ERROR_CODE_INFERENCE_FAILED;
 * non-AI-SDK errors fall to ERROR_CODE_STREAM_ERROR.
 *
 * Lives in its own module so both `stream-pipeline.ts` (the orchestrator) and
 * `multi-stream.ts` (the per-model collector) can import without a cycle.
 */

import {
  ERROR_CODE_CONTENT_POLICY,
  ERROR_CODE_CONTEXT_LENGTH_EXCEEDED,
  ERROR_CODE_DUPLICATE_MESSAGE,
  ERROR_CODE_FORK_TIP_CONFLICT,
  ERROR_CODE_INFERENCE_FAILED,
  ERROR_CODE_NETWORK_ERROR,
  ERROR_CODE_PROVIDER_BILLING,
  ERROR_CODE_RATE_LIMITED,
  ERROR_CODE_STREAM_ERROR,
} from '@hushbox/shared';
import { isUniqueViolation } from './unique-violation.js';

function extractStatusCode(error: Error): number | undefined {
  const candidates: unknown[] = [
    (error as { status?: unknown }).status,
    (error as { statusCode?: unknown }).statusCode,
    (error as { response?: { status?: unknown } }).response?.status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function isRateLimitError(error: Error, status: number | undefined): boolean {
  if (status === 429) return true;
  const message = error.message.toLowerCase();
  return message.includes('rate limit') || message.includes('429');
}

function isContentPolicyError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('content policy') ||
    message.includes('safety') ||
    message.includes('moderation') ||
    message.includes('harmful')
  );
}

function isProviderBillingError(error: Error, status: number | undefined): boolean {
  if (status === 401 || status === 402 || status === 403) return true;
  const message = error.message.toLowerCase();
  return message.includes('insufficient credits');
}

function isNetworkError(error: Error): boolean {
  if (error.name === 'AbortError') return true;
  if (error instanceof TypeError && error.message.toLowerCase().includes('fetch failed')) {
    return true;
  }
  // Node 'fetch failed' surfaces as a TypeError (instanceof check above) but
  // some shims rethrow as a plain Error — match the literal message too.
  return error.message.toLowerCase().includes('fetch failed');
}

/**
 * Vercel AI SDK error classes prefix `name` with `AI_` (e.g.
 * `AI_APICallError`, `AI_RetryError`). The base SDK error class itself is
 * `AISDKError`. Anything matching this convention came from the gateway / SDK
 * layer and represents a true inference failure rather than a transport bug
 * in our own code.
 */
function isAiSdkError(error: Error): boolean {
  return error.name.startsWith('AI_') || error.name === 'AISDKError';
}

export function classifyStreamErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return ERROR_CODE_STREAM_ERROR;
  if (error.message.includes('context length')) return ERROR_CODE_CONTEXT_LENGTH_EXCEEDED;
  if (error.name === 'ForkTipConflictError') return ERROR_CODE_FORK_TIP_CONFLICT;
  if (isUniqueViolation(error)) return ERROR_CODE_DUPLICATE_MESSAGE;

  const status = extractStatusCode(error);
  if (isRateLimitError(error, status)) return ERROR_CODE_RATE_LIMITED;
  if (isContentPolicyError(error)) return ERROR_CODE_CONTENT_POLICY;
  if (isProviderBillingError(error, status)) return ERROR_CODE_PROVIDER_BILLING;
  if (isNetworkError(error)) return ERROR_CODE_NETWORK_ERROR;

  // AI SDK errors that didn't classify into one of the specific buckets above
  // surface as INFERENCE_FAILED so the UI can offer "try a different model"
  // rather than the generic stream-error bucket. Plain non-SDK Errors stay on
  // STREAM_ERROR as the last-resort catch-all.
  if (isAiSdkError(error)) return ERROR_CODE_INFERENCE_FAILED;

  return ERROR_CODE_STREAM_ERROR;
}
