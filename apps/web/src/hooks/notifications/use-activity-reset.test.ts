import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { act } from 'react';
import { useActivityReset } from '@/hooks/notifications/use-activity-reset';
import { useNotificationActivityStore } from '@/stores/notification-activity';

function unreadCount(): number {
  return useNotificationActivityStore.getState().unreadCount;
}

describe('useActivityReset', () => {
  beforeEach(() => {
    useNotificationActivityStore.setState({ unreadCount: 0 });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('clears the count when the user comes back to the tab', () => {
    renderHook(() => {
      useActivityReset();
    });
    useNotificationActivityStore.setState({ unreadCount: 3 });

    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => {
      globalThis.dispatchEvent(new Event('focus'));
    });

    expect(unreadCount()).toBe(0);
  });

  it('clears the count when the tab becomes visible again', () => {
    renderHook(() => {
      useActivityReset();
    });
    useNotificationActivityStore.setState({ unreadCount: 2 });

    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(unreadCount()).toBe(0);
  });

  it('keeps the count while the user is still away', () => {
    renderHook(() => {
      useActivityReset();
    });
    useNotificationActivityStore.setState({ unreadCount: 2 });

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(unreadCount()).toBe(2);
  });

  it('stops clearing once the layer unmounts', () => {
    const { unmount } = renderHook(() => {
      useActivityReset();
    });
    useNotificationActivityStore.setState({ unreadCount: 2 });

    unmount();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => {
      globalThis.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(unreadCount()).toBe(2);
  });
});
