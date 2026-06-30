import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import { createMockAIClient } from './mock.js';
import { createRealAIClient } from './real.js';
import { requireCatalogConfig, requireInferenceConfig } from '../../lib/gateway-config.js';
import type { AIClient, MockAIClientConfig } from './types.js';
import type { EvidenceConfig } from '@hushbox/db';
import type { Bindings } from '../../types.js';

export type {
  AIClient,
  AIMessage,
  AudioRequest,
  ImageRequest,
  InferenceEvent,
  InferenceRequest,
  InferenceStream,
  MessageContentPart,
  MockAIClient,
  MockAIClientConfig,
  Modality,
  ModelCapability,
  ModelInfo,
  ModelPricing,
  ProviderMetadata,
  RecordedInferenceRequest,
  TextRequest,
  ToolDefinition,
  VideoRequest,
} from './types.js';

export { createMockAIClient } from './mock.js';

interface AIClientEnv extends EnvContext {
  AI_GATEWAY_API_KEY?: string;
  PUBLIC_MODELS_URL?: string;
}

/**
 * Optional evidence-recording config bundle. When supplied, the real AI client
 * records `SERVICE_NAMES.AI_GATEWAY` evidence after each successful gateway
 * call so CI integration tests can verify the integration ran.
 *
 * `mockConfig` carries per-request mock overrides decoded from `x-mock-*`
 * request headers; only consulted in dev / E2E builds.
 */
export interface AIClientOptions {
  evidence?: EvidenceConfig;
  mockConfig?: MockAIClientConfig;
  /**
   * Optional fetch implementation. The HTTP cassette layer passes a recording
   * fetch here for CI integration tests; production omits this and the SDK
   * uses `globalThis.fetch`. Ignored by the mock client.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Wall-clock delay the mock inserts between an image / video / audio
 * generation's `media-start` and `media-done` on a real local dev server, so
 * the "Generating…" placeholder (and its latent-develop animation) is visible
 * instead of resolving instantly. Long enough to show a full animation cycle;
 * video additionally shows the leading edge of the synthetic progress sweep.
 */
export const LOCAL_DEV_MEDIA_DELAY_MS = 3000;

/** Echo-typewriter inter-chunk delay on a real dev server (visible streaming). */
const LOCAL_DEV_TEXT_DELAY_MS = 60;

/**
 * Pre-inference classifier delay on a real dev server so the "Choosing the best
 * model…" indicator paints; zero in tests (E2E gates on the stage-count signal).
 */
const LOCAL_DEV_CLASSIFIER_DELAY_MS = 1000;

/**
 * Assemble the mock client config. The echo typewriter (`textDelayMs`), the
 * media-generation placeholder (`mediaDelayMs`), and the classifier indicator
 * delay (`classifierDelayMs`) are human-facing dev affordances, so they fire
 * only on a real dev server (`isDevServer` — never under vitest, E2E, CI, or
 * production). Per-request `x-mock-*` overrides on `options.mockConfig` win when
 * present.
 */
export function buildMockConfig(
  options: AIClientOptions,
  isDevServer: boolean
): MockAIClientConfig {
  return {
    ...options.mockConfig,
    textDelayMs: options.mockConfig?.textDelayMs ?? (isDevServer ? LOCAL_DEV_TEXT_DELAY_MS : 0),
    mediaDelayMs: options.mockConfig?.mediaDelayMs ?? (isDevServer ? LOCAL_DEV_MEDIA_DELAY_MS : 0),
    classifierDelayMs:
      options.mockConfig?.classifierDelayMs ?? (isDevServer ? LOCAL_DEV_CLASSIFIER_DELAY_MS : 0),
  };
}

/**
 * Get the appropriate AIClient based on environment.
 *
 * - Local dev / E2E: Returns a fresh mock client configured from
 *   `options.mockConfig` (sourced from request headers). Stateless — no
 *   module cache, no cross-request bleed.
 * - CI integration / production: Returns the real client. Requires real
 *   credentials; fails fast if missing. Evidence recording optional.
 */
export function getAIClient(env: AIClientEnv, options: AIClientOptions = {}): AIClient {
  const { isLocalDev, isE2E, isDevServer } = createEnvUtilities(env);

  if (isLocalDev || isE2E) {
    // E2E pins the catalog to a committed fixture so no run touches the live
    // public `/v1/models` endpoint. Plain local dev keeps the live fetch.
    return createMockAIClient(buildMockConfig(options, isDevServer), {
      useFixtureCatalog: isE2E,
    });
  }

  return createRealAIClient({
    ...requireInferenceConfig(env as Bindings),
    ...requireCatalogConfig(env as Bindings),
    ...(options.evidence !== undefined && { evidence: options.evidence }),
    ...(options.fetch !== undefined && { fetch: options.fetch }),
  });
}
