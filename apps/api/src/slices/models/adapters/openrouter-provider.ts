import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { OpenRouterProvider } from '@openrouter/ai-sdk-provider';

/**
 * OpenRouter's single API base URL. Inference (chat/images/videos) and the
 * catalog endpoints all share it, and it never varies by environment — so it
 * is a code constant here, not an env var. The API key is injected (from
 * `OPENROUTER_API_KEY` via the caller's DI), never read from `process.env`.
 */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface CreateOpenRouterOptions {
  readonly apiKey: string;
  /**
   * The cassette/fixture seam — tests inject a wrapped fetch here so calls
   * record/replay uniformly. Production omits it and the SDK uses
   * `globalThis.fetch`.
   */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The single provider-construction seam for the model adapters. `compatibility:
 * 'strict'` keeps the request body on the newer OpenRouter surface (usage
 * accounting, streamed usage) rather than the lowest-common OpenAI subset.
 */
export function createOpenRouterProvider(options: CreateOpenRouterOptions): OpenRouterProvider {
  return createOpenRouter({
    apiKey: options.apiKey,
    baseURL: OPENROUTER_BASE_URL,
    compatibility: 'strict',
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
