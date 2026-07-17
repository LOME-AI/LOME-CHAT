import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateKeyPair,
  createFirstEpoch,
  unwrapContentKeyFromEpoch,
  decryptContentEnvelope,
  decryptTextFromEpoch,
  asEpochPrivateKey,
  type KeyPair,
  type WrappedSecret,
} from '@hushbox/crypto';
import { fromBase64, toBase64, listConversationsResponseSchema } from '@hushbox/shared';
import { processKeyChain, getEpochKey, clearEpochKeyCache } from '@/lib/epoch-key-cache';
import { DemoBackendStore } from './store';
import { DEMO_CONVERSATIONS, DEMO_BOOT_ID, DEMO_GROUP_MODEL_ID, DEMO_USER } from './fixtures';
import { DEMO_SCENE_IMAGE, DEMO_GENERATED_VIDEO } from './media-assets';

function decryptMessageTexts(
  store: DemoBackendStore,
  account: KeyPair,
  conversationId: string
): { senderType: string; text: string }[] {
  const keyChain = store.getKeyChain(conversationId);
  if (keyChain === undefined) throw new Error('no keychain');
  processKeyChain(conversationId, keyChain, account.privateKey);
  const messages = store.getMessages(conversationId);
  if (messages === undefined) throw new Error('no conversation');
  return messages.map((message) => {
    const epochKey = getEpochKey(conversationId, message.epochNumber);
    if (epochKey === undefined) throw new Error('no epoch key');
    const wrapped = fromBase64(message.wrappedContentKey) as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epochKey), wrapped);
    const senderId = message.senderId ?? '';
    const text = message.contentItems
      .filter((item) => item.contentType === 'text' && item.encryptedBlob !== null)
      .map((item) =>
        new TextDecoder().decode(
          decryptContentEnvelope(
            contentKey,
            wrapped,
            {
              conversationId,
              messageId: message.id,
              contentItemId: item.id,
              position: item.position,
              epochNumber: message.epochNumber,
              senderId,
            },
            fromBase64(item.encryptedBlob ?? '')
          )
        )
      )
      .join('');
    return { senderType: message.senderType, text };
  });
}

