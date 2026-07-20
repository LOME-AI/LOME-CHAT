/**
 * `unicorn/prefer-export-from` requires `export type … from` for re-exports;
 * we also need `RawModel` in this file's local scope for the AIClient
 * declarations below, so pair the re-export with a separate type import.
 */
export type { RawModel } from '@hushbox/shared/models';
import type {
  ImageAspectRatio,
  RawModel,
  VideoAspectRatio,
  VideoResolution,
} from '@hushbox/shared/models';
import type { ModelViewFor } from './model-view.js';

/** Content modality discriminator. */
export type Modality = 'text' | 'image' | 'audio' | 'video';

/** Capability tag advertised by a model (beyond its base modality). */
export type ModelCapability = 'aspect-ratio' | 'duration';

export type ModelPricing =
  | { kind: 'token'; inputPerToken: number; outputPerToken: number; webSearchPerCall?: number }
  | { kind: 'image'; perImage: number }
  | { kind: 'audio'; perSecond: number }
  | { kind: 'video'; perSecondByResolution: Record<string, number> };

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  modality: Modality;
  description: string;
  contextLength?: number;
  pricing: ModelPricing;
  capabilities: ModelCapability[];
  isZdr: boolean;
  created?: number;
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContentPart[];
}

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: Uint8Array; mimeType: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface TextRequest {
  modality: 'text';
  model: string;
  messages: AIMessage[];
  maxOutputTokens?: number;
  webSearchEnabled?: boolean;
}

export interface ImageRequest {
  modality: 'image';
  model: string;
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  size?: string;
  n?: number;
}

export interface AudioRequest {
  modality: 'audio';
  model: string;
  prompt: string;
  voice?: string;
  format?: 'mp3' | 'wav' | 'ogg';
}

export interface VideoRequest {
  modality: 'video';
  model: string;
  prompt: string;
  aspectRatio?: VideoAspectRatio;
  durationSeconds?: number;
  resolution?: VideoResolution;
}

export type InferenceRequest = TextRequest | ImageRequest | AudioRequest | VideoRequest;

export type InferenceEvent =
  | { kind: 'text-delta'; content: string }
  | { kind: 'media-start'; mediaType: 'image' | 'audio' | 'video'; mimeType: string }
  | {
      kind: 'media-done';
      bytes: Uint8Array;
      mimeType: string;
      width?: number;
      height?: number;
      durationMs?: number;
    }
  | { kind: 'finish'; providerMetadata?: ProviderMetadata };

/**
 * Metadata emitted with a finish event. The real AI SDK does NOT return cost
 * inline; `generationId` is the breadcrumb used with `getGenerationStats` to
 * fetch actual cost post-hoc.
 */
export interface ProviderMetadata {
  generationId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface InferenceStream {
  [Symbol.asyncIterator](): AsyncIterator<InferenceEvent>;
}

/**
 * Shared methods for any AIClient. Concrete clients narrow `isMock` to a
 * literal so `if (client.isMock)` is enough for TypeScript to discriminate.
 */
export interface AIClientBase {
  listModels(): Promise<ModelInfo[]>;
  /**
   * Gateway-shaped catalog (raw, before processModels filtering / smart-model
   * synthesis). The single funnel for any caller that needs `processModels`'s
   * `premiumIds` or `Model[]` output. Keeping this on the AIClient is what
   * lets `getAIClient`'s `isLocalDev || isE2E` fork stay the only env check —
   * routes never touch `fetchModels` directly.
   */
  listRawModels(): Promise<RawModel[]>;
  /**
   * Per-modality typed view of the catalog. Returns rich {@link ModelView}
   * entries discriminated by `modality`, carrying merged data from
   * `processModels` (ZDR filter, premium classification) plus provider
   * capability axes from `packages/shared/src/models/capabilities.ts` plus
   * feature flags from `packages/shared/src/capabilities/`. Single SoT for
   * code that already knows which modality it's working in (test pickers,
   * per-modality route gates, capability validation).
   */
  listModelsForModality<M extends Modality>(modality: M): Promise<readonly ModelViewFor<M>[]>;
  getModel(id: string): Promise<ModelInfo>;
  stream(request: InferenceRequest): InferenceStream;
  getGenerationStats(generationId: string): Promise<{ costUsd: number }>;
}

export interface RealAIClient extends AIClientBase {
  readonly isMock: false;
}

/**
 * History entry recorded by the mock client. Carries the original
 * {@link InferenceRequest} fields plus a `zdrEnforced` flag so tests can
 * assert that ZDR was applied on every call without having to inspect the
 * SDK args. The mock never talks to a real gateway, so the flag is always
 * `true` — tracking it explicitly lets a regression on `real.ts`-style
 * paths (where ZDR is REAL provider options, not just a flag) surface at
 * the boundary.
 */
export type RecordedInferenceRequest = InferenceRequest & { zdrEnforced: boolean };

export interface MockAIClient extends AIClientBase {
  readonly isMock: true;
  getRequestHistory(): RecordedInferenceRequest[];
  clearHistory(): void;
}

/**
 * Per-request configuration for the mock AI client. Set by
 * `aiClientMiddleware` from request headers (`x-mock-classifier-resolution`,
 * `x-mock-classifier-failure`, `x-mock-failing-models`). E2E tests drive
 * deterministic scenarios via `page.setExtraHTTPHeaders` — no shared mutable
 * state, no afterEach cleanup, no cross-test bleed.
 */
export interface MockAIClientConfig {
  /** Model id the classifier resolves to. Defaults to a stable mock id when omitted. */
  classifierResolution?: string;
  /** Force classifier failures (rejection from the async iterator). */
  classifierFailure?: boolean;
  /** Model ids whose inference stream rejects immediately. */
  failingModels?: readonly string[];
  /**
   * Sleep this many milliseconds before yielding the first classifier event.
   * Mock streams resolve on the microtask queue, so without a delay the
   * `stage:start` → `stage:done` round-trip completes in microseconds — the
   * "Choosing the best model…" thinking indicator never has a chance to
   * render observably. Tests that assert that indicator set this to ~500ms.
   */
  classifierDelayMs?: number;
  /**
   * Sleep this many milliseconds between successive `text-delta` events from
   * the echo text stream. Defaults to 0 (instant). `getAIClient` raises this
   * when the host process is an actual local dev server so the echo response
   * paints visibly like a typewriter; tests, CI, and E2E keep it at 0 so the
   * suite stays fast.
   */
  textDelayMs?: number;
  /**
   * Sleep this many milliseconds between the `media-start` and `media-done`
   * events of an image / video / audio generation. Defaults to 0 (instant).
   * `getAIClient` raises this when the host process is an actual local dev
   * server so the "Generating…" placeholder (and, for video, the synthetic
   * progress sweep) is visible; tests, CI, and E2E keep it at 0 so the suite
   * stays fast.
   */
  mediaDelayMs?: number;
  /**
   * Public `/v1/models` URL forwarded to `fetchModels` for catalog reads.
   * Tests that stub `globalThis.fetch` ignore the value; defaults to the
   * same production URL the real client uses.
   */
  publicModelsUrl?: string;
}

/** Discriminated union — narrows on `client.isMock` without casts. */
export type AIClient = RealAIClient | MockAIClient;
