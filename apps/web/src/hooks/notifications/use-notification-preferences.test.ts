import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({
  client: { notifications: { preferences: { $get: vi.fn(), $put: vi.fn() } } },
  fetchJson: vi.fn(),
}));

vi.mock('@/hooks/auth/use-stable-session', () => ({
  useStableSession: vi.fn(),
}));

import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
  notificationPreferencesKeys,
} from '@/hooks/notifications/use-notification-preferences';
import { client, fetchJson } from '@/lib/api-client';
import { useStableSession } from '@/hooks/auth/use-stable-session';

const mockedFetchJson = vi.mocked(fetchJson);
const mockedClient = vi.mocked(client, true);
const mockedUseStableSession = vi.mocked(useStableSession);

const PREFERENCES = {
  globalEnabled: true,
  messages: true,
  runCompletion: true,
  membership: true,
  quietHours: null,
};

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('useNotificationPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseStableSession.mockReturnValue({
      session: null,
      isAuthenticated: true,
      isStable: true,
      isPending: false,
    });
    mockedFetchJson.mockResolvedValue(PREFERENCES);
  });

  it('reads the account preferences', async () => {
    const { result } = renderHook(() => useNotificationPreferences(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(PREFERENCES);
    });
  });

  it('does not query while unauthenticated', () => {
    mockedUseStableSession.mockReturnValue({
      session: null,
      isAuthenticated: false,
      isStable: true,
      isPending: false,
    });

    renderHook(() => useNotificationPreferences(), { wrapper: createWrapper() });

    expect(mockedFetchJson).not.toHaveBeenCalled();
  });

  it('exposes a stable query key', () => {
    expect(notificationPreferencesKeys.preferences).toEqual(['notification-preferences']);
  });
});

const QUIET_HOURS_ON = {
  ...PREFERENCES,
  quietHours: { startMinutes: 1320, endMinutes: 420, timezone: 'America/New_York' },
};

function renderPreferences(): ReturnType<
  typeof renderHook<
    {
      query: ReturnType<typeof useNotificationPreferences>;
      update: ReturnType<typeof useUpdateNotificationPreferences>;
    },
    unknown
  >
> {
  return renderHook(
    () => ({
      query: useNotificationPreferences(),
      update: useUpdateNotificationPreferences(),
    }),
    { wrapper: createWrapper() }
  );
}

describe('useUpdateNotificationPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseStableSession.mockReturnValue({
      session: null,
      isAuthenticated: true,
      isStable: true,
      isPending: false,
    });
    mockedFetchJson.mockResolvedValue(PREFERENCES);
  });

  it('sends the whole preferences body to the preferences route', async () => {
    const { result } = renderPreferences();
    await waitFor(() => {
      expect(result.current.query.data).toEqual(PREFERENCES);
    });

    result.current.update.mutate(QUIET_HOURS_ON);

    await waitFor(() => {
      expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
        json: QUIET_HOURS_ON,
      });
    });
  });

  it('shows the requested preferences before the server has answered', async () => {
    const { result } = renderPreferences();
    await waitFor(() => {
      expect(result.current.query.data).toEqual(PREFERENCES);
    });
    mockedFetchJson.mockImplementationOnce(() => new Promise(() => {}));

    result.current.update.mutate(QUIET_HOURS_ON);

    await waitFor(() => {
      expect(result.current.query.data).toEqual(QUIET_HOURS_ON);
    });
  });

  it('adopts the server answer over the requested value', async () => {
    const { result } = renderPreferences();
    await waitFor(() => {
      expect(result.current.query.data).toEqual(PREFERENCES);
    });
    mockedFetchJson.mockResolvedValueOnce(PREFERENCES);

    result.current.update.mutate(QUIET_HOURS_ON);

    await waitFor(() => {
      expect(result.current.query.data).toEqual(PREFERENCES);
    });
  });

  it('leaves the cache untouched when the mutation fails before the optimistic write', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
      return createElement(QueryClientProvider, { client: queryClient }, children);
    }
    Wrapper.displayName = 'CacheWrapper';
    queryClient.setQueryData(notificationPreferencesKeys.preferences, PREFERENCES);
    // A failure inside onMutate reaches onError with no context, so there is no
    // optimistic write to undo and the rollback must not run.
    vi.spyOn(queryClient, 'cancelQueries').mockRejectedValue(new Error('cancel failed'));
    const { result } = renderHook(() => useUpdateNotificationPreferences(), { wrapper: Wrapper });

    await expect(result.current.mutateAsync(QUIET_HOURS_ON)).rejects.toThrow('cancel failed');

    expect(queryClient.getQueryData(notificationPreferencesKeys.preferences)).toEqual(PREFERENCES);
  });

  it('restores the previous preferences when the update fails', async () => {
    const { result } = renderPreferences();
    await waitFor(() => {
      expect(result.current.query.data).toEqual(PREFERENCES);
    });
    mockedFetchJson.mockRejectedValueOnce(new Error('boom'));

    result.current.update.mutate(QUIET_HOURS_ON);

    await waitFor(() => {
      expect(result.current.update.isError).toBe(true);
    });
    expect(result.current.query.data).toEqual(PREFERENCES);
  });
});
