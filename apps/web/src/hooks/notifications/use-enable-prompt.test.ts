import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('@/lib/notification-channel', () => ({
  notificationChannel: {
    getPermissionState: vi.fn(() => Promise.resolve('default')),
    requestPermissionAndRegister: vi.fn(() => Promise.resolve('granted')),
  },
  isPromptDismissed: vi.fn(() => false),
  markPromptDismissed: vi.fn(),
}));

vi.mock('@/hooks/notifications/use-notification-preferences', () => ({
  useNotificationPreferences: vi.fn(),
}));

import { useEnablePrompt } from '@/hooks/notifications/use-enable-prompt';
import {
  notificationChannel,
  isPromptDismissed,
  markPromptDismissed,
} from '@/lib/notification-channel';
import { useNotificationPreferences } from '@/hooks/notifications/use-notification-preferences';

const getPermissionState = vi.mocked(notificationChannel.getPermissionState);
const requestPermissionAndRegister = vi.mocked(notificationChannel.requestPermissionAndRegister);
const mockedIsDismissed = vi.mocked(isPromptDismissed);
const mockedMarkDismissed = vi.mocked(markPromptDismissed);
const mockedUsePreferences = vi.mocked(useNotificationPreferences);

function setPreferences(data: { globalEnabled: boolean } | undefined): void {
  mockedUsePreferences.mockReturnValue({ data } as ReturnType<typeof useNotificationPreferences>);
}

describe('useEnablePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsDismissed.mockReturnValue(false);
    getPermissionState.mockResolvedValue('default');
    requestPermissionAndRegister.mockResolvedValue('granted');
    setPreferences({ globalEnabled: true });
  });

  it('shows on a device that has never answered the permission question', async () => {
    const { result } = renderHook(() => useEnablePrompt());

    await waitFor(() => {
      expect(result.current.isVisible).toBe(true);
    });
  });

  it('stays hidden once dismissed on this device', async () => {
    mockedIsDismissed.mockReturnValue(true);

    const { result } = renderHook(() => useEnablePrompt());

    await waitFor(() => {
      expect(getPermissionState).not.toHaveBeenCalled();
    });
    expect(result.current.isVisible).toBe(false);
  });

  it.each(['granted', 'denied', 'unsupported'] as const)(
    'stays hidden when the permission state is %s',
    async (state) => {
      getPermissionState.mockResolvedValue(state);

      const { result } = renderHook(() => useEnablePrompt());

      await waitFor(() => {
        expect(getPermissionState).toHaveBeenCalled();
      });
      expect(result.current.isVisible).toBe(false);
    }
  );

  it('stays hidden when the permission cannot be read', async () => {
    getPermissionState.mockRejectedValue(new Error('bridge unavailable'));

    const { result } = renderHook(() => useEnablePrompt());

    await waitFor(() => {
      expect(getPermissionState).toHaveBeenCalled();
    });
    expect(result.current.isVisible).toBe(false);
  });

  it('drops a permission read that resolves after unmount', async () => {
    const resolvers: ((state: 'default') => void)[] = [];
    getPermissionState.mockReturnValue(
      new Promise((resolve) => {
        resolvers.push(resolve);
      })
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = renderHook(() => useEnablePrompt());
    await waitFor(() => {
      expect(resolvers).toHaveLength(1);
    });
    unmount();
    resolvers[0]?.('default');
    await Promise.resolve();

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('stays hidden while preferences are still loading', () => {
    setPreferences(undefined);

    const { result } = renderHook(() => useEnablePrompt());

    expect(result.current.isVisible).toBe(false);
    expect(getPermissionState).not.toHaveBeenCalled();
  });

  it('stays hidden when notifications are switched off for the account', () => {
    setPreferences({ globalEnabled: false });

    const { result } = renderHook(() => useEnablePrompt());

    expect(result.current.isVisible).toBe(false);
    expect(getPermissionState).not.toHaveBeenCalled();
  });

  it('never asks for permission on its own', async () => {
    renderHook(() => useEnablePrompt());

    await waitFor(() => {
      expect(getPermissionState).toHaveBeenCalled();
    });
    expect(requestPermissionAndRegister).not.toHaveBeenCalled();
  });

  it('asks for permission and registers when the user enables', async () => {
    const { result } = renderHook(() => useEnablePrompt());
    await waitFor(() => {
      expect(result.current.isVisible).toBe(true);
    });

    act(() => {
      result.current.enable();
    });

    await waitFor(() => {
      expect(requestPermissionAndRegister).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.isVisible).toBe(false);
    });
  });

  it('re-reads the permission when registering fails after the grant', async () => {
    requestPermissionAndRegister.mockRejectedValue(new Error('offline'));
    getPermissionState.mockResolvedValueOnce('default').mockResolvedValueOnce('granted');

    const { result } = renderHook(() => useEnablePrompt());
    await waitFor(() => {
      expect(result.current.isVisible).toBe(true);
    });

    act(() => {
      result.current.enable();
    });

    await waitFor(() => {
      expect(result.current.isVisible).toBe(false);
    });
    expect(result.current.isEnabling).toBe(false);
  });

  it('keeps the prompt open when the platform cannot be reached at all', async () => {
    requestPermissionAndRegister.mockRejectedValue(new Error('offline'));
    getPermissionState.mockResolvedValueOnce('default').mockRejectedValueOnce(new Error('offline'));

    const { result } = renderHook(() => useEnablePrompt());
    await waitFor(() => {
      expect(result.current.isVisible).toBe(true);
    });

    act(() => {
      result.current.enable();
    });

    await waitFor(() => {
      expect(result.current.isEnabling).toBe(false);
    });
    expect(result.current.isVisible).toBe(true);
  });

  it('marks the device dismissed and hides when the user picks later', async () => {
    const { result } = renderHook(() => useEnablePrompt());
    await waitFor(() => {
      expect(result.current.isVisible).toBe(true);
    });

    act(() => {
      result.current.dismiss();
    });

    expect(mockedMarkDismissed).toHaveBeenCalledTimes(1);
    expect(result.current.isVisible).toBe(false);
  });
});
