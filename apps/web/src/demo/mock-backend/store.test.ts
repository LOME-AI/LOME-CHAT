import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateKeyPair,
  createFirstEpoch,
  openMessageEnvelope,
  decryptTextWithContentKey,
  decryptBinaryWithContentKey,
  decryptTextFromEpoch,
  type KeyPair,
  type WrappedContentKey,
} from '@hushbox/crypto';
import {
  fromBase64,
  toBase64,
  listConversationsResponseSchema,
  getConversationResponseSchema,
} from '@hushbox/shared';
import { processKeyChain, getEpochKey, clearEpochKeyCache } from '@/lib/epoch-key-cache';
import { DemoBackendStore } from './store';
import { DEMO_CONVERSATIONS, DEMO_BOOT_ID, DEMO_USER } from './fixtures';
import { DEMO_SCENE_IMAGE, DEMO_GENERATED_VIDEO } from './media-assets';

function decryptMessageTexts(
  store: DemoBackendStore,
  account: KeyPair,
  conversationId: string
): { senderType: string; text: string }[] {
  const keyChain = store.getKeyChain(conversationId);
  if (keyChain === undefined) throw new Error('no keychain');
  processKeyChain(conversationId, keyChain, account.privateKey);
  const conversation = store.getConversation(conversationId);
  if (conversation === undefined) throw new Error('no conversation');
  return conversation.messages.map((message) => {
    const epochKey = getEpochKey(conversationId, message.epochNumber);
    if (epochKey === undefined) throw new Error('no epoch key');
    const contentKey = openMessageEnvelope(
      epochKey,
      fromBase64(message.wrappedContentKey) as WrappedContentKey
    );
    const text = message.contentItems
      .filter((item) => item.contentType === 'text' && item.encryptedBlob !== null)
      .map((item) => decryptTextWithContentKey(contentKey, fromBase64(item.encryptedBlob ?? '')))
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
      const response = store.getConversation(fixture.id);
      expect(() => getConversationResponseSchema.parse(response)).not.toThrow();
      expect(decryptMessageTexts(store, account, fixture.id)).toHaveLength(0);
    }
  });

  it('streams the smart-model script turn with isSmartModel and a model name', () => {
    const id = 'demo-smart-model';
    store.recordSendTurn(id, { id: 'u1', content: 'hi' }, 'ignored');
    const aiMessage = store.getConversation(id)?.messages.find((m) => m.senderType === 'ai');
    if (aiMessage === undefined) throw new Error('no ai message');
    const aiItem = aiMessage.contentItems[0];
    expect(aiItem?.isSmartModel).toBe(true);
    expect(aiItem?.modelName).toBe('openai/gpt-4o');
  });

  it('serves an encrypted image via a same-origin blob URL that decrypts to the original asset', () => {
    store.recordSendTurn('demo-image', { id: 'u1', content: 'go' }, 'm');
    const conversation = store.getConversation('demo-image');
    if (conversation === undefined) throw new Error('no conversation');
    const aiMessage = conversation.messages.find((m) => m.senderType === 'ai');
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
    const contentKey = openMessageEnvelope(
      epochKey,
      fromBase64(aiMessage.wrappedContentKey) as WrappedContentKey
    );
    const ciphertext = store.getMediaBytes(mediaItem.id);
    if (ciphertext === undefined) throw new Error('no ciphertext');
    const plaintext = decryptBinaryWithContentKey(contentKey, ciphertext);
    expect(toBase64(plaintext)).toBe(toBase64(DEMO_SCENE_IMAGE.bytes));
  });

  it('serves a video content item with duration via a same-origin blob URL that decrypts to the clip', () => {
    store.recordSendTurn('demo-video', { id: 'u1', content: 'go' }, 'm');
    const conversation = store.getConversation('demo-video');
    if (conversation === undefined) throw new Error('no conversation');
    const aiMessage = conversation.messages.find((m) => m.senderType === 'ai');
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
    const contentKey = openMessageEnvelope(
      epochKey,
      fromBase64(aiMessage.wrappedContentKey) as WrappedContentKey
    );
    const ciphertext = store.getMediaBytes(mediaItem.id);
    if (ciphertext === undefined) throw new Error('no ciphertext');
    const plaintext = decryptBinaryWithContentKey(contentKey, ciphertext);
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

  it('serves a positive balance and a single solo member with no links', () => {
    const balance = store.getBalance();
    expect(Number(balance.balance)).toBeGreaterThan(0);
    expect(typeof balance.freeAllowanceCents).toBe('number');

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
    expect(store.getConversation('demo-group')?.messages).toHaveLength(0);
    while (store.appendNextGroupMessage('demo-group') !== null) {
      /* replay every transcript message */
    }

    const conversation = store.getConversation('demo-group');
    if (conversation === undefined) throw new Error('no conversation');
    const senderIds = conversation.messages.map((m) => m.senderId);
    expect(senderIds).toContain(DEMO_USER.id);
    expect(senderIds).toContain('demo-user-amir');

    const decrypted = decryptMessageTexts(store, account, 'demo-group');
    expect(decrypted).toHaveLength(conversation.messages.length);
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
    const before = store.getConversation(id)?.messages.length ?? 0;
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
    const before = store.getConversation(id);
    if (before === undefined) throw new Error('no conversation');
    const userMessage = before.messages.find((m) => m.senderType === 'user');
    const oldAi = before.messages.find((m) => m.senderType === 'ai');
    if (userMessage === undefined || oldAi === undefined) throw new Error('missing messages');
    const beforeCount = before.messages.length;

    const turn = store.recordRegenerateTurn({
      conversationId: id,
      targetMessageId: userMessage.id,
      models: ['openai/gpt-4o'],
    });
    if (turn === undefined) throw new Error('no turn');
    expect(turn.userMessageId).toBe(userMessage.id);

    const after = store.getConversation(id);
    if (after === undefined) throw new Error('no after');
    expect(after.messages).toHaveLength(beforeCount);
    expect(after.messages.some((m) => m.id === oldAi.id)).toBe(false);
    const clone = after.messages.find((m) => m.id === turn.assistantMessageId);
    if (clone === undefined) throw new Error('no clone');
    expect(clone.senderType).toBe('ai');
    expect(clone.parentMessageId).toBe(userMessage.id);
  });

  it("recordRegenerateTurn's clone decrypts to the re-streamed reply text", () => {
    const id = 'demo-smart-model';
    store.recordSendTurn(id, { id: 'u1', content: 'hi' }, 'm');
    const userMessage = store.getConversation(id)?.messages.find((m) => m.senderType === 'user');
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
    const userMessage = store
      .getConversation('demo-image')
      ?.messages.find((m) => m.senderType === 'user');
    if (userMessage === undefined) throw new Error('no user message');
    const turn = store.recordRegenerateTurn({
      conversationId: 'demo-image',
      targetMessageId: userMessage.id,
    });
    expect(turn?.media).toEqual({ mediaType: 'image', mimeType: DEMO_SCENE_IMAGE.mimeType });
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

    const conversation = store.getConversation('new-1');
    if (conversation === undefined) throw new Error('no conversation');
    expect(conversation.messages).toHaveLength(2);
    const userMessage = conversation.messages[0];
    if (userMessage === undefined) throw new Error('no user message');
    const contentKey = openMessageEnvelope(
      epoch.epochPrivateKey,
      fromBase64(userMessage.wrappedContentKey) as WrappedContentKey
    );
    const blob = userMessage.contentItems[0]?.encryptedBlob ?? '';
    expect(decryptTextWithContentKey(contentKey, fromBase64(blob))).toBe('hello there');
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
    const aiItem = store.getConversation('user-chat')?.messages.find((m) => m.senderType === 'ai')
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
