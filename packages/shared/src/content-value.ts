import { z } from 'zod';
import { Modality } from './affordability/modality.js';

/**
 * The uniform media value. `ref` is an R2 key —
 * `media/{conv}/{msg}/{uuid}` for epoch-wrapped finals or
 * `inputs/{flowRunId}/{uuid}` for the short-TTL large-input fallback —
 * always ciphertext. Mid-flow values are in-memory, not refs.
 */
export const MediaValue = z.object({
  ref: z.string().min(1),
  mimeType: z.string().min(1),
  modality: Modality,
  byteLength: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()),
});

export type MediaValue = z.infer<typeof MediaValue>;

/**
 * The value shape flowing through the engine's in-memory ValueStore:
 * inline text, inline bytes (mid-flow content never rests anywhere), or a
 * MediaValue ref at the edges (inputs in, epoch-wrapped finals out).
 */
export const ContentValue = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('bytes'),
    bytes: z.instanceof(Uint8Array),
    mimeType: z.string().min(1),
    modality: Modality,
  }),
  z.object({ kind: z.literal('media'), value: MediaValue }),
]);

export type ContentValue = z.infer<typeof ContentValue>;
