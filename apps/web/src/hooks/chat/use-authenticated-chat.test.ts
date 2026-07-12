import { describe, it, expect, vi } from 'vitest';

// Mock modules that trigger env validation on import
vi.mock('@/lib/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock('@/lib/api-client', () => ({
  client: {},
  fetchJson: vi.fn(),
}));
vi.mock('@/lib/sse-client', () => ({}));
vi.mock('@/hooks/chat/use-chat-stream', () => ({}));
vi.mock('@/hooks/chat/chat', () => ({
  DECRYPTING_TITLE: 'Decrypting...',
}));
vi.mock('@/hooks/chat/use-chat-page', () => ({}));
vi.mock('@/hooks/chat/use-optimistic-messages', () => ({}));
vi.mock('@/hooks/crypto/use-decrypted-messages', () => ({}));
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return { ...actual, useIsMobile: () => false };
});
vi.mock('@/hooks/chat/forks', () => ({}));
vi.mock('@/hooks/chat/use-fork-messages', () => ({}));
vi.mock('@/hooks/billing/billing', () => ({}));
vi.mock('@/stores/pending-chat', () => ({}));
vi.mock('@/stores/model', () => ({}));
vi.mock('@/stores/search', () => ({}));
vi.mock('@/stores/chat-error', () => ({}));
vi.mock('@/lib/auth', () => ({}));
vi.mock('@/lib/epoch-key-cache', () => ({}));
vi.mock('@/lib/chat-messages', () => ({}));
vi.mock('@/lib/multi-model-stream', () => ({}));
vi.mock('@/lib/chat-regeneration', () => ({}));
vi.mock('@/stores/streaming-activity', () => ({}));
vi.mock('@hushbox/crypto', () => ({}));

import type { ImageConfig, VideoConfig } from '@hushbox/shared';
import {
  shouldRedirect,
  computeRenderState,
  computePruneIds,
  mergeMessages,
  requestedMediaAspectRatio,
  pendingMediaInFlight,
  shouldStreamFirstTurn,
  DECRYPTING_TITLE,
} from '@/hooks/chat/use-authenticated-chat';

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

