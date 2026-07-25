/**
 * In-browser fake backend for the demo. At construction it encrypts every
 * fixture conversation with real `@hushbox/crypto` (one epoch per
 * conversation, wrapped to the demo account) and caches the resulting wire
 * responses. Getter methods return the exact shapes the real app's read path
 * expects, so `useConversations` / `useDecryptedMessages` / `processKeyChain`
 * run unmodified against this store instead of the network.
 */
import {
  fromBase64,
  FREE_ALLOWANCE_CENTS_VALUE,
  MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  utcDayKey,
} from '@hushbox/shared';
import {
  beginMessage,
  buildKeyChain,
  createDemoEpoch,
  encryptForEpoch,
  type DemoEpoch,
  type MessageEnvelope,
} from './crypto-encoder';
import {
  DEMO_CONVERSATIONS,
  DEMO_GROUP_MODEL_ID,
  DEMO_USER,
  type DemoConversation,
  type DemoContent,
  type DemoMessage,
  type DemoModality,
  type DemoParticipant,
  type DemoTurn,
} from './fixtures';
import type { TurnMedia } from './ws-turn-frames';
import type { KeyChainResponse } from '@/lib/epoch-key-cache';
import type {
  ConversationListItem,
  ConversationResponse,
  ContentItemResponse,
  CreateConversationResponse,
  GetBalanceResponse,
  GetConversationResponse,
  ListConversationsResponse,
  MessageResponse,
} from '@hushbox/shared';

const DEMO_EPOCH_NUMBER = 1;
/** Fixed base so timestamps are deterministic (never `Date.now()`). */
const DEMO_BASE_MS = Date.parse('2026-06-01T12:00:00.000Z');
/** The allowance period key for the demo's frozen UTC day. */
const DEMO_DAY = utcDayKey(new Date(DEMO_BASE_MS));
/** Real free-tier daily allowance, as the NanoUSD wire string (1¢ = 1e7 nano). */
const DEMO_ALLOWANCE_NANO_USD = String(BigInt(FREE_ALLOWANCE_CENTS_VALUE) * 10_000_000n);
/** Reply streamed when a sent conversation has no scripted follow-up. */
const DEMO_GENERIC_REPLY =
  'This is an interactive demo, and every reply here is scripted. Create a free account to chat for real with any model.';

/** Streaming parameters returned for a director-driven send. */
export interface SendTurn {
  readonly userMessageId: string;
  readonly modelId: string;
  readonly assistantMessageId: string;
  readonly content: string;
  /**
   * Present when the reply is generated media (image/video): drives the
   * shim's synthetic `model:media:start`/`progress` frames and the generation
   * pause. Undefined for text replies.
   */
  readonly media?: TurnMedia;
}

/** The `message:new` event fields for a replayed group transcript message. */
export interface GroupMessageEvent {
  readonly messageId: string;
  readonly senderType: 'user' | 'ai';
  readonly sequenceNumber: number;
  /** Omitted for the demo user's own message (avoids the client's self-skip). */
  readonly senderId?: string;
}

export interface DemoMember {
  id: string;
  userId: string | null;
  linkId: string | null;
  username: string | null;
  privilege: 'owner' | 'admin' | 'write' | 'read';
  visibleFromEpoch: number;
  joinedAt: string;
  accepted: boolean;
}

export type DemoBalance = GetBalanceResponse;

/** Wire shape of GET /conversations/:id — the membership-carrying detail. */
export interface DemoConversationDetail {
  conversation: GetConversationResponse['conversation'];
  membership: {
    privilege: 'owner' | 'admin' | 'write' | 'read';
    muted: boolean;
    pinned: boolean;
    accepted: boolean;
    visibleFromEpoch: number;
    lastReadSeq: number;
  };
  forks: GetConversationResponse['forks'];
}

/** Wire shape of one GET /conversations/:id/messages history page. */
export interface DemoMessagesPage {
  messages: {
    id: string;
    parentMessageId: string | null;
    sequenceNumber: number;
    epochNumber: number;
    senderType: 'user' | 'assistant' | 'system';
    senderId: string | null;
    wrappedContentKey: string;
    batchId: string;
    contentItems: {
      id: string;
      position: number;
      contentType: 'text' | 'image' | 'audio' | 'video';
      mimeType: string | null;
      byteLength: number | null;
      encryptedBlob: string | null;
      /** Generating model id, or null for user/system items. */
      modelName: string | null;
      /** Billed cost anchored to this item as a canonical NanoUSD string, or null. */
      cost: string | null;
      isSmartModel: boolean;
    }[];
  }[];
  nextCursor: string | null;
}

