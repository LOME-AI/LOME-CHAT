import { decryptTextFromEpoch } from '@hushbox/crypto';
import {
  fromBase64,
  type MemberPrivilege,
  type ChatModality,
  type ImageConfig,
  type VideoConfig,
  type AudioConfig,
} from '@hushbox/shared';
import { getEpochKey } from '@/lib/epoch-key-cache';
import type { Message } from '@/lib/api';

export const DECRYPTING_TITLE = 'Decrypting...';

export type RenderState =
  | { readonly type: 'redirecting' }
  | { readonly type: 'not-found' }
  | { readonly type: 'loading'; readonly title?: string | undefined }
  | { readonly type: 'ready' };

export type RegenerateAction = 'retry' | 'edit';

export interface ComputeRenderStateParams {
  isCreateMode: boolean;
  pendingMessage: string | null;
  localMessagesLength: number;
  conversation: { title: string } | undefined;
  isConversationLoading: boolean;
  isMessagesLoading: boolean;
  isDecryptionPending: boolean;
}

export function shouldRedirect(
  isCreateMode: boolean,
  pendingMessage: string | null,
  localMessagesLength: number
): boolean {
  return isCreateMode && !pendingMessage && localMessagesLength === 0;
}

export function computeRenderState(params: ComputeRenderStateParams): RenderState {
  const {
    isCreateMode,
    pendingMessage,
    localMessagesLength,
    conversation,
    isConversationLoading,
    isMessagesLoading,
  } = params;

  if (shouldRedirect(isCreateMode, pendingMessage, localMessagesLength)) {
    return { type: 'redirecting' };
  }

  if (isCreateMode) {
    return { type: 'ready' };
  }

  if (!conversation && !isConversationLoading) {
    return { type: 'not-found' };
  }

  if (isConversationLoading || isMessagesLoading) {
    // During create→existing transition, local messages are still available —
    // skip the loading state to avoid a flash of the decrypting indicator.
    if (localMessagesLength > 0) {
      return { type: 'ready' };
    }
    return { type: 'loading', title: DECRYPTING_TITLE };
  }

  // API returned messages but decryption hasn't completed yet (key chain loading).
  // Stay in loading state to show "Decrypting..." instead of a blank page.
  if (params.isDecryptionPending) {
    // As with the loading branch above: during the create→real window the
    // optimistic turn is still on screen, so keep showing it rather than
    // flashing the "Decrypting..." placeholder while the post-stream refetch
    // decrypts the just-persisted messages.
    if (localMessagesLength > 0) {
      return { type: 'ready' };
    }
    return { type: 'loading', title: DECRYPTING_TITLE };
  }

  return { type: 'ready' };
}

export function resolveUserContent(
  action: RegenerateAction,
  editedContent: string | undefined,
  allMessages: Message[],
  targetMessageId: string
): string | null {
  if (action === 'edit' && editedContent) return editedContent;
  const content = allMessages.find((m) => m.id === targetMessageId)?.content;
  // null = anchor content unavailable (missing or empty mid-decryption); callers
  // must not regenerate then — the server requires non-empty content (min(1)).
  return content != null && content !== '' ? content : null;
}

/**
 * Compute the ids that retry/edit/regenerate will remove from the rendered list.
 *
 * - regenerate-one (`replaceAssistantId` set) → only that one tile
 * - retry-all (action `retry`, no replaceAssistantId) → every descendant of
 *   the anchor user message (the user message itself is reused).
 * - edit (action `edit`, no replaceAssistantId) → the anchor user message
 *   itself **and** every descendant (the user message is replaced by a new
 *   one with the edited content).
 *
 * Mirrors the backend's tree-action deletion rule so the optimistic UI and
 * the eventual server state stay in sync.
 */
export function computePruneIds(
  allMsgs: Message[],
  targetMessageId: string,
  action: RegenerateAction,
  replaceAssistantId?: string
): Set<string> {
  if (replaceAssistantId !== undefined) {
    return new Set([replaceAssistantId]);
  }
  const targetIndex = allMsgs.findIndex((m) => m.id === targetMessageId);
  if (targetIndex === -1) return new Set();
  const startIndex = action === 'edit' ? targetIndex : targetIndex + 1;
  return new Set(allMsgs.slice(startIndex).map((m) => m.id));
}

interface ChatError {
  id: string;
  content: string;
}

interface MergeMessagesInput {
  isCreateMode: boolean;
  realConversationId: string | null;
  localMessages: Message[];
  decryptedApiMessages: Message[];
  optimisticMessages: Message[];
  chatError: ChatError | null;
  primaryModelId: string;
}

export function mergeMessages(input: MergeMessagesInput): Message[] {
  let messages: Message[];
  if (input.isCreateMode || !input.realConversationId) {
    messages = input.localMessages;
  } else {
    const apiMessageIds = new Set(input.decryptedApiMessages.map((m) => m.id));
    const pendingOptimistic = input.optimisticMessages.filter((m) => !apiMessageIds.has(m.id));
    messages = [...input.decryptedApiMessages, ...pendingOptimistic];
    if (messages.length === 0 && input.localMessages.length > 0) {
      messages = input.localMessages;
    }
  }
  if (input.chatError) {
    messages = [
      ...messages,
      {
        id: input.chatError.id,
        conversationId: input.realConversationId ?? '',
        role: 'assistant',
        content: input.chatError.content,
        createdAt: new Date().toISOString(),
        modelName: input.primaryModelId,
      },
    ];
  }
  return messages;
}

