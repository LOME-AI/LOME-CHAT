import { z } from 'zod';
import { MemberPrivilege as memberPrivilegeSchema } from '../../member-privilege.js';
import {
  MAX_SELECTED_MODELS,
  IMAGE_ASPECT_RATIOS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  MIN_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_DURATION_SECONDS,
  AUDIO_FORMATS,
  MAX_AUDIO_DURATION_SECONDS,
} from '../../constants.js';

/**
 * Request schema for creating a conversation.
 * Client MUST provide the conversation ID (UUID) for idempotency.
 * Title is base64-encoded encrypted blob (client-side encryption).
 * Epoch fields establish the first epoch for the conversation.
 */
export const createConversationRequestSchema = z.object({
  id: z.uuid(), // REQUIRED: client-generated UUID for idempotency
  title: z.string().optional(), // base64-encoded encrypted title
  epochPublicKey: z.string().min(1), // base64-encoded epoch public key
  confirmationHash: z.string().min(1), // base64-encoded confirmation hash
  memberWrap: z.string().min(1), // base64-encoded ECIES-wrapped epoch key for owner
});

// Use z.input for request types to preserve optionality (z.infer gives output type with defaults applied)
export type CreateConversationRequest = z.input<typeof createConversationRequestSchema>;

/**
 * Request schema for updating a conversation (rename).
 * Title is base64-encoded encrypted blob.
 * titleEpochNumber identifies which epoch key was used for encryption.
 */
export const updateConversationRequestSchema = z.object({
  title: z.string().min(1), // base64-encoded encrypted title
  titleEpochNumber: z.number().int().min(1), // epoch number used for encryption
});

export type UpdateConversationRequest = z.infer<typeof updateConversationRequestSchema>;

/**
 * Schema for epoch rotation data piggybacked on a chat request.
 * When a pending member removal exists, the client must rotate the epoch
 * before sending a new message. All fields are base64-encoded where noted.
 */
export const rotationSchema = z.object({
  expectedEpoch: z.number().int().min(1),
  epochPublicKey: z.string().min(1), // base64
  confirmationHash: z.string().min(1), // base64
  chainLink: z.string().min(1), // base64
  memberWraps: z
    .array(
      z.object({
        memberPublicKey: z.string().min(1), // base64
        wrap: z.string().min(1), // base64
      })
    )
    .min(1),
  encryptedTitle: z.string().min(1), // base64
});

export type StreamChatRotation = z.infer<typeof rotationSchema>;

/**
 * Request schema for POST /chat/stream.
 * Single atomic endpoint: validate, stream, persist user msg + ECIES assistant msg + billing.
 * User message is plaintext — server encrypts with epoch key.
 * Optional rotation field for piggybacked epoch rotation.
 */
/** Valid funding source values for billing claim validation. */
const fundingSourceSchema = z.enum([
  'owner_balance',
  'personal_balance',
  'free_allowance',
  'trial_fixed',
]);

export const imageConfigSchema = z.object({
  aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).default('1:1'),
});

export type ImageConfig = z.infer<typeof imageConfigSchema>;

export const videoConfigSchema = z.object({
  aspectRatio: z.enum(VIDEO_ASPECT_RATIOS),
  durationSeconds: z.number().int().min(MIN_VIDEO_DURATION_SECONDS).max(MAX_VIDEO_DURATION_SECONDS),
  resolution: z.enum(VIDEO_RESOLUTIONS),
});

export type VideoConfig = z.infer<typeof videoConfigSchema>;

/**
 * Audio (TTS) generation config. Unlike video, the duration of TTS output is
 * not user-controllable — it emerges from synthesizing the input text — so
 * `maxDurationSeconds` caps worst-case spend rather than fixing the duration.
 */
export const audioConfigSchema = z.object({
  format: z.enum(AUDIO_FORMATS).default('mp3'),
  voice: z.string().optional(),
  maxDurationSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_AUDIO_DURATION_SECONDS)
    .default(MAX_AUDIO_DURATION_SECONDS),
});

export type AudioConfig = z.infer<typeof audioConfigSchema>;