export interface DemoMediaDownloadUrl {
  downloadUrl: string;
  expiresAt: string;
}

interface BuiltConversation {
  readonly epoch: DemoEpoch;
  readonly listItem: ConversationListItem;
  readonly response: GetConversationResponse;
  /**
   * The conversation's current transcript — the store's working state, replayed
   * live and served (adapted) by `getMessages`/`getMessagesPage`. Kept apart
   * from `response` because the GET /:id wire body no longer embeds messages
   * (a separate paginated history endpoint serves them).
   */
  messages: MessageResponse[];
  readonly keyChain: KeyChainResponse;
  readonly members: DemoMember[];
  /** Solo conversations: the turns the director replays. Group/new-chat have none. */
  readonly script: readonly DemoTurn[] | undefined;
  /** Group conversations: the transcript the director replays over the fake socket. */
  readonly groupTranscript: readonly DemoMessage[] | undefined;
  /** Composer modality the director switches to before replaying a scripted conversation. */
  readonly modality: DemoModality | undefined;
  /** Index of the next scripted/transcript entry to stream. Reset to 0 on replay. */
  cursor: number;
}

function isoAt(offsetMinutes: number): string {
  return new Date(DEMO_BASE_MS + offsetMinutes * 60_000).toISOString();
}

/**
 * The caller's membership on every demo conversation: the demo user owns them
 * all. Sourced into each conversation's GET /:id wire body.
 */
const DEMO_MEMBERSHIP: GetConversationResponse['membership'] = {
  privilege: 'owner',
  muted: false,
  pinned: false,
  accepted: true,
  visibleFromEpoch: 1,
  // The demo never acknowledges reads — there is no server to PATCH.
  lastReadSeq: 0,
};

/** The lone member of a solo (non-group) conversation: the demo user. */
const SOLO_MEMBER: DemoMember = {
  id: 'demo-member-self',
  userId: DEMO_USER.id,
  linkId: null,
  username: DEMO_USER.username,
  privilege: 'owner',
  visibleFromEpoch: 1,
  joinedAt: isoAt(0),
  accepted: true,
};

/** The concatenated text of a message's text content (media items contribute nothing). */
function textOf(content: readonly DemoContent[]): string {
  return content.map((item) => (item.type === 'text' ? item.text : '')).join('');
}

/** Media attributes of a scripted turn's first media item, or undefined for a text-only turn. */
function mediaOf(content: readonly DemoContent[]): TurnMedia | undefined {
  const item = content.find((c): c is Exclude<DemoContent, { type: 'text' }> => c.type !== 'text');
  return item === undefined ? undefined : { mediaType: item.type, mimeType: item.asset.mimeType };
}

/** Media attributes of a wire message's first media content item, or undefined for text-only. */
function mediaOfContentItems(items: readonly ContentItemResponse[]): TurnMedia | undefined {
  const item = items.find(
    (c): c is ContentItemResponse & { contentType: 'image' | 'video' } =>
      c.contentType === 'image' || c.contentType === 'video'
  );
  return item === undefined
    ? undefined
    : /* v8 ignore start -- buildContentItem always sets mimeType on image/video items, so the octet-stream fallback is unreachable */
      { mediaType: item.contentType, mimeType: item.mimeType ?? 'application/octet-stream' };
  /* v8 ignore stop */
}

/** The model id to attribute a regenerated reply to: the request's, else the replaced one's. */
function regenerateModelId(models: string[] | undefined, original: MessageResponse): string {
  return models?.[0] ?? original.contentItems[0]?.modelName ?? 'demo-model';
}

function toWireMember(participant: DemoParticipant): DemoMember {
  return {
    id: `demo-member-${participant.userId}`,
    userId: participant.userId,
    linkId: null,
    username: participant.username,
    privilege: participant.privilege,
    visibleFromEpoch: 1,
    joinedAt: isoAt(0),
    accepted: true,
  };
}