/**
 * Picks the per-modality config block for the stream request payload.
 * Returns an empty object for text. Pure helper — both `executeStream`
 * and `executeStreamAndFinalize` use it so adding a new modality is one edit.
 */
type ModalityConfigPayload =
  | { imageConfig: ImageConfig }
  | { videoConfig: VideoConfig }
  | { audioConfig: AudioConfig }
  | Record<string, never>;

export function buildModalityConfigPayload(
  activeModality: ChatModality,
  imageConfig: ImageConfig,
  videoConfig: VideoConfig,
  audioConfig: AudioConfig
): ModalityConfigPayload {
  switch (activeModality) {
    case 'image': {
      return { imageConfig };
    }
    case 'video': {
      return { videoConfig };
    }
    case 'audio': {
      return { audioConfig };
    }
    case 'text': {
      return {};
    }
  }
}

/**
 * The aspect ratio the user requested for an in-flight media generation, in
 * colon form (e.g. "16:9"). Lets the placeholder reserve the media's true
 * shape the moment `model:media:start` arrives. Audio has no 2D shape, so it
 * returns `undefined`. Read from the send-time config so the shape is a
 * snapshot of the request, not the live (mutable) selector.
 */
export function requestedMediaAspectRatio(
  mediaType: 'image' | 'audio' | 'video',
  imageConfig: ImageConfig,
  videoConfig: VideoConfig
): string | undefined {
  if (mediaType === 'image') return imageConfig.aspectRatio;
  if (mediaType === 'video') return videoConfig.aspectRatio;
  return undefined;
}

/** Stand-in mime stamped at creation; `model:media:start` reports the real one. */
const PENDING_MEDIA_MIME = 'application/octet-stream';

/**
 * The `mediaInFlight` hint to stamp on a freshly-created assistant message when
 * the turn is a media generation, so the loading placeholder shows the media
 * backdrop (correctly shaped) from the first frame instead of a text "thinking"
 * indicator. Returns `undefined` for text turns. The placeholder reads only
 * `mediaType` + `aspectRatio`, so the mime is a stand-in until `model:media:start`.
 */
export function pendingMediaInFlight(
  modality: ChatModality,
  imageConfig: ImageConfig,
  videoConfig: VideoConfig
): Message['mediaInFlight'] {
  if (modality === 'text') return undefined;
  const aspectRatio = requestedMediaAspectRatio(modality, imageConfig, videoConfig);
  return {
    mediaType: modality,
    mimeType: PENDING_MEDIA_MIME,
    ...(aspectRatio !== undefined && { aspectRatio }),
  };
}

export function computeDisplayTitle(
  localTitle: string | null,
  conversation: { title: string; titleEpochNumber: number } | undefined,
  realConversationId: string | null
): string | undefined {
  if (localTitle) return localTitle;
  if (!conversation?.title || !realConversationId) return;
  const epochKey = getEpochKey(realConversationId, conversation.titleEpochNumber);
  if (!epochKey) return DECRYPTING_TITLE;
  try {
    return decryptTextFromEpoch(epochKey, fromBase64(conversation.title));
  } catch {
    return 'Encrypted conversation';
  }
}

export function resolveQueryId(realConversationId: string | null): string {
  return realConversationId ?? '';
}

export function resolveCallerId(
  conversationCallerId: string | undefined,
  authUserId: string | undefined
): string | undefined {
  return conversationCallerId ?? authUserId;
}

export function checkDecryptionPending(
  isCreateMode: boolean,
  apiMessageCount: number,
  decryptedCount: number
): boolean {
  return !isCreateMode && apiMessageCount > 0 && decryptedCount === 0;
}

export function computeInputDisabled(
  isCreateMode: boolean,
  realConversationId: string | null,
  callerPrivilege: MemberPrivilege | undefined
): boolean {
  return (isCreateMode && !realConversationId) || callerPrivilege === 'read';
}

/**
 * Mirrors the conditions for "MessageList shows final data": past the
 * create-mode placeholder, conversation query loaded, no in-flight
 * decryption pass. E2E tests gate `countMessages` on the resulting
 * `data-messages-ready` attribute so the helper never reads
 * `data-message-count` mid-decryption (where it would be 0 momentarily
 * and the polling helper would mistake that for "stable empty").
 */
export function deriveMessagesReady(
  isCreateMode: boolean,
  isConversationLoading: boolean,
  isDecryptionPending: boolean
): boolean {
  return !isCreateMode && !isConversationLoading && !isDecryptionPending;
}

export interface ChatPageKeyState {
  readonly prevId: string;
  readonly key: string;
}

/**
 * Resolve the React `key` for the chat page. The page is keyed so a genuine
 * conversation switch remounts the subtree, resetting all per-conversation
 * state (typing, presence, phantoms, forks). The one exception is the
 * create→real hop: after the first message the hook navigates `/chat/new` →
 * `/chat/<realId>` for the SAME just-created conversation. Remounting there
 * would destroy optimistic-only state that has no DB row to restore it —
 * notably failed-model error tiles — so the key is held stable across exactly
 * that transition. `fromCreate` is a history-state marker the hook sets ONLY on
 * that navigation, which distinguishes it from a user switching away from a new
 * chat to an existing conversation (which must still remount).
 */
export function resolveChatPageKey(
  previous: ChatPageKeyState,
  id: string,
  fromCreate: boolean
): ChatPageKeyState {
  if (id === previous.prevId) return previous;
  const createToReal = previous.prevId === 'new' && fromCreate;
  return { prevId: id, key: createToReal ? previous.key : id };
}
