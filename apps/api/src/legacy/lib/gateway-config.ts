import type { Bindings } from '../types.js';

/**
 * Resolve the unauthenticated catalog endpoint from env bindings or fail-fast.
 *
 * `PUBLIC_MODELS_URL` powers `fetchModels` — the only catalog source. Routes
 * that need the catalog call this and let a missing-config error bubble out
 * as a 500; silent fallbacks would let a misconfigured deployment serve an
 * empty model list.
 */
export function requireCatalogConfig(env: Bindings): { publicModelsUrl: string } {
  if (!env.PUBLIC_MODELS_URL) throw new Error('PUBLIC_MODELS_URL required');
  return { publicModelsUrl: env.PUBLIC_MODELS_URL };
}

/**
 * Resolve the authenticated inference key from env bindings or fail-fast.
 *
 * `AI_GATEWAY_API_KEY` is required for inference (`streamText`, `generateImage`,
 * `experimental_generateVideo`, `getGenerationInfo`). The catalog path no
 * longer reads it.
 */
export function requireInferenceConfig(env: Bindings): { apiKey: string } {
  if (!env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY required');
  return { apiKey: env.AI_GATEWAY_API_KEY };
}