export class DemoBackendStore {
  private readonly built = new Map<string, BuiltConversation>();
  private readonly order: string[] = [];
  /** Ciphertext of each media content item, keyed by content-item id. */
  private readonly media = new Map<string, Uint8Array>();
  /** Plaintext of each AI message (for re-streaming on regenerate), keyed by message id. */
  private readonly aiText = new Map<string, string>();
  /**
   * Plaintext content items of each assistant message, keyed by message id.
   * Regenerate re-encrypts these under the clone's fresh message id — the
   * content envelope binds `messageId` as AAD, so reusing the original
   * ciphertext under a new id would no longer decrypt.
   */
  private readonly assistantContent = new Map<string, readonly DemoContent[]>();

  constructor(private readonly accountPublicKey: Uint8Array) {
    for (const [index, conversation] of DEMO_CONVERSATIONS.entries()) {
      this.built.set(conversation.id, this.buildConversation(conversation, index));
      this.order.push(conversation.id);
    }
  }

  listConversations(): ListConversationsResponse {
    return {
      conversations: this.order.map((id) => this.requireBuilt(id).listItem),
      nextCursor: null,
    };
  }

  getConversation(id: string): DemoConversationDetail | undefined {
    const built = this.built.get(id);
    if (built === undefined) return undefined;
    // The wire detail no longer embeds `messages` (the paginated history
    // endpoint serves them) and carries the caller's facts as `membership`
    // (see `ConversationDetailResponse` in `hooks/chat/chat.ts` — the type is
    // route-local, so the shape is mirrored here). The internal `response`
    // keeps the embedded messages as the store's working state.
    return {
      conversation: built.response.conversation,
      membership: built.response.membership,
      forks: built.response.forks,
    };
  }

  /** The full `MessageResponse` view of a conversation's current transcript. */
  getMessages(id: string): MessageResponse[] | undefined {
    return this.built.get(id)?.messages;
  }

  /**
   * One full page of GET /conversations/:id/messages — the slim history wire
   * shape the app's `fetchAllMessages` consumes (see `HistoryMessage` in
   * `hooks/chat/chat.ts`; the type is route-local, so the shape is mirrored
   * here). The demo never paginates: everything ships in one page.
   */
  getMessagesPage(id: string): DemoMessagesPage | undefined {
    const built = this.built.get(id);
    if (built === undefined) return undefined;
    return {
      messages: built.messages.map((message) => ({
        id: message.id,
        parentMessageId: message.parentMessageId,
        sequenceNumber: message.sequenceNumber,
        epochNumber: message.epochNumber,
        senderType: message.senderType === 'user' ? 'user' : 'assistant',
        senderId: message.senderId,
        wrappedContentKey: message.wrappedContentKey,
        batchId: message.batchId,
        contentItems: message.contentItems.map((item) => ({
          id: item.id,
          position: item.position,
          contentType: item.contentType,
          mimeType: item.mimeType,
          byteLength: item.sizeBytes,
          encryptedBlob: item.encryptedBlob,
          // Settled display metadata the real history wire carries, so the same
          // client adapter (`toContentItemResponse`) renders cost/model/Smart chip.
          modelName: item.modelName,
          cost: item.cost,
          isSmartModel: item.isSmartModel,
        })),
      })),
      nextCursor: null,
    };
  }

  /** The composer modality a scripted conversation showcases, else undefined. */
  getModality(id: string): DemoModality | undefined {
    const built = this.built.get(id);
    return built?.script === undefined ? undefined : built.modality;
  }

  /** The user prompt of the next unplayed scripted turn, or null if none remain. */
  peekNextUserText(id: string): string | null {
    const built = this.built.get(id);
    if (built?.script === undefined) return null;
    return built.script[built.cursor]?.user ?? null;
  }

  getKeyChain(id: string): KeyChainResponse | undefined {
    return this.built.get(id)?.keyChain;
  }

  getKeyChainBatch(ids: string[]): { keys: Record<string, KeyChainResponse>; missing: string[] } {
    const keys: Record<string, KeyChainResponse> = {};
    const missing: string[] = [];
    for (const id of ids) {
      const built = this.built.get(id);
      if (built) keys[id] = built.keyChain;
      else missing.push(id);
    }
    return { keys, missing };
  }

  getBalance(): DemoBalance {
    // Large purchased balance → demo user reads as a paid tier, so every
    // model is selectable. Allowance is untouched on the demo's frozen day.
    return {
      purchased: { balanceNanoUsd: '100000000000' },
      free: { balanceNanoUsd: '0' },
      allowance: {
        day: DEMO_DAY,
        limitNanoUsd: DEMO_ALLOWANCE_NANO_USD,
        spentNanoUsd: '0',
        remainingNanoUsd: DEMO_ALLOWANCE_NANO_USD,
      },
    };
  }

