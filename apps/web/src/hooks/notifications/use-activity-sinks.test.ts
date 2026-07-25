import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';

vi.mock('@/lib/notification-activity/sound', () => ({
  playNotificationSound: vi.fn(),
  primeNotificationSound: vi.fn(),
}));

import { useActivitySinks } from '@/hooks/notifications/use-activity-sinks';
import { useNotificationActivityStore } from '@/stores/notification-activity';
import { playNotificationSound } from '@/lib/notification-activity/sound';

const playChime = vi.mocked(playNotificationSound);

const BASE_TITLE = 'HushBox';

function setUnread(count: number): void {
  act(() => {
    useNotificationActivityStore.setState({ unreadCount: count });
  });
}

function installBadgeApi(): {
  setAppBadge: ReturnType<typeof vi.fn>;
  clearAppBadge: ReturnType<typeof vi.fn>;
} {
  const setAppBadge = vi.fn(() => Promise.resolve());
  const clearAppBadge = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'setAppBadge', { value: setAppBadge, configurable: true });
  Object.defineProperty(navigator, 'clearAppBadge', { value: clearAppBadge, configurable: true });
  return { setAppBadge, clearAppBadge };
}

describe('useActivitySinks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.title = BASE_TITLE;
    useNotificationActivityStore.setState({ unreadCount: 0, soundEnabled: false });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'setAppBadge');
    Reflect.deleteProperty(navigator, 'clearAppBadge');
  });

  describe('tab title', () => {
    it('leaves the title alone while there is nothing unread', () => {
      renderHook(() => {
        useActivitySinks();
      });

      expect(document.title).toBe(BASE_TITLE);
    });

    it('prefixes the title with the unread count', () => {
      renderHook(() => {
        useActivitySinks();
      });

      setUnread(3);

      expect(document.title).toBe(`(3) ${BASE_TITLE}`);
    });

    it('restores the plain title once everything is seen', () => {
      renderHook(() => {
        useActivitySinks();
      });
      setUnread(2);

      act(() => {
        useNotificationActivityStore.getState().markAllSeen();
      });

      expect(document.title).toBe(BASE_TITLE);
    });

    it('never compounds its own prefix', () => {
      renderHook(() => {
        useActivitySinks();
      });

      setUnread(1);
      setUnread(2);

      expect(document.title).toBe(`(2) ${BASE_TITLE}`);
    });

    it('restores the title when the layer unmounts', () => {
      const { unmount } = renderHook(() => {
        useActivitySinks();
      });
      setUnread(4);

      unmount();

      expect(document.title).toBe(BASE_TITLE);
    });
  });

  describe('app badge', () => {
    it('shows the count on the app icon', () => {
      const { setAppBadge } = installBadgeApi();
      renderHook(() => {
        useActivitySinks();
      });

      setUnread(2);

      expect(setAppBadge).toHaveBeenLastCalledWith(2);
    });

    it('clears the badge when everything is seen', () => {
      const { clearAppBadge } = installBadgeApi();
      renderHook(() => {
        useActivitySinks();
      });
      setUnread(2);

      act(() => {
        useNotificationActivityStore.getState().markAllSeen();
      });

      expect(clearAppBadge).toHaveBeenCalled();
    });

    it('renders fine on a platform without app badging', () => {
      expect(() => {
        renderHook(() => {
          useActivitySinks();
        });
        setUnread(1);
      }).not.toThrow();
    });
  });

  describe('sound', () => {
    it('stays silent while sound is off', () => {
      renderHook(() => {
        useActivitySinks();
      });

      setUnread(1);

      expect(playChime).not.toHaveBeenCalled();
    });

    it('chimes once per arrival while sound is on', () => {
      useNotificationActivityStore.setState({ soundEnabled: true });
      renderHook(() => {
        useActivitySinks();
      });

      setUnread(1);
      setUnread(2);

      expect(playChime).toHaveBeenCalledTimes(2);
    });

    it('stays silent when the count is cleared', () => {
      useNotificationActivityStore.setState({ soundEnabled: true });
      renderHook(() => {
        useActivitySinks();
      });
      setUnread(2);
      playChime.mockClear();

      act(() => {
        useNotificationActivityStore.getState().markAllSeen();
      });

      expect(playChime).not.toHaveBeenCalled();
    });

    it('does not chime for activity that arrived before this session was watching', () => {
      useNotificationActivityStore.setState({ soundEnabled: true, unreadCount: 5 });

      renderHook(() => {
        useActivitySinks();
      });

      expect(playChime).not.toHaveBeenCalled();
    });
  });
});
