import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api-client', () => ({
  client: { conversations: { ':conversationId': { read: { $patch: vi.fn() } } } },
  fetchJson: vi.fn(),
}));
vi.mock('@/hooks/chat/chat', () => ({
  useConversations: vi.fn(),
  chatKeys: {
    all: ['chat'] as const,
    conversations: () => ['chat', 'conversations'] as const,
  },
}));
vi.mock('@/lib/notification-channel', () => ({
  notificationChannel: { clearDelivered: vi.fn(() => Promise.resolve()) },
}));

import { useAdvanceReadCursor } from '@/hooks/notifications/use-read-cursor';
import { useClearReadElsewhere } from '@/hooks/notifications/use-notification-clearing';
import { client, fetchJson } from '@/lib/api-client';
import { chatKeys, useConversations } from '@/hooks/chat/chat';
import { notificationChannel } from '@/lib/notification-channel';
import type { ConversationListItem } from '@/lib/api';

const CONVERSATION_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60';
const OTHER_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f61';

const mockedClient = vi.mocked(client, true);
const mockedFetchJson = vi.mocked(fetchJson);
const mockedUseConversations = vi.mocked(useConversations);
const readPatch = vi.mocked(mockedClient.conversations[':conversationId'].read.$patch);
const clearDelivered = vi.mocked(notificationChannel.clearDelivered);

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

/** Gives any write the hook decided to make time to reach the client mock. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function wrapper(client_: QueryClient) {
  return function Wrapper({
    children,
  }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
    return <QueryClientProvider client={client_}>{children}</QueryClientProvider>;
  };
}

describe('useAdvanceReadCursor', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockedFetchJson.mockResolvedValue({ lastReadSeq: 0 });
    setConversations([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('acknowledges the newest message of the conversation being read', async () => {
    setConversations([conversation({ nextSequence: 5, lastReadSeq: 0 })]);

    renderHook(
      () => {
        useAdvanceReadCursor(CONVERSATION_ID);
      },
      { wrapper: wrapper(queryClient) }
    );

    await waitFor(() => {
      expect(readPatch).toHaveBeenCalledWith({
        param: { conversationId: CONVERSATION_ID },
        json: { lastReadSeq: 4 },
      });
    });
  });

  it('acknowledges once while the conversation stays open', async () => {
    setConversations([conversation({ nextSequence: 5, lastReadSeq: 0 })]);

    const { rerender } = renderHook(
      () => {
        useAdvanceReadCursor(CONVERSATION_ID);
      },
      { wrapper: wrapper(queryClient) }
    );

    rerender();
    rerender();
    rerender();

    await waitFor(() => {
      expect(readPatch).toHaveBeenCalledTimes(1);
    });
    expect(readPatch).toHaveBeenCalledTimes(1);
  });

  it('stops acknowledging once the refreshed list echoes the cursor back', async () => {
    setConversations([conversation({ nextSequence: 5, lastReadSeq: 0 })]);

    const { rerender } = renderHook(
      () => {
        useAdvanceReadCursor(CONVERSATION_ID);
      },
      { wrapper: wrapper(queryClient) }
    );
    await waitFor(() => {
      expect(readPatch).toHaveBeenCalledTimes(1);
    });

    setConversations([conversation({ nextSequence: 5, lastReadSeq: 4 })]);
    rerender();
    await settle();

    expect(readPatch).toHaveBeenCalledTimes(1);
  });

  it('acknowledges again once a newer message arrives', async () => {
    setConversations([conversation({ nextSequence: 5, lastReadSeq: 0 })]);

    const { rerender } = renderHook(
      () => {
        useAdvanceReadCursor(CONVERSATION_ID);
      },
      { wrapper: wrapper(queryClient) }
    );
    await waitFor(() => {
      expect(readPatch).toHaveBeenCalledTimes(1);
    });

    setConversations([conversation({ nextSequence: 9, lastReadSeq: 0 })]);
    rerender();

    await waitFor(() => {
      expect(readPatch).toHaveBeenLastCalledWith({
        param: { conversationId: CONVERSATION_ID },
        json: { lastReadSeq: 8 },
      });
    });
  });

  it('leaves an already acknowledged conversation alone', async () => {
    setConversations([conversation({ nextSequence: 5, lastReadSeq: 4 })]);

    renderHook(
      () => {
        useAdvanceReadCursor(CONVERSATION_ID);
      },
      { wrapper: wrapper(queryClient) }
    );
    await settle();

    expect(readPatch).not.toHaveBeenCalled();
  });

  it('acknowledges nothing while no conversation is open', async () => {
    setConversations([conversation({ nextSequence: 5, lastReadSeq: 0 })]);

    renderHook(
      () => {
        useAdvanceReadCursor(null);
      },
      { wrapper: wrapper(queryClient) }
    );
    await settle();

    expect(readPatch).not.toHaveBeenCalled();
  });

  it('acknowledges nothing for a conversation the reader has no membership of', async () => {
    setConversations([conversation({ id: OTHER_ID, nextSequence: 5, lastReadSeq: 0 })]);

    renderHook(
      () => {
        useAdvanceReadCursor(CONVERSATION_ID);
      },
      { wrapper: wrapper(queryClient) }
    );
    await settle();

    expect(readPatch).not.toHaveBeenCalled();
  });

  it('refreshes read state once the cursor has advanced', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    setConversations([conversation({ nextSequence: 5, lastReadSeq: 0 })]);

    renderHook(
      () => {
        useAdvanceReadCursor(CONVERSATION_ID);
      },
      { wrapper: wrapper(queryClient) }
    );

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: chatKeys.conversations() });
    });
  });

  it('never surfaces a failed acknowledgement', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    mockedFetchJson.mockRejectedValue(new Error('offline'));
    setConversations([conversation({ nextSequence: 5, lastReadSeq: 0 })]);

    expect(() => {
      renderHook(
        () => {
          useAdvanceReadCursor(CONVERSATION_ID);
        },
        { wrapper: wrapper(queryClient) }
      );
    }).not.toThrow();

    await waitFor(() => {
      expect(readPatch).toHaveBeenCalledTimes(1);
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('dismissal on read elsewhere', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockedFetchJson.mockResolvedValue({ lastReadSeq: 4 });
  });

  afterEach(() => {
    cleanup();
  });

  it('stops a conversation notifying once reading it has advanced the cursor', async () => {
    setConversations([conversation({ nextSequence: 5, lastReadSeq: 0 })]);

    const { rerender } = renderHook(
      () => {
        useAdvanceReadCursor(CONVERSATION_ID);
        useClearReadElsewhere();
      },
      { wrapper: wrapper(queryClient) }
    );

    // Nothing to dismiss yet: the server has not been told anything was read.
    await settle();
    expect(clearDelivered).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(readPatch).toHaveBeenCalledWith({
        param: { conversationId: CONVERSATION_ID },
        json: { lastReadSeq: 4 },
      });
    });

    // The refreshed list carries the cursor the write just moved.
    setConversations([conversation({ nextSequence: 5, lastReadSeq: 4 })]);
    rerender();

    await waitFor(() => {
      expect(clearDelivered).toHaveBeenCalledWith([CONVERSATION_ID]);
    });
  });
});
