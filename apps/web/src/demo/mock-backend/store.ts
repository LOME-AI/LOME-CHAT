/**
 * In-browser fake backend for the demo. At construction it encrypts every
 * fixture conversation with real `@hushbox/crypto` (one epoch per
 * conversation, wrapped to the demo account) and caches the resulting wire
 * responses. Getter methods return the exact shapes the real app's read path
 * expects, so `useConversations` / `useDecryptedMessages` / `processKeyChain`
 * run unmodified against this store instead of the network.
 */
import { fromBase64, MEDIA_DOWNLOAD_URL_TTL_SECONDS } from '@hushbox/shared';
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
  GetConversationResponse,
  ListConversationsResponse,
  MessageResponse,
} from '@hushbox/shared';

const DEMO_EPOCH_NUMBER = 1;
/** Fixed base so timestamps are deterministic (never `Date.now()`). */
const DEMO_BASE_MS = Date.parse('2026-06-01T12:00:00.000Z');
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
  userId: string;
  linkId: string | null;
  username: string;
  privilege: 'owner' | 'admin' | 'write' | 'read';
  visibleFromEpoch: number;
  joinedAt: string;
}

export interface DemoBalance {
  balance: string;
  freeAllowanceCents: number;
}

export interface DemoMediaDownloadUrl {
  downloadUrl: string;
  expiresAt: string;
}

interface BuiltConversation {
  readonly epoch: DemoEpoch;
  readonly listItem: ConversationListItem;
  readonly response: GetConversationResponse;
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

/** The lone member of a solo (non-group) conversation: the demo user. */
const SOLO_MEMBER: DemoMember = {
  id: 'demo-member-self',
  userId: DEMO_USER.id,
  linkId: null,
  username: DEMO_USER.username,
  privilege: 'owner',
  visibleFromEpoch: 1,
  joinedAt: isoAt(0),
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
    : { mediaType: item.contentType, mimeType: item.mimeType ?? 'application/octet-stream' };
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
  };
}

export class DemoBackendStore {
  private readonly built = new Map<string, BuiltConversation>();
  private readonly order: string[] = [];
  /** Ciphertext of each media content item, keyed by content-item id. */
  private readonly media = new Map<string, Uint8Array>();
  /** Plaintext of each AI message (for re-streaming on regenerate), keyed by message id. */
  private readonly aiText = new Map<string, string>();

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

