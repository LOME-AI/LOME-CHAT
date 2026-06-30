import { z } from 'zod';
import { invalidRequestError, truncatedStreamError } from './inference-error.js';
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
 * plus the terminal finish. Mirrors the language adapter's contracts —
 * gateway generation metadata keys true-up, the FilePartMapper decides where
 * bytes rest, and drift is a defect, never a silent loss.
 */

/** The result surface shared by the SDK's generated image/video files. */
export interface GeneratedMediaFile {
  readonly mediaType: string;
  readonly uint8Array: Uint8Array;
}

const gatewayMetadataSchema = z.looseObject({
  gateway: z.looseObject({ generationId: z.string() }).optional(),
});

/**
 * Pull `gateway.generationId` from a media result's provider metadata. The
 * namespace being present without a string generationId is schema drift —
 * fail loud so an SDK upgrade cannot silently lose the breadcrumb that keys
 * per-generation cost lookups.
 */
export function extractMediaGenerationId(metadata?: unknown): string | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  const parsed = gatewayMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    if ((metadata as { gateway?: unknown }).gateway !== undefined) {
      throw new AdapterDefect('Gateway generation metadata schema drift — generationId missing');
    }
    return undefined;
  }
  return parsed.data.gateway?.generationId;
}

/**
 * Boundary validation common to the media families. ZDR is fail-closed:
 * image/video models without founder-verified ZDR enforcement carry
 * `zdrReachable: false` (sourced from modelOverrides by the catalog) and the
 * adapter refuses them before any gateway call.
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
 * A completed generation that cannot be billed or reconciled (no gateway
 * generationId) is treated as malformed — same posture as the language
 * adapter's per-step requirement.
 */
export function mediaFinishEvent(providerMetadata: unknown, usage: Usage): InferenceEvent {
  const generationId = extractMediaGenerationId(providerMetadata);
  if (generationId === undefined) throw truncatedStreamError();
  return { kind: 'finish', metadata: { generationId, usage, finishReason: 'stop' } };
}
