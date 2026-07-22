import { z } from 'zod';
import { contentTypeSchema, toBase64 } from '@hushbox/shared';
import type { ContentItemRow } from '../ports/index.js';

/**
 * The wire shape of a content item for the history and public-share reads.
 * Uniform across both reads so the client parses one shape: text items carry
 * base64 `encryptedBlob` inline; media items carry `encryptedBlob: null` and are
 * fetched by presigning `id` (the content-item id) once the media adapter ships.
 */
export const contentItemViewSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  contentType: contentTypeSchema,
  mimeType: z.string().nullable(),
  byteLength: z.number().int().nullable(),
  /** Pixel width of a media item (null for text/audio) — the client's aspect-ratio source. */
  width: z.number().int().nullable(),
  /** Pixel height of a media item (null for text/audio) — the client's aspect-ratio source. */
  height: z.number().int().nullable(),
  /** Duration of time-based media (video/audio) in milliseconds, or null. */
  durationMs: z.number().int().nullable(),
  encryptedBlob: z.string().nullable(),
});

export type ContentItemView = z.infer<typeof contentItemViewSchema>;

export function contentItemView(row: ContentItemRow): ContentItemView {
  return {
    id: row.id,
    position: row.position,
    contentType: row.contentType,
    mimeType: row.mimeType,
    byteLength: row.sizeBytes,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    encryptedBlob: row.encryptedBlob === null ? null : toBase64(row.encryptedBlob),
  };
}
