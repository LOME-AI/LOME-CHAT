import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/notification-channel', () => ({
  notificationChannel: { clearDelivered: vi.fn(() => Promise.resolve()) },
}));
vi.mock('@/hooks/chat/chat', () => ({
  useConversations: vi.fn(),
  chatKeys: {
    all: ['chat'] as const,
    conversations: () => ['chat', 'conversations'] as const,
  },
}));

import {
  useClearConversationNotifications,
  useClearReadElsewhere,
} from '@/hooks/notifications/use-notification-clearing';
import { notificationChannel } from '@/lib/notification-channel';
import { chatKeys, useConversations } from '@/hooks/chat/chat';
import type { ConversationListItem } from '@/lib/api';

const clearDelivered = vi.mocked(notificationChannel.clearDelivered);
const mockedUseConversations = vi.mocked(useConversations);

const CONVERSATION_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60';
const OTHER_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f61';

function conversation(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    id: CONVERSATION_ID,
    title: 'title',
    currentEpoch: 1,
    titleEpochNumber: 1,
    nextSequence: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    accepted: true,
    invitedByUsername: null,
    privilege: 'owner',
    muted: false,
    pinned: false,
    lastReadSeq: 0,
    ...overrides,
  };
}

function setConversations(data: ConversationListItem[] | undefined): void {
  mockedUseConversations.mockReturnValue({
    data,
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  });
}

function wrapper(client: QueryClient) {
  return function Wrapper({
    children,
  }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useClearConversationNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears the notifications for the conversation being read', () => {
    renderHook(() => {
      useClearConversationNotifications(CONVERSATION_ID);
    });

    expect(clearDelivered).toHaveBeenCalledWith([CONVERSATION_ID]);
  });

  it('clears the next conversation when the reader moves on', () => {
    const { rerender } = renderHook(
      ({ id }: { id: string }) => {
        useClearConversationNotifications(id);
      },
      { initialProps: { id: CONVERSATION_ID } }
    );

    rerender({ id: OTHER_ID });

    expect(clearDelivered).toHaveBeenLastCalledWith([OTHER_ID]);
  });

  it('does nothing when no conversation is open', () => {
    renderHook(() => {
      useClearConversationNotifications(null);
    });

    expect(clearDelivered).not.toHaveBeenCalled();
  });

  it('never surfaces a clearing failure', () => {
    clearDelivered.mockRejectedValueOnce(new Error('shade unavailable'));

    expect(() => {
      renderHook(() => {
        useClearConversationNotifications(CONVERSATION_ID);
      });
    }).not.toThrow();
  });
});

describe('useClearReadElsewhere', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setConversations([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('clears the notifications of conversations already read on another device', () => {
    setConversations([
      conversation({ id: CONVERSATION_ID, nextSequence: 5, lastReadSeq: 4 }),
      conversation({ id: OTHER_ID, nextSequence: 5, lastReadSeq: 1 }),
    ]);

    renderHook(
      () => {
        useClearReadElsewhere();
      },
      { wrapper: wrapper(client) }
    );

    expect(clearDelivered).toHaveBeenCalledWith([CONVERSATION_ID]);
  });

  it('leaves a conversation with unread messages notifying', () => {
    setConversations([conversation({ nextSequence: 9, lastReadSeq: 2 })]);

    renderHook(
      () => {
        useClearReadElsewhere();
      },
      { wrapper: wrapper(client) }
    );

    expect(clearDelivered).not.toHaveBeenCalled();
  });

  it('waits for the conversation list before clearing anything', () => {
    setConversations(undefined);

    renderHook(
      () => {
        useClearReadElsewhere();
      },
      { wrapper: wrapper(client) }
    );

    expect(clearDelivered).not.toHaveBeenCalled();
  });

  it('refetches read state when the app comes back to the foreground', () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    renderHook(
      () => {
        useClearReadElsewhere();
      },
      { wrapper: wrapper(client) }
    );

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.conversations() });
  });

  it('leaves the read state alone while the app is in the background', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    renderHook(
      () => {
        useClearReadElsewhere();
      },
      { wrapper: wrapper(client) }
    );

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(invalidate).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('never surfaces a clearing failure', () => {
    clearDelivered.mockRejectedValueOnce(new Error('shade unavailable'));
    setConversations([conversation({ nextSequence: 3, lastReadSeq: 2 })]);

    expect(() => {
      renderHook(
        () => {
          useClearReadElsewhere();
        },
        { wrapper: wrapper(client) }
      );
    }).not.toThrow();
  });
});
