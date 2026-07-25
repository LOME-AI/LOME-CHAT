import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/notification-channel', () => ({
  notificationChannel: { ensureRegistered: vi.fn(() => Promise.resolve()) },
}));

vi.mock('@/hooks/auth/use-stable-session', () => ({ useStableSession: vi.fn() }));
vi.mock('@/hooks/notifications/use-notification-preferences', () => ({
  useNotificationPreferences: vi.fn(),
}));

import { usePushRegistration } from '@/hooks/notifications/use-push-registration';
import { notificationChannel } from '@/lib/notification-channel';
import { useStableSession } from '@/hooks/auth/use-stable-session';
import { useNotificationPreferences } from '@/hooks/notifications/use-notification-preferences';

const ensureRegistered = vi.mocked(notificationChannel.ensureRegistered);
const mockedUseStableSession = vi.mocked(useStableSession);
const mockedUsePreferences = vi.mocked(useNotificationPreferences);

function setSession(isAuthenticated: boolean): void {
  mockedUseStableSession.mockReturnValue({
    session: null,
    isAuthenticated,
    isStable: true,
    isPending: false,
  });
}

function setPreferences(data: { globalEnabled: boolean } | undefined): void {
  mockedUsePreferences.mockReturnValue({ data } as ReturnType<typeof useNotificationPreferences>);
}

describe('usePushRegistration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSession(true);
    setPreferences({ globalEnabled: true });
  });

  it('re-registers this device once auth and preferences are known', async () => {
    renderHook(() => {
      usePushRegistration();
    });

    await waitFor(() => {
      expect(ensureRegistered).toHaveBeenCalledTimes(1);
    });
  });

  it('registers only once per app start, even as preferences refetch', async () => {
    const { rerender } = renderHook(() => {
      usePushRegistration();
    });

    await waitFor(() => {
      expect(ensureRegistered).toHaveBeenCalledTimes(1);
    });
    // A refetch hands back an equal-but-new preferences object, which re-runs
    // the effect; registration must not fire again.
    setPreferences({ globalEnabled: true });
    rerender();
    setPreferences({ globalEnabled: true });
    rerender();

    expect(ensureRegistered).toHaveBeenCalledTimes(1);
  });

  it('does not register while unauthenticated', () => {
    setSession(false);

    renderHook(() => {
      usePushRegistration();
    });

    expect(ensureRegistered).not.toHaveBeenCalled();
  });

  it('waits for preferences before registering', () => {
    setPreferences(undefined);

    renderHook(() => {
      usePushRegistration();
    });

    expect(ensureRegistered).not.toHaveBeenCalled();
  });

  it('does not resurrect a subscription the user switched off', () => {
    setPreferences({ globalEnabled: false });

    renderHook(() => {
      usePushRegistration();
    });

    expect(ensureRegistered).not.toHaveBeenCalled();
  });

  it('never surfaces a registration failure', async () => {
    ensureRegistered.mockRejectedValueOnce(new Error('subscription refused'));

    expect(() => {
      renderHook(() => {
        usePushRegistration();
      });
    }).not.toThrow();

    await waitFor(() => {
      expect(ensureRegistered).toHaveBeenCalled();
    });
  });
});
