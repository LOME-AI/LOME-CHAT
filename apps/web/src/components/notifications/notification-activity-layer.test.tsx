import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { act } from 'react';

vi.mock('@/lib/notification-channel', () => ({
  notificationChannel: { clearDelivered: vi.fn(() => Promise.resolve()) },
}));
vi.mock('@/hooks/chat/chat', () => ({
  useConversations: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  })),
  chatKeys: {
    all: ['chat'] as const,
    conversations: () => ['chat', 'conversations'] as const,
  },
}));

import { NotificationActivityLayer } from '@/components/notifications/notification-activity-layer';
import { useNotificationActivityStore } from '@/stores/notification-activity';
import { renderWithProviders } from '@/test-utils/render';

/** The store's feeds live elsewhere; the layer only presents what they record. */
function observeActivity(): void {
  act(() => {
    useNotificationActivityStore.getState().recordActivity();
  });
}

describe('NotificationActivityLayer', () => {
  beforeEach(() => {
    useNotificationActivityStore.setState({ unreadCount: 0, soundEnabled: false });
    document.title = 'HushBox';
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.title = 'HushBox';
  });

  it('turns observed activity into a title, and an announcement', () => {
    renderWithProviders(<NotificationActivityLayer />);

    observeActivity();

    expect(document.title).toBe('(1) HushBox');
    expect(screen.getByRole('status')).toHaveTextContent('1 new notification');
  });

  it('clears everything when the user comes back', () => {
    renderWithProviders(<NotificationActivityLayer />);
    observeActivity();

    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => {
      globalThis.dispatchEvent(new Event('focus'));
    });

    expect(document.title).toBe('HushBox');
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});