export const streamChatRequestSchema = z
  .object({
    modality: z.enum(['text', 'image', 'video', 'audio']).default('text'),
    models: z.array(z.string()).min(1).max(MAX_SELECTED_MODELS),
    userMessage: z.object({
      id: z.uuid(),
      content: z.string().min(1), // plaintext — server encrypts with epoch key
    }),
    /**
     * Full conversation history used as the model's prompt.
     * For media modalities only `userMessage.content` is used as the prompt.
     */
    messagesForInference: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant', 'system']),
          content: z.string(),
        })
      )
      .min(1),
    fundingSource: fundingSourceSchema, // client's billing claim — the backend re-derives via resolveFundingDecision()
    webSearchEnabled: z.boolean().optional(),
    customInstructions: z.string().max(5000).optional(),
    forkId: z.uuid().optional(),
    imageConfig: imageConfigSchema.optional(),
    videoConfig: videoConfigSchema.optional(),
    audioConfig: audioConfigSchema.optional(),
  })
  .refine((data) => data.modality !== 'video' || data.videoConfig !== undefined, {
    message: 'videoConfig is required when modality is "video"',
    path: ['videoConfig'],
  })
  .refine((data) => data.modality !== 'audio' || data.audioConfig !== undefined, {
    message: 'audioConfig is required when modality is "audio"',
    path: ['audioConfig'],
  });

export type StreamChatRequest = z.infer<typeof streamChatRequestSchema>;

/**
 * Request schema for POST /chat/message.
 * Saves a user-only message without triggering AI. Free — no billing.
 * Used in group chats when the AI toggle is off.
 */
export const userOnlyMessageSchema = z.object({
  messageId: z.uuid(),
  content: z.string().min(1),
  // The branch being viewed when the message is sent. When present, the send
  // chains onto that fork's tip and advances it (mirroring a paid turn);
  // absent is a linear send onto the conversation's high-sequence tip.
  forkId: z.uuid().optional(),
});

export type UserOnlyMessageRequest = z.infer<typeof userOnlyMessageSchema>;

// ============================================================
// Response Schemas - Single Source of Truth for API responses
// ============================================================

/**
 * Schema for a conversation entity in API responses.
 * Title is base64-encoded encrypted bytea.
 * Includes epoch management fields.
 */
export const conversationResponseSchema = z.object({
  id: z.string(),
  title: z.string(), // base64-encoded encrypted title
  currentEpoch: z.number().int().min(1),
  titleEpochNumber: z.number().int().min(1),
  nextSequence: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ConversationResponse = z.infer<typeof conversationResponseSchema>;

/**
 * Schema for a conversation list item in GET /conversations responses.
 * Extends base conversation with membership acceptance state.
 *
 * `muted` and `pinned` are intentionally list-only — they are per-user display
 * preferences relevant when scanning conversations, not needed in the
 * single-conversation detail response (conversationResponseSchema).
 */
export const conversationListItemSchema = conversationResponseSchema.extend({
  accepted: z.boolean(),
  invitedByUsername: z.string().nullable(),
  privilege: memberPrivilegeSchema,
  muted: z.boolean().default(false),
  pinned: z.boolean().default(false),
});

export type ConversationListItem = z.infer<typeof conversationListItemSchema>;

/**
 * Schema for a single content item inside a message.
 * Text items carry `encryptedBlob` (base64) inline. Media items (image/audio/video)
 * carry `storageKey` + mime/size/dimensions and are fetched via presigned GET URLs.
 * Fields not applicable to a given `contentType` are null.
 */
export const contentItemResponseSchema = z.object({
  id: z.string(),
  contentType: z.enum(['text', 'image', 'audio', 'video']),
  position: z.number().int().nonnegative(),

  /** Base64-encoded symmetric ciphertext under the parent message's content key. Set for text items, null for media. */
  encryptedBlob: z.string().nullable(),

  /** R2 object key for media items. Null for text items. */
  storageKey: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),

  /** AI generation metadata. Null for user-authored content. */
  modelName: z.string().nullable(),
  cost: z.string().nullable(),
  isSmartModel: z.boolean(),
  /**
   * Persisted reasoning-token count for the generation(s) behind this item
   * (from `llm_completions` via the history read). Absent for user-authored
   * content, media, and pre-feature rows; drives the settled thinking label.
   */
  reasoningTokens: z.number().int().nonnegative().optional(),
});

export type ContentItemResponse = z.infer<typeof contentItemResponseSchema>;

/**
 * Schema for a message entity in API responses.
 *
 * Under the wrap-once envelope model, each message has one `wrappedContentKey`
 * (ECIES-wrapped under the epoch public key) plus one or more `contentItems`
 * encrypted symmetrically under the unwrapped content key. Clients unwrap the
 * content key once and decrypt every content item with it.
 */
export const messageResponseSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** Base64-encoded ECIES-wrapped content key for this message. */
  wrappedContentKey: z.string(),
  senderType: z.enum(['user', 'ai']),
  senderId: z.string().nullable(),
  epochNumber: z.number().int().min(1),
  sequenceNumber: z.number().int().nonnegative(),
  parentMessageId: z.string().nullable(),
  /**
   * Per-turn id shared by all messages persisted in one `saveChatTurn`.
   * Drives the multi-model-peer vs fork-preserve-orphan distinction in
   * the client-side fork-filter.
   */
  batchId: z.string(),
  createdAt: z.string(),
  /** Discrete content items belonging to this message, ordered by position. */
  contentItems: z.array(contentItemResponseSchema),
});