  getMembers(id: string): { members: DemoMember[] } {
    // Solo conversations report a single member (the demo user) so no group
    // websocket opens; group conversations report their full roster.
    return { members: this.built.get(id)?.members ?? [SOLO_MEMBER] };
  }

  getLinks(_id: string): { links: [] } {
    return { links: [] };
  }

  /**
   * Presigned GET URL for an encrypted media item, as a same-origin path the
   * fetch-shim serves (see {@link getMediaBytes}). A same-origin URL — not a
   * `data:` URL — is required so the demo CSP `connect-src 'self'` permits the
   * real `useDecryptBlob` fetch, which then symmetric-decrypts the genuine
   * ciphertext with the message content key (the demo decrypts real bytes
   * rather than reading plaintext).
   */
  getMediaDownloadUrl(contentItemId: string): DemoMediaDownloadUrl | undefined {
    if (!this.media.has(contentItemId)) return undefined;
    return {
      downloadUrl: `/media/${contentItemId}/blob`,
      expiresAt: isoAt(MEDIA_DOWNLOAD_URL_TTL_SECONDS / 60),
    };
  }

  /** Ciphertext bytes for a media content item, served by the shim's blob route. */
  getMediaBytes(contentItemId: string): Uint8Array | undefined {
    return this.media.get(contentItemId);
  }

  /**
   * Record a director-driven send: append the (encrypted) user + assistant turn
   * so the post-`done` refetch decrypts to the streamed reply, and return the
   * SSE parameters. Scripted conversations stream the next scripted turn (text
   * or media); anything past the script gets a generic "this is a demo" reply.
   * The requested model is ignored for the reply content (the script is fixed).
   */
  recordSendTurn(
    conversationId: string,
    userMessage: { id: string; content: string },
    modelId: string
  ): SendTurn | undefined {
    const built = this.built.get(conversationId);
    if (built === undefined) return undefined;

    if (built.script !== undefined && built.cursor < built.script.length) {
      const turn = built.script[built.cursor];
      /* v8 ignore next -- cursor < script.length guarantees script[cursor] is defined; the undefined guard satisfies noUncheckedIndexedAccess only */
      if (turn !== undefined) {
        built.cursor += 1;
        return this.appendTurn(built, conversationId, { userMessage, modelId }, turn);
      }
    }
    return this.appendTurn(
      built,
      conversationId,
      { userMessage, modelId },
      {
        user: userMessage.content,
        ai: [{ type: 'text', text: DEMO_GENERIC_REPLY }],
      }
    );
  }

  /** Reset a conversation to empty so the director can replay its script from scratch. */
  resetConversation(conversationId: string): void {
    const built = this.built.get(conversationId);
    if (built === undefined) return;
    built.messages = [];
    built.response.conversation.nextSequence = 0;
    built.cursor = 0;
  }

  /**
   * Build a conversation straight to its finished state — every script turn or
   * group message appended at once, no streaming. Used when re-opening a
   * conversation the user already watched to the end: it shows complete with no
   * replay ceremony.
   *
   * `limit` pre-fills only the first `limit` scripted turns (cursor advanced per
   * filled turn) so a later `recordSendTurn` streams the next turn live — the
   * frozen ad-capture backdrop. Undefined fills the whole script (unchanged);
   * a `limit` past the script length behaves like fill-all, `0` fills nothing.
   * Group transcripts ignore `limit` (no live-streaming backdrop use case).
   */
  fillConversation(conversationId: string, limit?: number): void {
    const built = this.built.get(conversationId);
    if (built === undefined) return;
    this.resetConversation(conversationId);
    if (built.script !== undefined) {
      const turns = limit === undefined ? built.script : built.script.slice(0, limit);
      for (const turn of turns) {
        // Pre-fill (frozen capture backdrop) has no live model selection to
        // read, so filled replies are attributed to the documented constant.
        this.appendTurn(
          built,
          conversationId,
          {
            userMessage: { id: crypto.randomUUID(), content: turn.user },
            modelId: DEMO_GROUP_MODEL_ID,
          },
          turn
        );
        built.cursor += 1;
      }
      return;
    }
    while (this.appendNextGroupMessage(conversationId) !== null) {
      /* append every group transcript message */
    }
  }

