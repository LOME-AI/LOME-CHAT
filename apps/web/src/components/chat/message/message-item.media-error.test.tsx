import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { legacyFriendlyErrorMessage, ERROR_CODE_STORAGE_READ_FAILED } from '@hushbox/shared';
import { MessageItem } from '@/components/chat/message/message-item';
import type { Message } from '@/lib/api';
import type { MessageAction } from '@/lib/message-actions';

// Drives the REAL chat-bubble chain end to end:
//   MessageItem → MessageBody → MessageMediaList → MediaContentItem → MediaItemShell.
// Only the two leaves that need jsdom-unfriendly infrastructure are stubbed:
//   - `useDecryptedMedia` (TanStack Query network round-trip) is pinned to a
//     stuck-loading state, the realistic per-item state for undecryptable media:
//     the only thing that flips the UI from spinner to error is the message-level
//     content-key error threaded down from `MessageItem` (H11, primary path).
//   - the epoch-key cache returns nothing, so `useMessageContentKey` resolves to
//     a real `{ contentKey: null, error }` — an undecryptable message.

vi.mock('@/hooks/crypto/use-decrypted-media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/crypto/use-decrypted-media')>()),
  useDecryptedMedia: () => ({ blobUrl: null, isLoading: true, error: null }),
}));

vi.mock('@/lib/epoch-key-cache', () => ({
  getEpochKey: vi.fn(() => {}),
  setEpochKey: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  getSnapshot: vi.fn(() => 0),
}));

vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({ data: { models: [] } }),
}));

const ALL_AI_ACTIONS = new Set<MessageAction>(['copy', 'regenerate', 'fork', 'share']);

const messageWithUndecryptableMedia: Message = {
  id: 'msg-undecryptable',
  conversationId: 'conv-1',
  role: 'assistant',
  content: '',
  createdAt: '2024-01-01T00:00:01Z',
  wrappedContentKey: 'base64-wrapped-key',
  epochNumber: 1,
  mediaItems: [
    {
      id: 'ci-image-1',
      contentType: 'image',
      position: 0,
      mimeType: 'image/png',
      sizeBytes: 1_000_000,
      width: 1024,
      height: 1024,
    },
  ],
};

describe('MessageItem undecryptable media (chat bubble path)', () => {
  it('shows the error UI, not a perpetual spinner, when the content key cannot be resolved', () => {
    render(<MessageItem message={messageWithUndecryptableMedia} allowedActions={ALL_AI_ACTIONS} />);

    expect(
      screen.getByRole('status', { name: legacyFriendlyErrorMessage(ERROR_CODE_STORAGE_READ_FAILED) })
    ).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /loading media/i })).not.toBeInTheDocument();
  });
});