export type MessageResponse = z.infer<typeof messageResponseSchema>;

/**
 * Schema for a fork entity in API responses. Mirrors the server's `forkView`
 * serializer exactly — the fork's `conversationId` is not on the wire (the
 * client already holds it as the parent route param), so it is not part of the
 * contract.
 */
export const forkResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  tipMessageId: z.string().nullable(),
  createdAt: z.string(),
});

export type ForkResponse = z.infer<typeof forkResponseSchema>;

/**
 * The single source of truth for the key-chain wire contract — the crypto
 * material the client needs to unwrap a conversation's epoch keys. Served by
 * `GET /:conversationId/keychain` (one conversation) and
 * `GET /member-keys/batch` (many). Both server serializers and the client's
 * `processKeyChain` reference these types, so a shape change is a compile error
 * at both ends rather than a silent runtime decrypt failure.
 *
 * All ciphertext/hash fields are base64. There is deliberately no
 * `visibleFromEpoch` here: it is a server-side membership-floor filter applied
 * while assembling the chain, never consumed by the client.
 */
export const keyChainWrapSchema = z.object({
  epochNumber: z.number().int().min(1),
  wrap: z.string(), // base64 ECIES-wrapped epoch key
  confirmationHash: z.string(), // base64
});

export type KeyChainWrap = z.infer<typeof keyChainWrapSchema>;

export const keyChainLinkSchema = z.object({
  epochNumber: z.number().int().min(1),
  chainLink: z.string(), // base64 chain link to the previous epoch
  confirmationHash: z.string(), // base64
});

export type KeyChainLink = z.infer<typeof keyChainLinkSchema>;

export const keyChainResponseSchema = z.object({
  wraps: z.array(keyChainWrapSchema),
  chainLinks: z.array(keyChainLinkSchema),
  currentEpoch: z.number().int().min(1),
});

export type KeyChainResponse = z.infer<typeof keyChainResponseSchema>;

/**
 * Response schema for GET /conversations
 */
export const listConversationsResponseSchema = z.object({
  conversations: z.array(conversationListItemSchema),
  nextCursor: z.string().nullable(),
});

export type ListConversationsResponse = z.infer<typeof listConversationsResponseSchema>;

/**
 * The requesting caller's membership facts for a single conversation. Mirrors
 * the server's `membershipView` serializer exactly. `visibleFromEpoch` is the
 * caller's epoch floor; `muted`/`pinned` are per-user display preferences.
 */
export const membershipViewSchema = z.object({
  privilege: memberPrivilegeSchema,
  muted: z.boolean(),
  pinned: z.boolean(),
  accepted: z.boolean(),
  visibleFromEpoch: z.number().int().min(1),
});

export type MembershipView = z.infer<typeof membershipViewSchema>;

/**
 * Response schema for GET /conversations/:id. Mirrors the server's
 * `loadConversationView` result: the conversation record, the caller's
 * `membership`, and the conversation's forks. Message history is served
 * separately by GET /conversations/:id/messages, so it is not embedded here.
 */