  /** True for a conversation the director replays message-by-message over the socket. */
  isGroupConversation(conversationId: string): boolean {
    return this.built.get(conversationId)?.groupTranscript !== undefined;
  }

  /**
   * Inspect the next transcript message without appending it. `typingUserId` is
   * the sender to show a typing indicator for — null for the demo user's own
   * message (you don't watch yourself type). Null return = transcript exhausted.
   */
  peekNextGroupMessage(conversationId: string): { typingUserId: string | null } | null {
    const built = this.built.get(conversationId);
    const message = built?.groupTranscript?.[built.cursor];
    if (message === undefined) return null;
    const sender = message.senderId;
    return { typingUserId: sender === undefined || sender === DEMO_USER.id ? null : sender };
  }

  /** Text of the next group transcript message — what the director types on the welcome lead-in. */
  peekNextGroupText(conversationId: string): string | null {
    const built = this.built.get(conversationId);
    const message = built?.groupTranscript?.[built.cursor];
    return message === undefined ? null : textOf(message.content);
  }

  /**
   * Append the next transcript message (encrypted) so the post-`message:new`
   * refetch renders it, and return the event fields the director broadcasts.
   * `senderId` is omitted for the demo user's own message so the client's
   * skip-own-message guard doesn't suppress the refetch. Null = nothing left.
   */
  appendNextGroupMessage(conversationId: string): GroupMessageEvent | null {
    const built = this.built.get(conversationId);
    const message = built?.groupTranscript?.[built.cursor];
    if (built === undefined || message === undefined) return null;
    const messages = built.messages;
    const wire = this.buildMessage(built.epoch, {
      conversationId,
      message,
      messageIndex: messages.length,
      parentMessageId: messages.at(-1)?.id ?? null,
      conversationIndex: 0,
    });
    messages.push(wire);
    built.response.conversation.nextSequence = messages.length;
    built.cursor += 1;
    return {
      messageId: wire.id,
      senderType: wire.senderType,
      sequenceNumber: wire.sequenceNumber,
      ...(message.senderId === DEMO_USER.id ? {} : { senderId: message.senderId }),
    };
  }

  /**
   * Append an encrypted user + assistant turn (assistant content may be text or
   * media). The reply is attributed to `send.modelId` — the model the send
   * selected (D-D) — not a per-fixture constant. `turn.cost`, when present, is
   * anchored to the reply's first content item so the message-cost badge renders.
   */
  private appendTurn(
    built: BuiltConversation,
    conversationId: string,
    send: { userMessage: { id: string; content: string }; modelId: string },
    turn: DemoTurn
  ): SendTurn {
    const { userMessage, modelId } = send;
    const messages = built.messages;
    const baseSequence = messages.length;
    const baseTime = DEMO_BASE_MS + (1000 + baseSequence) * 60_000;
    const parentMessageId = messages.at(-1)?.id ?? null;

    const userMsg = this.buildTextMessage(built.epoch, {
      id: userMessage.id,
      conversationId,
      senderType: 'user',
      senderId: DEMO_USER.id,
      modelName: null,
      isSmartModel: false,
      text: userMessage.content,
      sequenceNumber: baseSequence,
      parentMessageId,
      createdAt: new Date(baseTime).toISOString(),
    });

    const assistantMessageId = crypto.randomUUID();
    const envelope = beginMessage(built.epoch, {
      conversationId,
      messageId: assistantMessageId,
      senderId: null,
      epochNumber: built.epoch.epochNumber,
    });
    const attribution = {
      modelName: modelId,
      isSmartModel: turn.isSmartModel ?? false,
      cost: turn.cost ?? null,
    };
    const contentItems = turn.ai.map((content, position) =>
      this.buildContentItem(envelope, content, position, attribution)
    );
    const aiText = textOf(turn.ai);
    this.aiText.set(assistantMessageId, aiText);
    this.assistantContent.set(assistantMessageId, turn.ai);

    messages.push(userMsg, {
      id: assistantMessageId,
      conversationId,
      wrappedContentKey: envelope.wrappedContentKey,
      senderType: 'ai',
      senderId: null,
      epochNumber: built.epoch.epochNumber,
      sequenceNumber: baseSequence + 1,
      parentMessageId: userMessage.id,
      batchId: crypto.randomUUID(),
      createdAt: new Date(baseTime + 1000).toISOString(),
      contentItems,
    });
    built.response.conversation.nextSequence = messages.length;

    const media = mediaOf(turn.ai);
    return {
      userMessageId: userMessage.id,
      modelId,
      assistantMessageId,
      content: aiText,
      ...(media === undefined ? {} : { media }),
    };
  }

