import { describe, it, expect, vi } from 'vitest';

// Mock the modules with side-effectful imports that the helpers reach into so
// this unit suite stays free of env validation and crypto initialisation.
vi.mock('@/lib/epoch-key-cache', () => ({
  getEpochKey: vi.fn(),
}));
vi.mock('@hushbox/crypto', () => ({
  decryptTextFromEpoch: vi.fn(),
}));
vi.mock('@/lib/api', () => ({}));

import type { ImageConfig, VideoConfig, AudioConfig } from '@hushbox/shared';
import { getEpochKey } from '@/lib/epoch-key-cache';
import { decryptTextFromEpoch } from '@hushbox/crypto';
import {
  shouldRedirect,
  computeRenderState,
  computePruneIds,
  mergeMessages,
  requestedMediaAspectRatio,
  pendingMediaInFlight,
  buildModalityConfigPayload,
  resolveUserContent,
  resolveQueryId,
  resolveCallerId,
  checkDecryptionPending,
  computeInputDisabled,
  deriveMessagesReady,
  computeDisplayTitle,
  resolveChatPageKey,
  DECRYPTING_TITLE,
} from './auth-chat-helpers';

const getEpochKeyMock = vi.mocked(getEpochKey);
const decryptTextFromEpochMock = vi.mocked(decryptTextFromEpoch);

function makeMessage(
  id: string,
  role: 'user' | 'assistant' = 'user'
): {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
} {
  return { id, conversationId: 'conv-1', role, content: `msg-${id}`, createdAt: '' };
}

function baseRenderParams(): Parameters<typeof computeRenderState>[0] {
  return {
    isCreateMode: false,
    pendingMessage: null,
    localMessagesLength: 0,
    conversation: { title: 'Test' },
    isConversationLoading: false,
    isMessagesLoading: false,
    isDecryptionPending: false,
  };
}

describe('shouldRedirect', () => {
  it('is true only in create mode with no pending message and no local messages', () => {
    expect(shouldRedirect(true, null, 0)).toBe(true);
  });

  it('is false when not in create mode', () => {
    expect(shouldRedirect(false, null, 0)).toBe(false);
  });

  it('is false when a pending message exists', () => {
    expect(shouldRedirect(true, 'hi', 0)).toBe(false);
  });

  it('is false when local messages exist', () => {
    expect(shouldRedirect(true, null, 2)).toBe(false);
  });
});

describe('computeRenderState', () => {
  it('returns redirecting when shouldRedirect is true', () => {
    expect(computeRenderState({ ...baseRenderParams(), isCreateMode: true })).toEqual({
      type: 'redirecting',
    });
  });

  it('returns ready in create mode with a pending message', () => {
    expect(
      computeRenderState({ ...baseRenderParams(), isCreateMode: true, pendingMessage: 'hi' })
    ).toEqual({ type: 'ready' });
  });

  it('returns not-found when there is no conversation and it is not loading', () => {
    expect(computeRenderState({ ...baseRenderParams(), conversation: undefined })).toEqual({
      type: 'not-found',
    });
  });

  it('returns loading with the decrypting title while the conversation loads', () => {
    expect(computeRenderState({ ...baseRenderParams(), isConversationLoading: true })).toEqual({
      type: 'loading',
      title: DECRYPTING_TITLE,
    });
  });

  it('returns ready while loading when local messages are present', () => {
    expect(
      computeRenderState({
        ...baseRenderParams(),
        isMessagesLoading: true,
        localMessagesLength: 1,
      })
    ).toEqual({ type: 'ready' });
  });

  it('returns loading when decryption is still pending', () => {
    expect(computeRenderState({ ...baseRenderParams(), isDecryptionPending: true })).toEqual({
      type: 'loading',
      title: DECRYPTING_TITLE,
    });
  });

  it('returns ready when decryption is pending but local messages exist', () => {
    // create→real window: the optimistic turn is still on screen, so the
    // post-stream refetch decrypting must not flash the placeholder over it.
    expect(
      computeRenderState({
        ...baseRenderParams(),
        isDecryptionPending: true,
        localMessagesLength: 1,
      })
    ).toEqual({ type: 'ready' });
  });

  it('returns ready once everything is loaded', () => {
    expect(computeRenderState(baseRenderParams())).toEqual({ type: 'ready' });
  });
});