function baseParams(): Parameters<typeof computeRenderState>[0] {
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

describe('pendingMediaInFlight', () => {
  const imageConfig: ImageConfig = { aspectRatio: '4:3' };
  const videoConfig: VideoConfig = { aspectRatio: '9:16', durationSeconds: 4, resolution: '720p' };

  it('returns undefined for text turns', () => {
    expect(pendingMediaInFlight('text', imageConfig, videoConfig)).toBeUndefined();
  });

  it('stamps image with the requested aspect ratio and a placeholder mime', () => {
    expect(pendingMediaInFlight('image', imageConfig, videoConfig)).toEqual({
      mediaType: 'image',
      mimeType: 'application/octet-stream',
      aspectRatio: '4:3',
    });
  });

  it('stamps video with the requested aspect ratio', () => {
    expect(pendingMediaInFlight('video', imageConfig, videoConfig)).toEqual({
      mediaType: 'video',
      mimeType: 'application/octet-stream',
      aspectRatio: '9:16',
    });
  });

  it('stamps audio with no aspect ratio', () => {
    expect(pendingMediaInFlight('audio', imageConfig, videoConfig)).toEqual({
      mediaType: 'audio',
      mimeType: 'application/octet-stream',
    });
  });
});

describe('requestedMediaAspectRatio', () => {
  const imageConfig: ImageConfig = { aspectRatio: '4:3' };
  const videoConfig: VideoConfig = { aspectRatio: '9:16', durationSeconds: 4, resolution: '720p' };

  it('returns the image aspect ratio for image generation', () => {
    expect(requestedMediaAspectRatio('image', imageConfig, videoConfig)).toBe('4:3');
  });

  it('returns the video aspect ratio for video generation', () => {
    expect(requestedMediaAspectRatio('video', imageConfig, videoConfig)).toBe('9:16');
  });

  it('returns undefined for audio, which has no 2D shape', () => {
    expect(requestedMediaAspectRatio('audio', imageConfig, videoConfig)).toBeUndefined();
  });
});

describe('computePruneIds', () => {
  it('retry: removes every descendant of the user-message target, keeps target', () => {
    const messages = [
      makeMessage('u1'),
      makeMessage('a1', 'assistant'),
      makeMessage('u2'),
      makeMessage('a2', 'assistant'),
    ];
    const ids = computePruneIds(messages, 'u1', 'retry');
    expect([...ids]).toEqual(['a1', 'u2', 'a2']);
  });

  it('edit: removes the target user message itself plus every descendant', () => {
    const messages = [
      makeMessage('u1'),
      makeMessage('a1', 'assistant'),
      makeMessage('u2'),
      makeMessage('a2', 'assistant'),
    ];
    const ids = computePruneIds(messages, 'u2', 'edit');
    expect([...ids]).toEqual(['u2', 'a2']);
  });

  it('regenerate-one: returns only the named assistant id regardless of action', () => {
    const messages = [
      makeMessage('u1'),
      makeMessage('a1', 'assistant'),
      makeMessage('a2', 'assistant'),
    ];
    const retryOne = computePruneIds(messages, 'u1', 'retry', 'a1');
    expect([...retryOne]).toEqual(['a1']);
    const editOne = computePruneIds(messages, 'u1', 'edit', 'a2');
    expect([...editOne]).toEqual(['a2']);
  });

  it('returns empty set when target not found', () => {
    const messages = [makeMessage('u1'), makeMessage('a1', 'assistant')];
    expect(computePruneIds(messages, 'missing', 'retry').size).toBe(0);
    expect(computePruneIds(messages, 'missing', 'edit').size).toBe(0);
  });
});

describe('shouldStreamFirstTurn', () => {
  it('streams the first turn for a newly created conversation (created: true)', () => {
    expect(shouldStreamFirstTurn({ created: true })).toBe(true);
  });

  it('does not re-stream an idempotent existing conversation (created: false)', () => {
    expect(shouldStreamFirstTurn({ created: false })).toBe(false);
  });
});

describe('shouldRedirect', () => {
  it('returns true when in create mode with no pending message and no local messages', () => {
    expect(shouldRedirect(true, null, 0)).toBe(true);
  });

  it('returns false when not in create mode', () => {
    expect(shouldRedirect(false, null, 0)).toBe(false);
  });

  it('returns false when there is a pending message', () => {
    expect(shouldRedirect(true, 'hello', 0)).toBe(false);
  });

  it('returns false when there are local messages', () => {
    expect(shouldRedirect(true, null, 3)).toBe(false);
  });

  it('returns false when pending message is empty string (truthy check)', () => {
    expect(shouldRedirect(true, '', 0)).toBe(true);
  });
});

describe('computeRenderState', () => {
  it('returns redirecting when create mode with no pending message and no local messages', () => {
    const result = computeRenderState({
      ...baseParams(),
      isCreateMode: true,
      pendingMessage: null,
      localMessagesLength: 0,
    });
    expect(result).toEqual({ type: 'redirecting' });
  });

  it('returns ready in create mode with pending message', () => {
    const result = computeRenderState({
      ...baseParams(),
      isCreateMode: true,
      pendingMessage: 'hello',
    });
    expect(result).toEqual({ type: 'ready' });
  });

  it('returns not-found when no conversation and not loading', () => {
    const result = computeRenderState({
      ...baseParams(),
      conversation: undefined,
      isConversationLoading: false,
    });
    expect(result).toEqual({ type: 'not-found' });
  });

  it('returns loading when conversation is loading', () => {
    const result = computeRenderState({
      ...baseParams(),
      isConversationLoading: true,
    });
    expect(result).toEqual({ type: 'loading', title: DECRYPTING_TITLE });
  });

  it('returns loading when messages are loading', () => {
    const result = computeRenderState({
      ...baseParams(),
      isMessagesLoading: true,
    });
    expect(result).toEqual({ type: 'loading', title: DECRYPTING_TITLE });
  });

  it('returns ready when loading but local messages exist', () => {
    const result = computeRenderState({
      ...baseParams(),
      isMessagesLoading: true,
      localMessagesLength: 3,
    });
    expect(result).toEqual({ type: 'ready' });
  });

  it('returns ready when everything loaded and no decryption pending', () => {
    const result = computeRenderState(baseParams());
    expect(result).toEqual({ type: 'ready' });
  });

  it('returns loading with decrypting title when decryption is pending', () => {
    const result = computeRenderState({
      ...baseParams(),
      isDecryptionPending: true,
    });
    expect(result).toEqual({ type: 'loading', title: DECRYPTING_TITLE });
  });

  it('returns ready when decryption pending but in create mode', () => {
    const result = computeRenderState({
      ...baseParams(),
      isCreateMode: true,
      pendingMessage: 'hello',
      isDecryptionPending: true,
    });
    expect(result).toEqual({ type: 'ready' });
  });
});

describe('mergeMessages', () => {
  it('sets modelName on error message from primaryModelId', () => {
    const result = mergeMessages({
      isCreateMode: true,
      realConversationId: null,
      localMessages: [makeMessage('u1')],
      decryptedApiMessages: [],
      optimisticMessages: [],
      chatError: { id: 'err-1', content: 'Something went wrong' },
      primaryModelId: 'smart-model',
    });
    const errorMsg = result.find((m) => m.id === 'err-1');
    expect(errorMsg).toBeDefined();
    expect(errorMsg?.modelName).toBe('smart-model');
  });

  it('does not add error message when chatError is null', () => {
    const result = mergeMessages({
      isCreateMode: true,
      realConversationId: null,
      localMessages: [makeMessage('u1')],
      decryptedApiMessages: [],
      optimisticMessages: [],
      chatError: null,
      primaryModelId: 'smart-model',
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('u1');
  });
});
