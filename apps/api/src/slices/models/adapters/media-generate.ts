import { z } from 'zod';
import { invalidRequestError } from './inference-error.js';
import { AdapterDefect } from './language-adapter.js';
import type {
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
  Usage,
} from '@hushbox/shared';

/**
 * Shared mapping for the media generate call-shapes (image/video): one
 * non-streaming SDK call whose result becomes media-start/media-done pairs
 * plus the terminal finish. The FilePartMapper decides where bytes rest.
 *
 * OpenRouter's video model surfaces `providerMetadata.openrouter.generationId`
 * and the authoritative inline `providerMetadata.openrouter.cost`; its image
 * model (a dedicated images API) surfaces neither — image finishes carry no
 * generation id and no cost, so settlement falls back to the deterministic
 * estimate. Both are best-effort: a missing id is not a failure.
 */

/** The result surface shared by the SDK's generated image/video files. */
export interface GeneratedMediaFile {
  readonly mediaType: string;
  readonly uint8Array: Uint8Array;
}

const openrouterMediaMetadataSchema = z.looseObject({
  openrouter: z
    .looseObject({
      generationId: z.string().nullish(),
      cost: z.number().nullish(),
    })
    .nullish(),
});

/** Pull `openrouter.generationId` from a media result's provider metadata (best-effort). */
export function extractMediaGenerationId(metadata?: unknown): string | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  const parsed = openrouterMediaMetadataSchema.safeParse(metadata);
  if (!parsed.success) return undefined;
  const id = parsed.data.openrouter?.generationId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Pull the authoritative inline `openrouter.cost` (USD) from a media result's
 * provider metadata. Present for video; absent for image (no inline cost) and
 * on the pathological missing-cost path — settlement estimates in those cases.
 */
export function extractMediaCostUsd(metadata?: unknown): number | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  const parsed = openrouterMediaMetadataSchema.safeParse(metadata);
  if (!parsed.success) return undefined;
  const cost = parsed.data.openrouter?.cost;
  return typeof cost === 'number' ? cost : undefined;
}

/**
 * Boundary validation common to the media families. ZDR is fail-closed:
 * models absent from OpenRouter's `/endpoints/zdr` list carry
 * `zdrReachable: false` (set by the catalog) and the adapter refuses them
 * before any gateway call.
 */
export function validateMediaCall(request: InferenceRequest, descriptor: ModelDescriptor): void {
  if (request.model !== descriptor.id) {
    throw invalidRequestError(
      `Request model does not match descriptor (${request.model} vs ${descriptor.id})`
    );
  }
  if (!descriptor.zdrReachable) {
    throw invalidRequestError(
      `Model is not ZDR-reachable (${descriptor.id}); unverified models are refused fail-closed`
    );
  }
}

export function mediaPromptFromInputs(inputs: InferenceRequest['inputs']): string {
  const texts = inputs.map((part) => {
    if (part.modality !== 'text') {
      // Media inputs ride by reference (ciphertext in R2); resolving them is
      // the engine's ValueStore seam — the adapter never holds storage access.
      throw invalidRequestError(
        `Unsupported input modality for media generate call: ${part.modality}`
      );
    }
    return part.text;
  });
  if (texts.length === 0) {
    throw invalidRequestError('Media generation requires a text prompt');
  }
  return texts.join('\n');
}

export function mediaOutputEvents(
  files: readonly GeneratedMediaFile[],
  mapFilePart?: FilePartMapper
): InferenceEvent[] {
  if (mapFilePart === undefined) {
    // Defect, not an expected failure: the caller invoked a media family
    // without supplying the FilePartMapper contract.
    throw new AdapterDefect(
      'media generate adapter: generated file received without a mapFilePart contract'
    );
  }
  return files.flatMap((file, index) => {
    // The SDK types GeneratedFile bytes as Uint8Array<ArrayBufferLike> but
    // constructs them from plain buffers (base64 payloads), never
    // SharedArrayBuffer-backed views — the narrowing is safe and zero-copy.
    const [start, done] = mapFilePart(
      { mediaType: file.mediaType, data: file.uint8Array as Uint8Array<ArrayBuffer> },
      index
    );
    return [start, done];
  });
}

/**
 * Build the terminal finish for a media generation. The generation id (video
 * only) and the provider cost (video's inline cost; omitted for image) are both
 * optional — a media call with neither still finishes successfully, and
 * settlement estimates when no cost is present.
 */
export function mediaFinishEvent(
  providerMetadata: unknown,
  usage: Usage,
  providerCostUsd?: number
): InferenceEvent {
  const generationId = extractMediaGenerationId(providerMetadata);
  return {
    kind: 'finish',
    metadata: {
      ...(generationId === undefined ? {} : { generationId }),
      ...(providerCostUsd === undefined ? {} : { providerCostUsd }),
      usage,
      finishReason: 'stop',
    },
  };
}