describe('computePruneIds', () => {
  it('retry removes every descendant of the target, keeping the target', () => {
    const messages = [
      makeMessage('u1'),
      makeMessage('a1', 'assistant'),
      makeMessage('u2'),
      makeMessage('a2', 'assistant'),
    ];
    expect([...computePruneIds(messages, 'u1', 'retry')]).toEqual(['a1', 'u2', 'a2']);
  });

  it('edit removes the target user message itself plus descendants', () => {
    const messages = [makeMessage('u2'), makeMessage('a2', 'assistant')];
    expect([...computePruneIds(messages, 'u2', 'edit')]).toEqual(['u2', 'a2']);
  });

  it('regenerate-one returns only the named assistant id', () => {
    const messages = [makeMessage('u1'), makeMessage('a1', 'assistant')];
    expect([...computePruneIds(messages, 'u1', 'retry', 'a1')]).toEqual(['a1']);
  });

  it('returns an empty set when the target is missing', () => {
    expect(computePruneIds([makeMessage('u1')], 'missing', 'retry').size).toBe(0);
  });
});

describe('mergeMessages', () => {
  it('uses local messages in create mode', () => {
    const result = mergeMessages({
      isCreateMode: true,
      realConversationId: null,
      localMessages: [makeMessage('u1')],
      decryptedApiMessages: [],
      optimisticMessages: [],
      chatError: null,
      primaryModelId: 'm',
    });
    expect(result.map((m) => m.id)).toEqual(['u1']);
  });

  it('merges api messages with non-duplicate optimistic messages', () => {
    const result = mergeMessages({
      isCreateMode: false,
      realConversationId: 'conv-1',
      localMessages: [],
      decryptedApiMessages: [makeMessage('a1', 'assistant')],
      optimisticMessages: [makeMessage('a1', 'assistant'), makeMessage('o1')],
      chatError: null,
      primaryModelId: 'm',
    });
    expect(result.map((m) => m.id)).toEqual(['a1', 'o1']);
  });

  it('falls back to local messages when api/optimistic merge is empty', () => {
    const result = mergeMessages({
      isCreateMode: false,
      realConversationId: 'conv-1',
      localMessages: [makeMessage('l1')],
      decryptedApiMessages: [],
      optimisticMessages: [],
      chatError: null,
      primaryModelId: 'm',
    });
    expect(result.map((m) => m.id)).toEqual(['l1']);
  });

  it('appends an error message stamped with the primary model id', () => {
    const result = mergeMessages({
      isCreateMode: true,
      realConversationId: null,
      localMessages: [makeMessage('u1')],
      decryptedApiMessages: [],
      optimisticMessages: [],
      chatError: { id: 'err-1', content: 'boom' },
      primaryModelId: 'smart-model',
    });
    const err = result.find((m) => m.id === 'err-1');
    expect(err?.modelName).toBe('smart-model');
    expect(err?.conversationId).toBe('');
  });
});

describe('requestedMediaAspectRatio', () => {
  const imageConfig: ImageConfig = { aspectRatio: '4:3' };
  const videoConfig: VideoConfig = { aspectRatio: '9:16', durationSeconds: 4, resolution: '720p' };

  it('returns the image aspect ratio', () => {
    expect(requestedMediaAspectRatio('image', imageConfig, videoConfig)).toBe('4:3');
  });

  it('returns the video aspect ratio', () => {
    expect(requestedMediaAspectRatio('video', imageConfig, videoConfig)).toBe('9:16');
  });

  it('returns undefined for audio', () => {
    expect(requestedMediaAspectRatio('audio', imageConfig, videoConfig)).toBeUndefined();
  });
});