export const getConversationResponseSchema = z.object({
  conversation: conversationResponseSchema,
  membership: membershipViewSchema,
  forks: z.array(forkResponseSchema).default([]),
});

export type GetConversationResponse = z.infer<typeof getConversationResponseSchema>;

/**
 * Response schema for POST /conversations.
 * `created` mirrors the backend outcome (`createConversationOutcomeSchema`):
 * - true  = a newly created conversation (its first turn should be streamed)
 * - false = idempotent return of an already-existing conversation (no re-stream)
 */
export const createConversationResponseSchema = z.object({
  conversation: conversationResponseSchema,
  created: z.boolean(),
});

export type CreateConversationResponse = z.infer<typeof createConversationResponseSchema>;

/**
 * Response schema for PATCH /conversations/:id
 */
export const updateConversationResponseSchema = z.object({
  conversation: conversationResponseSchema,
});

export type UpdateConversationResponse = z.infer<typeof updateConversationResponseSchema>;

/**
 * Response schema for DELETE /conversations/:id
 */
export const deleteConversationResponseSchema = z.object({
  deleted: z.boolean(),
});

export type DeleteConversationResponse = z.infer<typeof deleteConversationResponseSchema>;

/**
 * Request schema for creating a fork.
 * Client provides fork ID for idempotency.
 */
export const createForkRequestSchema = z.object({
  id: z.uuid(),
  fromMessageId: z.uuid(),
  name: z.string().min(1).max(50).optional(),
});

export type CreateForkRequest = z.infer<typeof createForkRequestSchema>;

/**
 * Request schema for renaming a fork.
 */
export const renameForkRequestSchema = z.object({
  name: z.string().min(1).max(50),
});

export type RenameForkRequest = z.infer<typeof renameForkRequestSchema>;

/**
 * Request schema for POST /chat/regenerate.
 *
 * Supports retry (resend same user message, re-running every selected model)
 * and edit (swap the user message in place). The `models` array is symmetric
 * with `/stream` — single-model is just `models.length === 1`. `'regenerate'`
 * is no longer a distinct wire value: server-side it always behaved
 * identically to `'retry'` (see tree-action.ts), so the enum collapses to
 * `'retry' | 'edit'`.
 *
 * `replaceAssistantId` discriminates two scopes that share the same pipeline:
 *   - unset → retry-all: every assistant descendant of `targetMessageId` is
 *     deleted; one new assistant is created per entry in `models`.
 *   - set → regenerate-one: only the named assistant is deleted; its
 *     replacement(s) inherit the same parentMessageId so the surviving
 *     siblings are preserved. Used by the per-tile "Regenerate" button on a
 *     multi-model response and by the failed-tile retry path.
 */
export const regenerateRequestSchema = z
  .object({
    targetMessageId: z.uuid(),
    action: z.enum(['retry', 'edit']),
    /**
     * Modality of the regenerated turn. Must match the original
     * assistant message's content type (image messages regenerate to
     * images, etc.). Defaults to 'text' for back-compat with older
     * clients that omit the field.
     */
    modality: z.enum(['text', 'image', 'video', 'audio']).default('text'),
    models: z.array(z.string()).min(1).max(MAX_SELECTED_MODELS),
    replaceAssistantId: z.uuid().optional(),
    userMessage: z.object({
      id: z.uuid(),
      content: z.string().min(1),
    }),
    messagesForInference: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant', 'system']),
          content: z.string(),
        })
      )
      .min(1),
    fundingSource: fundingSourceSchema,
    forkId: z.uuid().optional(),
    webSearchEnabled: z.boolean().optional(),
    customInstructions: z.string().max(5000).optional(),
    imageConfig: imageConfigSchema.optional(),
    videoConfig: videoConfigSchema.optional(),
    audioConfig: audioConfigSchema.optional(),
  })
  .refine((data) => data.modality !== 'video' || data.videoConfig !== undefined, {
    message: 'videoConfig is required when modality is "video"',
    path: ['videoConfig'],
  })
  .refine((data) => data.modality !== 'audio' || data.audioConfig !== undefined, {
    message: 'audioConfig is required when modality is "audio"',
    path: ['audioConfig'],
  });

export type RegenerateRequest = z.infer<typeof regenerateRequestSchema>;
