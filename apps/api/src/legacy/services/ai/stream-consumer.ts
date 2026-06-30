/**
 * Drain an InferenceStream into a single result object, capturing every
 * event's payload plus timestamps. Used by integration tests to assert on
 * stream shape and content without re-implementing the for-await loop.
 */

import type { InferenceEvent, InferenceStream } from './types.js';

export interface ConsumedStream {
  events: InferenceEvent[];
  generationId: string | undefined;
  textContent: string;
  mediaBytes: Uint8Array | undefined;
  mediaMimeType: string | undefined;
  mediaWidth: number | undefined;
  mediaHeight: number | undefined;
  mediaDurationMs: number | undefined;
  timestamps: number[];
}

export async function consumeStream(stream: InferenceStream): Promise<ConsumedStream> {
  const events: InferenceEvent[] = [];
  const timestamps: number[] = [];
  let textContent = '';
  let mediaBytes: Uint8Array | undefined;
  let mediaMimeType: string | undefined;
  let mediaWidth: number | undefined;
  let mediaHeight: number | undefined;
  let mediaDurationMs: number | undefined;
  let generationId: string | undefined;

  for await (const event of stream) {
    events.push(event);
    timestamps.push(Date.now());
    switch (event.kind) {
      case 'text-delta': {
        textContent += event.content;
        break;
      }
      case 'media-done': {
        mediaBytes = event.bytes;
        mediaMimeType = event.mimeType;
        mediaWidth = event.width;
        mediaHeight = event.height;
        mediaDurationMs = event.durationMs;
        break;
      }
      case 'finish': {
        generationId = event.providerMetadata?.generationId;
        break;
      }
      // media-start carries no payload we capture
    }
  }

  return {
    events,
    generationId,
    textContent,
    mediaBytes,
    mediaMimeType,
    mediaWidth,
    mediaHeight,
    mediaDurationMs,
    timestamps,
  };
}
