import { z } from 'zod';

/**
 * Content-type discriminator shared between server serialization and client
 * parsing. Enforced at the DB via a CHECK constraint on `content_items`;
 * re-parsed here so the server fails loud if a rogue row slips through.
 */
export const contentTypeSchema = z.enum(['text', 'image', 'audio', 'video']);

/**
 * Allowlist of mime types accepted by the media pipeline. Validated at write
 * time (before R2 + DB) so non-conforming rows never enter persistence, and
 * re-validated at read time on the public share endpoint as defense in depth.
 *
 * Members chosen from what the AI Gateway currently produces (see canned
 * responses in `apps/api/src/services/ai/mock.ts` and decoded responses in
 * `apps/api/src/services/ai/real.ts`):
 * - image: png, jpeg, webp
 * - audio: mpeg (.mp3), wav, ogg
 * - video: mp4, webm
 *
 * If a provider ever returns a mime outside this set, the request fails with
 * the `UNKNOWN_MIME_TYPE` error code rather than silently storing data the
 * client cannot decode.
 */
export const ALLOWED_MEDIA_MIME_TYPES = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'video/mp4',
  'video/webm',
]);

export type AllowedMediaMimeType = z.infer<typeof ALLOWED_MEDIA_MIME_TYPES>;

/**
 * Canonical default mime type per media modality. The `as const satisfies`
 * clause makes this map the single source of truth for placeholder/default
 * mimes used by the pipeline and AI clients: any value here that is not in
 * {@link ALLOWED_MEDIA_MIME_TYPES} fails to compile, so the enum and its
 * defaults can never drift apart.
 */
export const DEFAULT_MIME_TYPE_BY_MODALITY = {
  image: 'image/png',
  video: 'video/mp4',
  audio: 'audio/mpeg',
} as const satisfies Record<'image' | 'video' | 'audio', AllowedMediaMimeType>;

/**
 * Sender-type discriminator. Enforced at the DB via CHECK on `messages.sender_type`.
 * Re-parsed at serialization boundaries so the server fails loud if the DB
 * ever holds a value outside this set.
 */
export const senderTypeSchema = z.enum(['user', 'ai']);

export type ContentType = z.infer<typeof contentTypeSchema>;
export type SenderType = z.infer<typeof senderTypeSchema>;

/**
 * A single content item in the public share response. Shape is deliberately
 * loose (every media/text field is nullable) because it matches what the
 * server can emit verbatim — text items populate `encryptedBlob` and null the
 * media fields, media items populate `mimeType` + `downloadUrl` + metadata
 * and null `encryptedBlob`. Consumers narrow via `contentType`.
 */
export const publicShareContentItemSchema = z.object({
  id: z.string(),
  contentType: contentTypeSchema,
  position: z.number().int().nonnegative(),
  encryptedBlob: z.string().nullable(),
  /**
   * mimeType is null for text items and one of {@link ALLOWED_MEDIA_MIME_TYPES}
   * for media items. Validated at upload time so rogue values never reach
   * the share response.
   */
  mimeType: ALLOWED_MEDIA_MIME_TYPES.nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  /** Presigned GET URL; set only for media items. */
  downloadUrl: z.string().nullable(),
  /** ISO-8601 expiry of `downloadUrl`; set only for media items. */
  expiresAt: z.string().nullable(),
});

export const publicShareResponseSchema = z.object({
  shareId: z.string(),
  messageId: z.string(),
  /** Base64-encoded symmetric wrap of the message content key under HKDF(shareSecret). */
  wrappedShareKey: z.string(),
  contentItems: z.array(publicShareContentItemSchema),
  createdAt: z.string(),
});

export type PublicShareContentType = z.infer<typeof contentTypeSchema>;
export type PublicShareContentItem = z.infer<typeof publicShareContentItemSchema>;
export type PublicShareResponse = z.infer<typeof publicShareResponseSchema>;