  /**
   * Record a regenerate/retry: replace the targeted assistant message(s) with a
   * fresh clone (new id, content re-encrypted under that id) so the post-`done`
   * refetch is consistent, and return the SSE parameters that re-stream its
   * text. The content envelope binds `messageId` as AAD, so the clone must
   * re-encrypt the retained plaintext under its new id rather than reuse the
   * original ciphertext — mirroring the real regenerate, which produces genuinely
   * new content. Mirrors the real retry-all (delete every AI child of
   * `targetMessageId`) and regenerate-one (`replaceAssistantId`) scopes; both
   * collapse to one replacement for the demo's single-model turns.
   */
  recordRegenerateTurn(request: {
    conversationId: string;
    targetMessageId: string;
    replaceAssistantId?: string;
    models?: string[];
  }): SendTurn | undefined {
    const built = this.built.get(request.conversationId);
    if (built === undefined) return undefined;
    const messages = built.messages;

    const isAiChildOfTarget = (message: MessageResponse): boolean =>
      message.senderType === 'ai' && message.parentMessageId === request.targetMessageId;
    const matches =
      request.replaceAssistantId === undefined
        ? isAiChildOfTarget
        : (message: MessageResponse): boolean => message.id === request.replaceAssistantId;

    const firstIndex = messages.findIndex((message) => matches(message));
    if (firstIndex === -1) return undefined;
    const original = messages[firstIndex];
    /* v8 ignore next -- firstIndex !== -1 guarantees messages[firstIndex] is defined; the undefined guard satisfies noUncheckedIndexedAccess only */
    if (original === undefined) return undefined;

    const clone = this.regenerateAssistantClone(built, original);
    // Remove every matched assistant (retry-all may have replaced siblings), then
    // insert the single clone where the first one was.
    const remaining = messages.filter((message) => !matches(message));
    remaining.splice(firstIndex, 0, clone);
    built.messages = remaining;

    const media = mediaOfContentItems(original.contentItems);
    return {
      userMessageId: original.parentMessageId ?? request.targetMessageId,
      modelId: regenerateModelId(request.models, original),
      assistantMessageId: clone.id,
      /* v8 ignore start -- regenerateAssistantClone registers the clone's aiText before this read, so the '' fallback is unreachable */
      content: this.aiText.get(clone.id) ?? '',
      /* v8 ignore stop */
      ...(media === undefined ? {} : { media }),
    };
  }

  /**
   * Build a fresh assistant-message clone of `original` with its content
   * re-encrypted under the clone's new id (the content envelope binds
   * `messageId` as AAD, so reusing the original ciphertext under a new id would
   * not decrypt), and register the clone's re-streamable text + plaintext content.
   */
  private regenerateAssistantClone(
    built: BuiltConversation,
    original: MessageResponse
  ): MessageResponse {
    const assistantMessageId = crypto.randomUUID();
    const originalContent = this.assistantContent.get(original.id) ?? [];
    const envelope = beginMessage(built.epoch, {
      conversationId: original.conversationId,
      messageId: assistantMessageId,
      senderId: original.senderId,
      epochNumber: original.epochNumber,
    });
    const attribution = {
      modelName: original.contentItems[0]?.modelName ?? null,
      /* v8 ignore start -- content items always carry a boolean isSmartModel, so the ?? false fallback is unreachable */
      isSmartModel: original.contentItems[0]?.isSmartModel ?? false,
      /* v8 ignore stop */
      cost: original.contentItems[0]?.cost ?? null,
    };
    const clone: MessageResponse = {
      ...original,
      id: assistantMessageId,
      wrappedContentKey: envelope.wrappedContentKey,
      batchId: crypto.randomUUID(),
      contentItems: originalContent.map((content, position) =>
        this.buildContentItem(envelope, content, position, attribution)
      ),
    };
    this.aiText.set(assistantMessageId, this.aiText.get(original.id) ?? '');
    this.assistantContent.set(assistantMessageId, originalContent);
    return clone;
  }