describe('pendingMediaInFlight', () => {
  const imageConfig: ImageConfig = { aspectRatio: '4:3' };
  const videoConfig: VideoConfig = { aspectRatio: '9:16', durationSeconds: 4, resolution: '720p' };

  it('returns undefined for text', () => {
    expect(pendingMediaInFlight('text', imageConfig, videoConfig)).toBeUndefined();
  });

  it('stamps image with the placeholder mime and aspect ratio', () => {
    expect(pendingMediaInFlight('image', imageConfig, videoConfig)).toEqual({
      mediaType: 'image',
      mimeType: 'application/octet-stream',
      aspectRatio: '4:3',
    });
  });

  it('stamps audio with no aspect ratio', () => {
    expect(pendingMediaInFlight('audio', imageConfig, videoConfig)).toEqual({
      mediaType: 'audio',
      mimeType: 'application/octet-stream',
    });
  });
});

describe('buildModalityConfigPayload', () => {
  const imageConfig: ImageConfig = { aspectRatio: '4:3' };
  const videoConfig: VideoConfig = { aspectRatio: '9:16', durationSeconds: 4, resolution: '720p' };
  const audioConfig: AudioConfig = { voice: 'alloy' } as AudioConfig;

  it('returns an empty object for text', () => {
    expect(buildModalityConfigPayload('text', imageConfig, videoConfig, audioConfig)).toEqual({});
  });

  it('returns the image config for image', () => {
    expect(buildModalityConfigPayload('image', imageConfig, videoConfig, audioConfig)).toEqual({
      imageConfig,
    });
  });

  it('returns the video config for video', () => {
    expect(buildModalityConfigPayload('video', imageConfig, videoConfig, audioConfig)).toEqual({
      videoConfig,
    });
  });

  it('returns the audio config for audio', () => {
    expect(buildModalityConfigPayload('audio', imageConfig, videoConfig, audioConfig)).toEqual({
      audioConfig,
    });
  });
});

describe('resolveUserContent', () => {
  const messages = [makeMessage('u1')];

  it('uses edited content for an edit action', () => {
    expect(resolveUserContent('edit', 'new text', messages, 'u1')).toBe('new text');
  });

  it('falls back to the target message content when not editing', () => {
    expect(resolveUserContent('retry', undefined, messages, 'u1')).toBe('msg-u1');
  });

  it('returns null when the target is missing', () => {
    expect(resolveUserContent('retry', undefined, messages, 'missing')).toBeNull();
  });

  it('returns null when the target content is empty (anchor not yet decrypted)', () => {
    const pending = [{ ...makeMessage('u1'), content: '' }];
    expect(resolveUserContent('retry', undefined, pending, 'u1')).toBeNull();
  });
});

describe('resolveQueryId', () => {
  it('returns the conversation id when present', () => {
    expect(resolveQueryId('conv-1')).toBe('conv-1');
  });

  it('returns an empty string when null', () => {
    expect(resolveQueryId(null)).toBe('');
  });
});

describe('resolveCallerId', () => {
  it('prefers the conversation caller id', () => {
    expect(resolveCallerId('caller', 'auth')).toBe('caller');
  });

  it('falls back to the auth user id', () => {
    const noConversationCaller: string | undefined = ([] as string[])[0];
    expect(resolveCallerId(noConversationCaller, 'auth')).toBe('auth');
  });
});

describe('checkDecryptionPending', () => {
  it('is true when there are api messages but none decrypted yet', () => {
    expect(checkDecryptionPending(false, 3, 0)).toBe(true);
  });

  it('is false in create mode', () => {
    expect(checkDecryptionPending(true, 3, 0)).toBe(false);
  });

  it('is false once messages are decrypted', () => {
    expect(checkDecryptionPending(false, 3, 3)).toBe(false);
  });
});