describe('DemoBackendStore', () => {
  let account: KeyPair;
  let store: DemoBackendStore;

  beforeEach(() => {
    clearEpochKeyCache();
    account = generateKeyPair();
    store = new DemoBackendStore(account.publicKey);
  });

  it('lists one schema-valid conversation per fixture with a decryptable title', () => {
    const list = store.listConversations();
    expect(() => listConversationsResponseSchema.parse(list)).not.toThrow();
    expect(list.conversations).toHaveLength(DEMO_CONVERSATIONS.length);
    expect(list.nextCursor).toBeNull();

    for (const item of list.conversations) {
      const keyChain = store.getKeyChain(item.id);
      if (keyChain === undefined) throw new Error('no keychain');
      processKeyChain(item.id, keyChain, account.privateKey);
      const epochKey = getEpochKey(item.id, item.titleEpochNumber);
      if (epochKey === undefined) throw new Error('no epoch key');
      const title = decryptTextFromEpoch(epochKey, fromBase64(item.title));
      const fixture = DEMO_CONVERSATIONS.find((c) => c.id === item.id);
      expect(title).toBe(fixture?.title);
      expect(item.privilege).toBe('owner');
      expect(item.accepted).toBe(true);
    }
  });

  it('serves every conversation empty (scripted + group are replayed live)', () => {
    for (const fixture of DEMO_CONVERSATIONS) {
      clearEpochKeyCache();
      expect(store.getMessages(fixture.id)).toHaveLength(0);
      expect(decryptMessageTexts(store, account, fixture.id)).toHaveLength(0);
    }
  });

  it('attributes a smart-model script reply to the selected model, keeping the Smart chip', () => {
    const id = 'demo-smart-model';
    // The reply is attributed to the model the send selected (D-D), not a
    // per-fixture constant; `isSmartModel` still comes from the fixture turn.
    store.recordSendTurn(id, { id: 'u1', content: 'hi' }, 'anthropic/claude-opus-4');
    const aiMessage = store.getMessages(id)?.find((m) => m.senderType === 'ai');
    if (aiMessage === undefined) throw new Error('no ai message');
    const aiItem = aiMessage.contentItems[0];
    expect(aiItem?.isSmartModel).toBe(true);
    expect(aiItem?.modelName).toBe('anthropic/claude-opus-4');
  });

  it('carries seeded cost and selected-model attribution through the history page', () => {
    const id = DEMO_BOOT_ID;
    store.recordSendTurn(id, { id: 'u1', content: 'What is HushBox?' }, 'openai/gpt-5');
    const page = store.getMessagesPage(id);
    if (page === undefined) throw new Error('no page');
    const aiMessage = page.messages.find((m) => m.senderType === 'assistant');
    if (aiMessage === undefined) throw new Error('no ai message');
    const item = aiMessage.contentItems[0];
    // Seeded on the first demo-welcome AI turn; surfaces through getMessagesPage
    // in the same shape the client's `toContentItemResponse` reads.
    expect(item?.cost).toBe('1360000');
    expect(item?.modelName).toBe('openai/gpt-5');
    expect(item?.isSmartModel).toBe(false);
  });

  it('anchors the reply cost to the first content item only', () => {
    const id = DEMO_BOOT_ID;
    store.recordSendTurn(id, { id: 'u1', content: 'What is HushBox?' }, 'openai/gpt-5');
    const aiMessage = store.getMessages(id)?.find((m) => m.senderType === 'ai');
    if (aiMessage === undefined) throw new Error('no ai message');
    expect(aiMessage.contentItems[0]?.cost).toBe('1360000');
    for (const item of aiMessage.contentItems.slice(1)) {
      expect(item.cost).toBeNull();
    }
  });

  it('attributes filled (no-picker) replies to the documented constant model', () => {
    const id = DEMO_BOOT_ID;
    store.fillConversation(id);
    const aiMessage = store.getMessages(id)?.find((m) => m.senderType === 'ai');
    expect(aiMessage?.contentItems[0]?.modelName).toBe(DEMO_GROUP_MODEL_ID);
  });

  it('serves an encrypted image via a same-origin blob URL that decrypts to the original asset', () => {
    store.recordSendTurn('demo-image', { id: 'u1', content: 'go' }, 'm');
    const messages = store.getMessages('demo-image');
    if (messages === undefined) throw new Error('no conversation');
    const aiMessage = messages.find((m) => m.senderType === 'ai');
    if (aiMessage === undefined) throw new Error('no ai message');
    const mediaItem = aiMessage.contentItems.find((item) => item.contentType === 'image');
    if (mediaItem === undefined) throw new Error('no media item');

    expect(mediaItem.mimeType).toBe(DEMO_SCENE_IMAGE.mimeType);
    expect(mediaItem.sizeBytes).toBe(DEMO_SCENE_IMAGE.bytes.length);
    expect(mediaItem.width).toBe(DEMO_SCENE_IMAGE.width);
    expect(mediaItem.encryptedBlob).toBeNull();

    const presign = store.getMediaDownloadUrl(mediaItem.id);
    if (presign === undefined) throw new Error('no presign');
    // A same-origin path, NOT a data: URL — so the demo CSP `connect-src 'self'`
    // permits the real useDecryptBlob fetch (the shim serves the ciphertext bytes).
    expect(presign.downloadUrl).toBe(`/media/${mediaItem.id}/blob`);

    const keyChain = store.getKeyChain('demo-image');
    if (keyChain === undefined) throw new Error('no keychain');
    processKeyChain('demo-image', keyChain, account.privateKey);
    const epochKey = getEpochKey('demo-image', aiMessage.epochNumber);
    if (epochKey === undefined) throw new Error('no epoch key');
    const wrapped = fromBase64(aiMessage.wrappedContentKey) as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epochKey), wrapped);
    const ciphertext = store.getMediaBytes(mediaItem.id);
    if (ciphertext === undefined) throw new Error('no ciphertext');
    const plaintext = decryptContentEnvelope(
      contentKey,
      wrapped,
      {
        conversationId: 'demo-image',
        messageId: aiMessage.id,
        contentItemId: mediaItem.id,
        position: mediaItem.position,
        epochNumber: aiMessage.epochNumber,
        senderId: aiMessage.senderId ?? '',
      },
      ciphertext
    );
    expect(toBase64(plaintext)).toBe(toBase64(DEMO_SCENE_IMAGE.bytes));
  });

  it('serves a video content item with duration via a same-origin blob URL that decrypts to the clip', () => {
    store.recordSendTurn('demo-video', { id: 'u1', content: 'go' }, 'm');
    const messages = store.getMessages('demo-video');
    if (messages === undefined) throw new Error('no conversation');
    const aiMessage = messages.find((m) => m.senderType === 'ai');
    if (aiMessage === undefined) throw new Error('no ai message');
    const mediaItem = aiMessage.contentItems.find((item) => item.contentType === 'video');
    if (mediaItem === undefined) throw new Error('no video item');

    expect(mediaItem.mimeType).toBe(DEMO_GENERATED_VIDEO.mimeType);
    expect(mediaItem.durationMs).toBe(DEMO_GENERATED_VIDEO.durationMs);
    expect(mediaItem.sizeBytes).toBe(DEMO_GENERATED_VIDEO.bytes.length);
    expect(mediaItem.encryptedBlob).toBeNull();

    const presign = store.getMediaDownloadUrl(mediaItem.id);
    if (presign === undefined) throw new Error('no presign');
    expect(presign.downloadUrl).toBe(`/media/${mediaItem.id}/blob`);

    const keyChain = store.getKeyChain('demo-video');
    if (keyChain === undefined) throw new Error('no keychain');
    processKeyChain('demo-video', keyChain, account.privateKey);
    const epochKey = getEpochKey('demo-video', aiMessage.epochNumber);
    if (epochKey === undefined) throw new Error('no epoch key');
    const wrapped = fromBase64(aiMessage.wrappedContentKey) as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epochKey), wrapped);
    const ciphertext = store.getMediaBytes(mediaItem.id);
    if (ciphertext === undefined) throw new Error('no ciphertext');
    const plaintext = decryptContentEnvelope(
      contentKey,
      wrapped,
      {
        conversationId: 'demo-video',
        messageId: aiMessage.id,
        contentItemId: mediaItem.id,
        position: mediaItem.position,
        epochNumber: aiMessage.epochNumber,
        senderId: aiMessage.senderId ?? '',
      },
      ciphertext
    );
    expect(toBase64(plaintext)).toBe(toBase64(DEMO_GENERATED_VIDEO.bytes));
  });

  it('returns undefined for an unknown media content item id', () => {
    expect(store.getMediaDownloadUrl('does-not-exist')).toBeUndefined();
  });

  it('returns undefined for an unknown conversation id', () => {
    expect(store.getConversation('does-not-exist')).toBeUndefined();
    expect(store.getKeyChain('does-not-exist')).toBeUndefined();
  });

  it('serves a key-chain batch for known ids and reports unknown ids as missing', () => {
    const ids = [...DEMO_CONVERSATIONS.map((c) => c.id), 'unknown-id'];
    const batch = store.getKeyChainBatch(ids);
    for (const fixture of DEMO_CONVERSATIONS) {
      expect(batch.keys[fixture.id]).toBeDefined();
    }
    expect(batch.keys['unknown-id']).toBeUndefined();
    expect(batch.missing).toContain('unknown-id');
  });

  it('serves the conversation detail in the membership wire shape', () => {
    const id = DEMO_CONVERSATIONS[0]!.id;
    const detail = store.getConversation(id);
    if (detail === undefined) throw new Error('expected built conversation');
    expect(detail.membership).toEqual({
      privilege: 'owner',
      muted: false,
      pinned: false,
      accepted: true,
      visibleFromEpoch: 1,
    });
    expect(detail.conversation.id).toBe(id);
    expect(detail.forks).toEqual([]);
    expect(detail).not.toHaveProperty('messages');
  });

  it('serves the message history page in the slim history wire shape', () => {
    const id = DEMO_CONVERSATIONS[0]!.id;
    store.fillConversation(id);
    const full = store.getMessages(id);
    const page = store.getMessagesPage(id);
    if (page === undefined || full === undefined) throw new Error('expected built conversation');
    expect(page.nextCursor).toBeNull();
    expect(page.messages).toHaveLength(full.length);
    expect(full.length).toBeGreaterThan(0);
    const source = full[0]!;
    const history = page.messages[0]!;
    expect(history).toMatchObject({
      id: source.id,
      parentMessageId: source.parentMessageId,
      sequenceNumber: source.sequenceNumber,
      epochNumber: source.epochNumber,
      senderType: source.senderType === 'user' ? 'user' : 'assistant',
      senderId: source.senderId,
      wrappedContentKey: source.wrappedContentKey,
      batchId: source.batchId,
    });
    const sourceItem = source.contentItems[0]!;
    expect(history.contentItems[0]).toEqual({
      id: sourceItem.id,
      position: sourceItem.position,
      contentType: sourceItem.contentType,
      mimeType: sourceItem.mimeType,
      byteLength: sourceItem.sizeBytes,
      encryptedBlob: sourceItem.encryptedBlob,
      modelName: sourceItem.modelName,
      cost: sourceItem.cost,
      isSmartModel: sourceItem.isSmartModel,
    });
    expect(store.getMessagesPage('unknown-id')).toBeUndefined();
  });

  it('serves a positive balance and a single solo member with no links', () => {
    const balance = store.getBalance();
    expect(BigInt(balance.purchased.balanceNanoUsd)).toBeGreaterThan(0n);
    expect(BigInt(balance.free.balanceNanoUsd)).toBe(0n);
    expect(balance.allowance.day).toBe('2026-06-01');
    expect(balance.allowance.remainingNanoUsd).toBe(balance.allowance.limitNanoUsd);
    expect(balance.allowance.spentNanoUsd).toBe('0');

    const members = store.getMembers('demo-smart-model');
    expect(members.members).toHaveLength(1);
    expect(members.members[0]?.userId).toBe(DEMO_USER.id);

    expect(store.getLinks('demo-smart-model').links).toEqual([]);
  });

  it('serves a multi-member roster for the group conversation including the demo user', () => {
    const { members } = store.getMembers('demo-group');
    expect(members.length).toBeGreaterThan(1);
    expect(members.some((m) => m.userId === DEMO_USER.id)).toBe(true);
    expect(members.map((m) => m.username)).toContain('amir');
    for (const m of members) expect(m.linkId).toBeNull();
  });

  it('appendNextGroupMessage replays the transcript with decryptable per-participant messages', () => {
    expect(store.isGroupConversation('demo-group')).toBe(true);
    expect(store.isGroupConversation('demo-image')).toBe(false);
    // Group starts empty; drive the whole transcript as the director would.
    expect(store.getMessages('demo-group')).toHaveLength(0);
    while (store.appendNextGroupMessage('demo-group') !== null) {
      /* replay every transcript message */
    }

    const messages = store.getMessages('demo-group');
    if (messages === undefined) throw new Error('no conversation');
    const senderIds = messages.map((m) => m.senderId);
    expect(senderIds).toContain(DEMO_USER.id);
    expect(senderIds).toContain('demo-user-amir');

    const decrypted = decryptMessageTexts(store, account, 'demo-group');
    expect(decrypted).toHaveLength(messages.length);
    expect(decrypted.length).toBeGreaterThan(0);
    expect(decrypted.every((row) => row.text.length > 0)).toBe(true);
  });

  it('group replay shows typing for other members and omits the demo user self-skip', () => {
    // Transcript order (we start the group): demo (own), amir, sana.
    expect(store.peekNextGroupMessage('demo-group')).toEqual({ typingUserId: null });
    const own = store.appendNextGroupMessage('demo-group');
    expect(own?.senderId).toBeUndefined();
    expect(own?.senderType).toBe('user');

    expect(store.peekNextGroupMessage('demo-group')).toEqual({ typingUserId: 'demo-user-amir' });
    const amir = store.appendNextGroupMessage('demo-group');
    expect(amir?.senderId).toBe('demo-user-amir');

    expect(store.peekNextGroupMessage('demo-group')).toEqual({ typingUserId: 'demo-user-sana' });
    store.appendNextGroupMessage('demo-group');
    expect(store.peekNextGroupMessage('demo-group')).toBeNull();
    expect(store.appendNextGroupMessage('demo-group')).toBeNull();
  });

  it('recordSendTurn appends a decryptable user + assistant turn for the refetch', () => {
    const id = 'demo-smart-model';
    const before = store.getMessages(id)?.length ?? 0;
    const turn = store.recordSendTurn(
      id,
      { id: 'u-new', content: 'Does letting it choose cost me more?' },
      'openai/gpt-4o'
    );
    expect(turn).toBeDefined();

    const decrypted = decryptMessageTexts(store, account, id);
    expect(decrypted).toHaveLength(before + 2);
    expect(decrypted.at(-2)).toEqual({
      senderType: 'user',
      text: 'Does letting it choose cost me more?',
    });
    expect(decrypted.at(-1)?.senderType).toBe('ai');
    expect(decrypted.at(-1)?.text).toBe(turn?.content);
  });

  it('recordSendTurn returns undefined for an unknown conversation', () => {
    expect(store.recordSendTurn('nope', { id: 'x', content: 'hi' }, 'm')).toBeUndefined();
  });

  it('recordSendTurn reports media attributes for an image turn', () => {
    const turn = store.recordSendTurn('demo-image', { id: 'u1', content: 'go' }, 'm');
    expect(turn?.media).toEqual({ mediaType: 'image', mimeType: DEMO_SCENE_IMAGE.mimeType });
  });

  it('recordSendTurn reports media attributes for a video turn', () => {
    const turn = store.recordSendTurn('demo-video', { id: 'u1', content: 'go' }, 'm');
    expect(turn?.media).toEqual({ mediaType: 'video', mimeType: DEMO_GENERATED_VIDEO.mimeType });
  });

  it('recordSendTurn omits media attributes for a text turn', () => {
    const turn = store.recordSendTurn('demo-smart-model', { id: 'u1', content: 'hi' }, 'm');
    expect(turn?.media).toBeUndefined();
  });

  it('recordRegenerateTurn swaps the AI reply for a fresh clone under the same user message', () => {
    const id = 'demo-smart-model';
    store.recordSendTurn(id, { id: 'u1', content: 'hi' }, 'm');
    const before = store.getMessages(id);
    if (before === undefined) throw new Error('no conversation');
    const userMessage = before.find((m) => m.senderType === 'user');
    const oldAi = before.find((m) => m.senderType === 'ai');
    if (userMessage === undefined || oldAi === undefined) throw new Error('missing messages');
    const beforeCount = before.length;

    const turn = store.recordRegenerateTurn({
      conversationId: id,
      targetMessageId: userMessage.id,
      models: ['openai/gpt-4o'],
    });
    if (turn === undefined) throw new Error('no turn');
    expect(turn.userMessageId).toBe(userMessage.id);

    const after = store.getMessages(id);
    if (after === undefined) throw new Error('no after');
    expect(after).toHaveLength(beforeCount);
    expect(after.some((m) => m.id === oldAi.id)).toBe(false);
    const clone = after.find((m) => m.id === turn.assistantMessageId);
    if (clone === undefined) throw new Error('no clone');
    expect(clone.senderType).toBe('ai');
    expect(clone.parentMessageId).toBe(userMessage.id);
  });

  it("recordRegenerateTurn's clone decrypts to the re-streamed reply text", () => {
    const id = 'demo-smart-model';
    store.recordSendTurn(id, { id: 'u1', content: 'hi' }, 'm');
    const userMessage = store.getMessages(id)?.find((m) => m.senderType === 'user');
    if (userMessage === undefined) throw new Error('no user message');

    const turn = store.recordRegenerateTurn({
      conversationId: id,
      targetMessageId: userMessage.id,
    });
    if (turn === undefined) throw new Error('no turn');
    expect(turn.content.length).toBeGreaterThan(0);

    const lastRow = decryptMessageTexts(store, account, id).at(-1);
    expect(lastRow?.senderType).toBe('ai');
    expect(lastRow?.text).toBe(turn.content);
  });

  it('recordRegenerateTurn reports media attributes when regenerating a media reply', () => {
    store.recordSendTurn('demo-image', { id: 'u1', content: 'go' }, 'm');
    const userMessage = store.getMessages('demo-image')?.find((m) => m.senderType === 'user');
    if (userMessage === undefined) throw new Error('no user message');
    const turn = store.recordRegenerateTurn({
      conversationId: 'demo-image',
      targetMessageId: userMessage.id,
    });
    expect(turn?.media).toEqual({ mediaType: 'image', mimeType: DEMO_SCENE_IMAGE.mimeType });
  });

  it('recordRegenerateTurn tolerates a user-message target, filling defaults from the lenient mock', () => {
    const id = 'demo-smart-model';
    store.recordSendTurn(id, { id: 'u1', content: 'hi' }, 'openai/gpt-4o');
    const userMessage = store.getMessages(id)?.find((m) => m.senderType === 'user');
    if (userMessage === undefined) throw new Error('no user message');
    // The first user message has a null parent, no registered AI text/content, and no
    // model on its content item — every regenerate fallback path is exercised here.
    expect(userMessage.parentMessageId).toBeNull();
    expect(userMessage.contentItems[0]?.modelName).toBeNull();

    const turn = store.recordRegenerateTurn({
      conversationId: id,
      targetMessageId: userMessage.id,
      replaceAssistantId: userMessage.id,
    });
    if (turn === undefined) throw new Error('no turn');

    // parentMessageId null → falls back to the request's targetMessageId.
    expect(turn.userMessageId).toBe(userMessage.id);
    // No models supplied and no modelName on the target → the default model id.
    expect(turn.modelId).toBe('demo-model');
    // No AI text/content is registered for a user message → an empty clone.
    expect(turn.content).toBe('');
    expect(turn.media).toBeUndefined();

    const clone = store.getMessages(id)?.find((m) => m.id === turn.assistantMessageId);
    expect(clone?.contentItems).toEqual([]);
  });

  it('recordRegenerateTurn returns undefined for an unknown conversation or message', () => {
    expect(
      store.recordRegenerateTurn({ conversationId: 'nope', targetMessageId: 'x' })
    ).toBeUndefined();
    expect(
      store.recordRegenerateTurn({ conversationId: 'demo-smart-model', targetMessageId: 'no-user' })
    ).toBeUndefined();
  });

  it('createConversation registers a new chat whose turn the client epoch key decrypts', () => {
    // The client makes the epoch and sends only its public key (new-chat flow).
    const epoch = createFirstEpoch([account.publicKey]);
    const created = store.createConversation({
      id: 'new-1',
      title: '',
      epochPublicKey: toBase64(epoch.epochPublicKey),
    });
    expect(created.created).toBe(true);

    const turn = store.recordSendTurn('new-1', { id: 'u1', content: 'hello there' }, 'some-model');
    expect(turn).toBeDefined();

    const messages = store.getMessages('new-1');
    if (messages === undefined) throw new Error('no conversation');
    expect(messages).toHaveLength(2);
    const userMessage = messages[0];
    if (userMessage === undefined) throw new Error('no user message');
    const wrapped = fromBase64(userMessage.wrappedContentKey) as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epoch.epochPrivateKey), wrapped);
    const contentItem = userMessage.contentItems[0];
    if (contentItem === undefined) throw new Error('no content item');
    const plaintext = decryptContentEnvelope(
      contentKey,
      wrapped,
      {
        conversationId: 'new-1',
        messageId: userMessage.id,
        contentItemId: contentItem.id,
        position: contentItem.position,
        epochNumber: userMessage.epochNumber,
        senderId: userMessage.senderId ?? '',
      },
      fromBase64(contentItem.encryptedBlob ?? '')
    );
    expect(new TextDecoder().decode(plaintext)).toBe('hello there');
  });

  it('lists the boot conversation as a normal sidebar entry', () => {
    const listed = store.listConversations().conversations.map((c) => c.id);
    expect(listed).toContain(DEMO_BOOT_ID);
    expect(listed).toHaveLength(DEMO_CONVERSATIONS.length);
  });

  it('createConversation has no script, so a user-initiated new chat gets the generic reply', () => {
    store.createConversation({
      id: 'user-chat',
      title: '',
      epochPublicKey: toBase64(createFirstEpoch([account.publicKey]).epochPublicKey),
    });
    expect(store.getModality('user-chat')).toBeUndefined();
    store.recordSendTurn('user-chat', { id: 'u1', content: 'anything' }, 'ignored');
    const aiItem = store.getMessages('user-chat')?.find((m) => m.senderType === 'ai')
      ?.contentItems[0];
    expect(aiItem?.isSmartModel).toBe(false);
    expect(aiItem?.modelName).toBe('ignored');
  });

  it('getModality reports a scripted conversation modality and undefined for the group', () => {
    expect(store.getModality('demo-image')).toBe('image');
    expect(store.getModality('demo-video')).toBe('video');
    expect(store.getModality('demo-group')).toBeUndefined();
    expect(store.getModality('unknown')).toBeUndefined();
  });

  it('fillConversation builds a scripted conversation straight to its finished state', () => {
    store.fillConversation('demo-smart-model');
    const rows = decryptMessageTexts(store, account, 'demo-smart-model');
    // Two scripted turns → four messages (user + ai each), no replay needed.
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.senderType)).toEqual(['user', 'ai', 'user', 'ai']);
    expect(store.peekNextUserText('demo-smart-model')).toBeNull();
  });

  it('fillConversation with a limit fills only the first N turns and advances the cursor by N', () => {
    store.fillConversation('demo-smart-model', 1);
    const rows = decryptMessageTexts(store, account, 'demo-smart-model');
    // One scripted turn filled → two messages (user + ai); the second turn remains.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.senderType)).toEqual(['user', 'ai']);
    expect(store.peekNextUserText('demo-smart-model')).toBe(
      'What if I want to choose the model myself?'
    );
  });

  it('fillConversation with a limit leaves the next turn to stream live via recordSendTurn', () => {
    store.fillConversation('demo-smart-model', 1);
    store.recordSendTurn(
      'demo-smart-model',
      { id: 'u2', content: 'What if I want to choose the model myself?' },
      'm'
    );
    const rows = decryptMessageTexts(store, account, 'demo-smart-model');
    expect(rows).toHaveLength(4);
    expect(store.peekNextUserText('demo-smart-model')).toBeNull();
  });

  it('fillConversation with limit 0 fills nothing and leaves the cursor at the start', () => {
    store.fillConversation('demo-smart-model', 0);
    expect(store.getMessages('demo-smart-model')).toHaveLength(0);
    expect(store.peekNextUserText('demo-smart-model')).toBe(
      'There are so many AI models. How do I know which one to use?'
    );
  });

  it('fillConversation with a limit beyond the script length fills the whole script', () => {
    store.fillConversation('demo-smart-model', 99);
    const rows = decryptMessageTexts(store, account, 'demo-smart-model');
    expect(rows).toHaveLength(4);
    expect(store.peekNextUserText('demo-smart-model')).toBeNull();
  });

  it('fillConversation builds the group transcript in one shot', () => {
    store.fillConversation('demo-group');
    const rows = decryptMessageTexts(store, account, 'demo-group');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.text).toContain('Welcome to the group');
  });

  it('peekNextGroupText returns the demo user opener for the welcome lead-in', () => {
    expect(store.peekNextGroupText('demo-group')).toBe(
      'Welcome to the group! This is a shared chat we can all use together, with AI right here in it.'
    );
    expect(store.peekNextGroupText('demo-image')).toBeNull();
    expect(store.peekNextGroupText('unknown')).toBeNull();
  });

  it('getMembers falls back to the solo member for an unknown conversation', () => {
    const { members } = store.getMembers('does-not-exist');
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe(DEMO_USER.id);
  });

  it('resetConversation and fillConversation are no-ops for an unknown conversation', () => {
    expect(() => {
      store.resetConversation('does-not-exist');
    }).not.toThrow();
    expect(() => {
      store.fillConversation('does-not-exist');
    }).not.toThrow();
    expect(store.getMessages('does-not-exist')).toBeUndefined();
  });

  it('recordRegenerateTurn matches by replaceAssistantId when given one', () => {
    const id = 'demo-smart-model';
    store.recordSendTurn(id, { id: 'u1', content: 'hi' }, 'm');
    const before = store.getMessages(id);
    if (before === undefined) throw new Error('no conversation');
    const userMessage = before.find((m) => m.senderType === 'user');
    const oldAi = before.find((m) => m.senderType === 'ai');
    if (userMessage === undefined || oldAi === undefined) throw new Error('missing messages');

    const turn = store.recordRegenerateTurn({
      conversationId: id,
      targetMessageId: userMessage.id,
      replaceAssistantId: oldAi.id,
    });
    if (turn === undefined) throw new Error('no turn');

    const after = store.getMessages(id);
    if (after === undefined) throw new Error('no after');
    // The specific assistant referenced by replaceAssistantId is swapped for the clone.
    expect(after.some((m) => m.id === oldAi.id)).toBe(false);
    expect(after.some((m) => m.id === turn.assistantMessageId)).toBe(true);
  });

  it('createConversation defaults the title to an empty string when none is given', () => {
    const created = store.createConversation({
      id: 'no-title',
      epochPublicKey: toBase64(createFirstEpoch([account.publicKey]).epochPublicKey),
    });
    expect(created.conversation.title).toBe('');
  });

  it('peekNextUserText returns the next scripted prompt and null once the script is exhausted', () => {
    expect(store.peekNextUserText('demo-smart-model')).toBe(
      'There are so many AI models. How do I know which one to use?'
    );
    store.recordSendTurn('demo-smart-model', { id: 'u1', content: 'x' }, 'm');
    expect(store.peekNextUserText('demo-smart-model')).toBe(
      'What if I want to choose the model myself?'
    );
    store.recordSendTurn('demo-smart-model', { id: 'u2', content: 'y' }, 'm');
    expect(store.peekNextUserText('demo-smart-model')).toBeNull();
    expect(store.peekNextUserText('demo-group')).toBeNull();
    expect(store.peekNextUserText('unknown')).toBeNull();
  });
});