  /**
   * Record a conversation created live (the new-chat flow). The client made the
   * epoch and sends only its public key, so we encrypt future turns to it; the
   * client already holds the matching private key in its cache, so no key chain
   * is served. The director opens the showcase conversations by id (never via
   * create), so a created conversation is always a real user-initiated new chat:
   * it has no script and streams the generic "this is a demo" reply.
   */
  createConversation(request: {
    id: string;
    title?: string;
    epochPublicKey: string;
  }): CreateConversationResponse {
    const epoch: DemoEpoch = {
      epochNumber: DEMO_EPOCH_NUMBER,
      epochPublicKey: fromBase64(request.epochPublicKey),
      epochPrivateKey: new Uint8Array(),
      confirmationHash: new Uint8Array(),
      memberWrap: new Uint8Array(),
    };
    const now = new Date(DEMO_BASE_MS + 5000 * 60_000).toISOString();
    const conversation: ConversationResponse = {
      id: request.id,
      title: request.title ?? '',
      currentEpoch: DEMO_EPOCH_NUMBER,
      titleEpochNumber: DEMO_EPOCH_NUMBER,
      nextSequence: 0,
      createdAt: now,
      updatedAt: now,
    };
    const listItem: ConversationListItem = {
      ...conversation,
      accepted: true,
      invitedByUsername: null,
      privilege: 'owner',
      muted: false,
      pinned: false,
      lastReadSeq: 0,
    };
    const response: GetConversationResponse = {
      conversation,
      membership: DEMO_MEMBERSHIP,
      forks: [],
    };
    this.built.set(request.id, {
      epoch,
      listItem,
      response,
      messages: [],
      keyChain: { wraps: [], chainLinks: [], currentEpoch: DEMO_EPOCH_NUMBER },
      script: undefined,
      groupTranscript: undefined,
      modality: undefined,
      cursor: 0,
      members: [SOLO_MEMBER],
    });
    return {
      conversation,
      created: true,
    };
  }

  private buildTextMessage(
    epoch: DemoEpoch,
    options: {
      id: string;
      conversationId: string;
      senderType: 'user' | 'ai';
      senderId: string | null;
      modelName: string | null;
      isSmartModel: boolean;
      text: string;
      sequenceNumber: number;
      parentMessageId: string | null;
      createdAt: string;
    }
  ): MessageResponse {
    const envelope = beginMessage(epoch, {
      conversationId: options.conversationId,
      messageId: options.id,
      senderId: options.senderId,
      epochNumber: epoch.epochNumber,
    });
    const contentItemId = crypto.randomUUID();
    return {
      id: options.id,
      conversationId: options.conversationId,
      wrappedContentKey: envelope.wrappedContentKey,
      senderType: options.senderType,
      senderId: options.senderId,
      epochNumber: epoch.epochNumber,
      sequenceNumber: options.sequenceNumber,
      parentMessageId: options.parentMessageId,
      batchId: crypto.randomUUID(),
      createdAt: options.createdAt,
      contentItems: [
        {
          id: contentItemId,
          contentType: 'text',
          position: 0,
          encryptedBlob: envelope.encryptText(contentItemId, 0, options.text),
          storageKey: null,
          mimeType: null,
          sizeBytes: null,
          width: null,
          height: null,
          durationMs: null,
          modelName: options.modelName,
          cost: null,
          isSmartModel: options.isSmartModel,
        },
      ],
    };
  }

  private buildConversation(conversation: DemoConversation, index: number): BuiltConversation {
    const epoch = createDemoEpoch(this.accountPublicKey, conversation.id, DEMO_EPOCH_NUMBER);
    const createdAt = isoAt(index * 60);
    const conversationEntity: ConversationResponse = {
      id: conversation.id,
      title: encryptForEpoch(epoch, conversation.title),
      currentEpoch: DEMO_EPOCH_NUMBER,
      titleEpochNumber: DEMO_EPOCH_NUMBER,
      nextSequence: 0,
      createdAt,
      updatedAt: createdAt,
    };

    // Every conversation is served empty and replayed live: scripted ones via
    // the composer, the group one message-by-message over the fake socket.
    const messages: MessageResponse[] = [];

    const listItem: ConversationListItem = {
      ...conversationEntity,
      accepted: true,
      invitedByUsername: null,
      privilege: 'owner',
      muted: false,
      pinned: false,
      lastReadSeq: 0,
    };

    const response: GetConversationResponse = {
      conversation: conversationEntity,
      membership: DEMO_MEMBERSHIP,
      forks: [],
    };

    return {
      epoch,
      listItem,
      response,
      messages,
      keyChain: buildKeyChain(epoch),
      script: conversation.script,
      groupTranscript: conversation.messages,
      modality: conversation.modality,
      cursor: 0,
      members: conversation.members
        ? conversation.members.map((participant) => toWireMember(participant))
        : [SOLO_MEMBER],
    };
  }