describe('computeInputDisabled', () => {
  it('disables input in create mode before a real conversation exists', () => {
    expect(computeInputDisabled(true, null, 'owner')).toBe(true);
  });

  it('disables input for read-only members', () => {
    expect(computeInputDisabled(false, 'conv-1', 'read')).toBe(true);
  });

  it('enables input for a writable member of a real conversation', () => {
    expect(computeInputDisabled(false, 'conv-1', 'owner')).toBe(false);
  });
});

describe('deriveMessagesReady', () => {
  it('is true once loaded and decrypted outside create mode', () => {
    expect(deriveMessagesReady(false, false, false)).toBe(true);
  });

  it('is false in create mode', () => {
    expect(deriveMessagesReady(true, false, false)).toBe(false);
  });

  it('is false while decryption is pending', () => {
    expect(deriveMessagesReady(false, false, true)).toBe(false);
  });
});

describe('computeDisplayTitle', () => {
  it('returns the local title when set', () => {
    expect(computeDisplayTitle('Local', { title: 'enc', titleEpochNumber: 1 }, 'conv-1')).toBe(
      'Local'
    );
  });

  it('returns undefined when there is no conversation title', () => {
    expect(computeDisplayTitle(null, undefined, 'conv-1')).toBeUndefined();
  });

  it('returns the decrypting placeholder when the epoch key is unavailable', () => {
    getEpochKeyMock.mockReset();
    expect(computeDisplayTitle(null, { title: 'enc', titleEpochNumber: 1 }, 'conv-1')).toBe(
      DECRYPTING_TITLE
    );
  });

  it('decrypts the title when the epoch key is available', () => {
    getEpochKeyMock.mockReturnValue(new Uint8Array([1]));
    decryptTextFromEpochMock.mockReturnValue('My Chat');
    expect(computeDisplayTitle(null, { title: 'ZW5j', titleEpochNumber: 1 }, 'conv-1')).toBe(
      'My Chat'
    );
  });

  it('returns a fallback label when decryption throws', () => {
    getEpochKeyMock.mockReturnValue(new Uint8Array([1]));
    decryptTextFromEpochMock.mockImplementation(() => {
      throw new Error('bad key');
    });
    expect(computeDisplayTitle(null, { title: 'ZW5j', titleEpochNumber: 1 }, 'conv-1')).toBe(
      'Encrypted conversation'
    );
  });
});

describe('resolveChatPageKey', () => {
  it('keeps the same state when the id is unchanged', () => {
    const previous = { prevId: 'conv-a', key: 'conv-a' };
    expect(resolveChatPageKey(previous, 'conv-a', false)).toBe(previous);
  });

  it('holds the key stable across the create→real hop (new→realId with marker)', () => {
    const previous = { prevId: 'new', key: 'new' };
    expect(resolveChatPageKey(previous, 'real-1', true)).toEqual({ prevId: 'real-1', key: 'new' });
  });

  it('remounts (key = id) on a new→existing user switch (no create marker)', () => {
    const previous = { prevId: 'new', key: 'new' };
    expect(resolveChatPageKey(previous, 'existing-1', false)).toEqual({
      prevId: 'existing-1',
      key: 'existing-1',
    });
  });

  it('remounts on an existing→existing switch regardless of the marker', () => {
    const previous = { prevId: 'conv-a', key: 'conv-a' };
    expect(resolveChatPageKey(previous, 'conv-b', true)).toEqual({
      prevId: 'conv-b',
      key: 'conv-b',
    });
  });

  it('remounts when leaving a conversation to start a new chat', () => {
    const previous = { prevId: 'conv-a', key: 'conv-a' };
    expect(resolveChatPageKey(previous, 'new', false)).toEqual({ prevId: 'new', key: 'new' });
  });

  it('after a create→real hop, a later switch still remounts (key follows the new id)', () => {
    const created = resolveChatPageKey({ prevId: 'new', key: 'new' }, 'real-1', true);
    expect(created.key).toBe('new');
    const switched = resolveChatPageKey(created, 'real-2', false);
    expect(switched).toEqual({ prevId: 'real-2', key: 'real-2' });
  });
});