  getConversation(id: string): GetConversationResponse | undefined {
    return this.built.get(id)?.response;
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
    // Large balance → demo user reads as a paid tier, so every model is selectable.
    return { balance: '100.00000000', freeAllowanceCents: 500 };
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
      if (turn !== undefined) {
        built.cursor += 1;
        return this.appendTurn(built, conversationId, userMessage, turn);
      }
    }
    return this.appendTurn(built, conversationId, userMessage, {
      user: userMessage.content,
      ai: [{ type: 'text', text: DEMO_GENERIC_REPLY }],
      modelName: modelId,
    });
  }

  /** Reset a conversation to empty so the director can replay its script from scratch. */
  resetConversation(conversationId: string): void {
    const built = this.built.get(conversationId);
    if (built === undefined) return;
    built.response.messages = [];
    built.response.conversation.nextSequence = 0;
    built.cursor = 0;
  }

  /**
   * Build a conversation straight to its finished state — every script turn or
   * group message appended at once, no streaming. Used when re-opening a
   * conversation the user already watched to the end: it shows complete with no
   * replay ceremony.
   */
  fillConversation(conversationId: string): void {
    const built = this.built.get(conversationId);
    if (built === undefined) return;
    this.resetConversation(conversationId);
    if (built.script !== undefined) {
      for (const turn of built.script) {
        this.appendTurn(
          built,
          conversationId,
          { id: crypto.randomUUID(), content: turn.user },
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
    const messages = built.response.messages;
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

  /** Append an encrypted user + assistant turn (assistant content may be text or media). */
  private appendTurn(
    built: BuiltConversation,
    conversationId: string,
    userMessage: { id: string; content: string },
    turn: DemoTurn
  ): SendTurn {
    const messages = built.response.messages;
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
    const envelope = beginMessage(built.epoch);
    const attribution = {
      modelName: turn.modelName ?? null,
      isSmartModel: turn.isSmartModel ?? false,
    };
    const contentItems = turn.ai.map((content, position) =>
      this.buildContentItem(envelope, content, position, attribution)
    );
    const aiText = textOf(turn.ai);
    this.aiText.set(assistantMessageId, aiText);

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
      modelId: turn.modelName ?? 'demo-model',
      assistantMessageId,
      content: aiText,
      ...(media === undefined ? {} : { media }),
    };
  }

  /**
   * Record a regenerate/retry: replace the targeted assistant message(s) with a
   * fresh clone (new id, same content + content-item ids so media ciphertext
   * stays valid) so the post-`done` refetch is consistent, and return the SSE
   * parameters that re-stream its text. Mirrors the real retry-all (delete every
   * AI child of `targetMessageId`) and regenerate-one (`replaceAssistantId`)
   * scopes; both collapse to one replacement for the demo's single-model turns.
   */
  recordRegenerateTurn(request: {
    conversationId: string;
    targetMessageId: string;
    replaceAssistantId?: string;
    models?: string[];
  }): SendTurn | undefined {
    const built = this.built.get(request.conversationId);
    if (built === undefined) return undefined;
    const messages = built.response.messages;

    const isAiChildOfTarget = (message: MessageResponse): boolean =>
      message.senderType === 'ai' && message.parentMessageId === request.targetMessageId;
    const matches =
      request.replaceAssistantId === undefined
        ? isAiChildOfTarget
        : (message: MessageResponse): boolean => message.id === request.replaceAssistantId;

    const firstIndex = messages.findIndex((message) => matches(message));
    if (firstIndex === -1) return undefined;
    const original = messages[firstIndex];
    if (original === undefined) return undefined;

    const assistantMessageId = crypto.randomUUID();
    const clone: MessageResponse = {
      ...original,
      id: assistantMessageId,
      batchId: crypto.randomUUID(),
    };
    // Remove every matched assistant (retry-all may have replaced siblings), then
    // insert the single clone where the first one was.
    const remaining = messages.filter((message) => !matches(message));
    remaining.splice(firstIndex, 0, clone);
    built.response.messages = remaining;

    const content = this.aiText.get(original.id) ?? '';
    this.aiText.set(assistantMessageId, content);
    const media = mediaOfContentItems(original.contentItems);
    return {
      userMessageId: original.parentMessageId ?? request.targetMessageId,
      modelId: regenerateModelId(request.models, original),
      assistantMessageId,
      content,
      ...(media === undefined ? {} : { media }),
    };
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
      userId: DEMO_USER.id,
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
    };
    const response: GetConversationResponse = {
      conversation,
      messages: [],
      forks: [],
      accepted: true,
      invitedByUsername: null,
      callerId: DEMO_USER.id,
      privilege: 'owner',
    };
    this.built.set(request.id, {
      epoch,
      listItem,
      response,
      keyChain: { wraps: [], chainLinks: [], currentEpoch: DEMO_EPOCH_NUMBER },
      script: undefined,
      groupTranscript: undefined,
      modality: undefined,
      cursor: 0,
      members: [SOLO_MEMBER],
    });
    return {
      conversation,
      messages: [],
      forks: [],
      created: true,
      accepted: true,
      invitedByUsername: null,
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
    const envelope = beginMessage(epoch);
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
          id: crypto.randomUUID(),
          contentType: 'text',
          position: 0,
          encryptedBlob: envelope.encryptText(options.text),
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
    const epoch = createDemoEpoch(this.accountPublicKey, DEMO_EPOCH_NUMBER);
    const createdAt = isoAt(index * 60);
    const conversationEntity: ConversationResponse = {
      id: conversation.id,
      userId: DEMO_USER.id,
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
    };

    const response: GetConversationResponse = {
      conversation: conversationEntity,
      messages,
      forks: [],
      accepted: true,
      invitedByUsername: null,
      callerId: DEMO_USER.id,
      privilege: 'owner',
    };

    return {
      epoch,
      listItem,
      response,
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
    const envelope = beginMessage(epoch);
    const isAi = message.sender === 'ai';
    const attribution = {
      modelName: isAi ? (message.modelName ?? null) : null,
      isSmartModel: message.isSmartModel ?? false,
    };
    const contentItems: ContentItemResponse[] = message.content.map((content, position) =>
      this.buildContentItem(envelope, content, position, attribution)
    );

    const id = crypto.randomUUID();
    if (isAi) this.aiText.set(id, textOf(message.content));
    return {
      id,
      conversationId,
      wrappedContentKey: envelope.wrappedContentKey,
      senderType: isAi ? 'ai' : 'user',
      senderId: message.senderId ?? (isAi ? null : DEMO_USER.id),
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
    attribution: { modelName: string | null; isSmartModel: boolean }
  ): ContentItemResponse {
    const id = crypto.randomUUID();
    const base = {
      id,
      position,
      modelName: attribution.modelName,
      cost: null,
      isSmartModel: attribution.isSmartModel,
      storageKey: null,
      mimeType: null,
      sizeBytes: null,
      width: null,
      height: null,
      durationMs: null,
    };
    if (content.type === 'text') {
      return { ...base, contentType: 'text', encryptedBlob: envelope.encryptText(content.text) };
    }
    this.media.set(id, envelope.encryptBinary(content.asset.bytes));
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
    if (built === undefined) throw new Error(`demo conversation not built: ${id}`);
    return built;
  }
}