  private buildMessage(
    epoch: DemoEpoch,
    options: {
      conversationId: string;
      message: DemoMessage;
      messageIndex: number;
      parentMessageId: string | null;
      conversationIndex: number;
    }
  ): MessageResponse {
    const { conversationId, message, messageIndex, parentMessageId, conversationIndex } = options;
    const isAi = message.sender === 'ai';
    const id = crypto.randomUUID();
    /* v8 ignore next -- buildMessage runs only over the demo-group transcript, whose messages all carry a senderId and are all non-AI, so the ?? ternary is unreachable */
    const senderId = message.senderId ?? (isAi ? null : DEMO_USER.id);
    const envelope = beginMessage(epoch, {
      conversationId,
      messageId: id,
      senderId,
      epochNumber: epoch.epochNumber,
    });
    const attribution = {
      // Group AI replies have no picker to read; they take the documented
      // constant. User messages carry no model. Group messages carry no cost.
      /* v8 ignore start -- the demo-group transcript has no AI messages, so the isAi arm is unreachable */
      modelName: isAi ? DEMO_GROUP_MODEL_ID : null,
      /* v8 ignore stop */
      isSmartModel: message.isSmartModel ?? false,
      cost: null,
    };
    const contentItems: ContentItemResponse[] = message.content.map((content, position) =>
      this.buildContentItem(envelope, content, position, attribution)
    );

    /* v8 ignore next 4 -- the demo-group transcript has no AI messages, so this isAi block is unreachable */
    if (isAi) {
      this.aiText.set(id, textOf(message.content));
      this.assistantContent.set(id, message.content);
    }
    return {
      id,
      conversationId,
      wrappedContentKey: envelope.wrappedContentKey,
      /* v8 ignore start -- the demo-group transcript has no AI messages, so the 'ai' arm is unreachable */
      senderType: isAi ? 'ai' : 'user',
      /* v8 ignore stop */
      senderId,
      epochNumber: epoch.epochNumber,
      sequenceNumber: messageIndex,
      parentMessageId,
      batchId: crypto.randomUUID(),
      createdAt: isoAt(conversationIndex * 60 + messageIndex),
      contentItems,
    };
  }

  /**
   * Build one content item. Text items carry their ciphertext inline; media
   * items leave `encryptedBlob` null and register the encrypted asset bytes for
   * the download-url route. Both share the message's single content key.
   */
  private buildContentItem(
    envelope: MessageEnvelope,
    content: DemoContent,
    position: number,
    attribution: { modelName: string | null; isSmartModel: boolean; cost: string | null }
  ): ContentItemResponse {
    const id = crypto.randomUUID();
    const base = {
      id,
      position,
      modelName: attribution.modelName,
      // The reply's whole billed cost is anchored to the first content item (as
      // real settlement anchors it), so `sumCost` over the message totals it
      // once; later items carry null.
      /* v8 ignore start -- no demo message carries more than one content item, so position is always 0 and the null arm is unreachable */
      cost: position === 0 ? attribution.cost : null,
      /* v8 ignore stop */
      isSmartModel: attribution.isSmartModel,
      storageKey: null,
      mimeType: null,
      sizeBytes: null,
      width: null,
      height: null,
      durationMs: null,
    };
    if (content.type === 'text') {
      return {
        ...base,
        contentType: 'text',
        encryptedBlob: envelope.encryptText(id, position, content.text),
      };
    }
    this.media.set(id, envelope.encryptBinary(id, position, content.asset.bytes));
    return {
      ...base,
      contentType: content.type,
      encryptedBlob: null,
      storageKey: `demo:${id}`,
      mimeType: content.asset.mimeType,
      sizeBytes: content.asset.bytes.length,
      width: content.asset.width,
      height: content.asset.height,
      durationMs: content.durationMs ?? null,
    };
  }

  private requireBuilt(id: string): BuiltConversation {
    const built = this.built.get(id);
    /* v8 ignore next -- requireBuilt is only called over this.order, whose ids are all built, so the throw is unreachable */
    if (built === undefined) throw new Error(`demo conversation not built: ${id}`);
    return built;
  }
}
