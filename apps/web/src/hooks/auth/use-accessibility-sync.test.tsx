import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

vi.mock('@/lib/api-client', () => ({
  client: {
    account: {
      preferences: {
        accessibility: {
          $get: vi.fn(),
          $put: vi.fn(),
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

import { client, fetchJson } from '@/lib/api-client';
import { useSession } from '@/lib/auth';
import { useA11yStore, ACCESSIBILITY_PREFERENCES_DEFAULTS } from '@hushbox/ui/accessibility/store';
import { useAccessibilitySync } from '@/hooks/auth/use-accessibility-sync';

const mockedFetchJson = vi.mocked(fetchJson);
const mockedClient = vi.mocked(client, true);
const mockedUseSession = vi.mocked(useSession);

function makeWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return Wrapper;
}

function authed(): void {
  mockedUseSession.mockReturnValue({
    data: { user: { id: 'user-1', email: 'a@b.com' }, session: { id: 's-1' } },
    isPending: false,
  } as unknown as ReturnType<typeof useSession>);
}

function unauthed(): void {
  mockedUseSession.mockReturnValue({
    data: null,
    isPending: false,
  } as unknown as ReturnType<typeof useSession>);
}

function resetStore(): void {
  useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS, updatedAt: null });
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    writable: true,
    configurable: true,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useAccessibilitySync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('unauthenticated', () => {
    it('does not call GET when no session', () => {
      unauthed();
      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      expect(mockedClient.account.preferences.accessibility.$get).not.toHaveBeenCalled();
    });

    it('does not PUT when store changes', async () => {
      unauthed();
      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      // Give microtasks a chance
      await Promise.resolve();
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
    });
  });

  describe('authenticated boot reconcile', () => {
    it('overwrites local store when server has newer timestamp', async () => {
      authed();
      const serverTs = '2026-05-16T12:00:00.000Z';
      mockedFetchJson.mockResolvedValueOnce({
        preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'high' },
        updatedAt: serverTs,
      });
      resetStore();

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );

      await waitFor(() => {
        expect(useA11yStore.getState().contrast).toBe('high');
      });
      expect(useA11yStore.getState().updatedAt).toBe(serverTs);
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
    });

    it('pushes local to server when local timestamp is newer', async () => {
      authed();
      const localTs = '2026-05-16T13:00:00.000Z';
      const serverTs = '2026-05-16T12:00:00.000Z';
      useA11yStore.setState({
        ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
        contrast: 'high',
        updatedAt: localTs,
      });
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: serverTs,
        })
        .mockResolvedValueOnce({ accepted: true });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );

      await waitFor(() => {
        expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(1);
      });
      const putMock = mockedClient.account.preferences.accessibility.$put as ReturnType<
        typeof vi.fn
      >;
      const putCall = putMock.mock.calls[0]?.[0] as {
        json: { updatedAt: string; preferences: { contrast: string } };
      };
      expect(putCall.json.updatedAt).toBe(localTs);
      expect(putCall.json.preferences.contrast).toBe('high');
      expect(useA11yStore.getState().contrast).toBe('high');
      expect(useA11yStore.getState().updatedAt).toBe(localTs);
    });

    it('no-op when timestamps are equal', async () => {
      authed();
      const ts = '2026-05-16T12:00:00.000Z';
      useA11yStore.setState({
        ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
        contrast: 'high',
        updatedAt: ts,
      });
      mockedFetchJson.mockResolvedValueOnce({
        preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'low' },
        updatedAt: ts,
      });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );

      await waitFor(() => {
        expect(mockedFetchJson).toHaveBeenCalled();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
      expect(useA11yStore.getState().contrast).toBe('high');
    });

    it('pulls from server when local has no timestamp (fresh device)', async () => {
      authed();
      const serverTs = '2026-05-16T12:00:00.000Z';
      mockedFetchJson.mockResolvedValueOnce({
        preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, fontSize: '141' },
        updatedAt: serverTs,
      });
      resetStore();

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );

      await waitFor(() => {
        expect(useA11yStore.getState().fontSize).toBe('141');
      });
      expect(useA11yStore.getState().updatedAt).toBe(serverTs);
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
    });

    it('does not echo a PUT after pulling server state (debounce window)', async () => {
      authed();
      vi.useFakeTimers();
      const serverTs = '2026-05-16T12:00:00.000Z';
      mockedFetchJson.mockResolvedValueOnce({
        preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'high' },
        updatedAt: serverTs,
      });
      resetStore();

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );

      // Drain GET + boot reconcile.
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      expect(useA11yStore.getState().contrast).toBe('high');
      expect(useA11yStore.getState().updatedAt).toBe(serverTs);

      // Boot's setState must be deduped — no PUT should fire even after the
      // 750ms debounce window has elapsed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
    });
  });

  describe('debounced sync', () => {
    it('PUTs 750ms after a store change', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: '2026-05-16T12:00:00.000Z',
        })
        .mockResolvedValueOnce({ accepted: true });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );

      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(1);
    });

    it('does not drop a pending write when the PUT lifecycle transitions mid-debounce', async () => {
      authed();
      vi.useFakeTimers();

      let resolveFirstPut: ((value: unknown) => void) | null = null;
      const firstPutSettled = new Promise<unknown>((resolve) => {
        resolveFirstPut = resolve;
      });

      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: '2026-05-16T12:00:00.000Z',
        })
        // First PUT stays in-flight until we resolve it, so its mutation
        // lifecycle transitions (pending -> success) land mid-debounce.
        .mockReturnValueOnce(firstPutSettled)
        .mockResolvedValue({ accepted: true });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      // First toggle: debounce fires, PUT #1 sent and left pending.
      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(1);

      // Second toggle starts a fresh debounce window.
      act(() => {
        useA11yStore.getState().update({ fontSize: '141' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // PUT #1 resolves mid-debounce, flipping the mutation pending -> success.
      // This must not reset the second toggle's debounce timer.
      await act(async () => {
        resolveFirstPut?.({ accepted: true });
        await firstPutSettled;
        await vi.advanceTimersByTimeAsync(0);
      });

      // Finish the second debounce window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(2);
      const putMock = mockedClient.account.preferences.accessibility.$put as ReturnType<
        typeof vi.fn
      >;
      const secondPutCall = putMock.mock.calls[1]?.[0] as {
        json: { preferences: { fontSize: string } };
      };
      expect(secondPutCall.json.preferences.fontSize).toBe('141');
    });

    it('coalesces multiple changes within debounce window into a single PUT', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: '2026-05-16T12:00:00.000Z',
        })
        .mockResolvedValue({ accepted: true });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      act(() => {
        useA11yStore.getState().update({ fontSize: '141' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      act(() => {
        useA11yStore.getState().update({ magnifier: true });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(1);
      const putMock = mockedClient.account.preferences.accessibility.$put as ReturnType<
        typeof vi.fn
      >;
      const putCall = putMock.mock.calls[0]?.[0] as {
        json: { preferences: { contrast: string; fontSize: string; magnifier: boolean } };
      };
      expect(putCall.json.preferences.contrast).toBe('high');
      expect(putCall.json.preferences.fontSize).toBe('141');
      expect(putCall.json.preferences.magnifier).toBe(true);
    });
  });

  describe('visibility flush', () => {
    it('flushes pending PUT immediately when tab becomes hidden', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: '2026-05-16T12:00:00.000Z',
        })
        .mockResolvedValueOnce({ accepted: true });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();

      await act(async () => {
        setVisibility('hidden');
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(1);
    });

    it('does nothing when becoming hidden with no pending PUT', async () => {
      authed();
      mockedFetchJson.mockResolvedValueOnce({
        preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
        updatedAt: '2026-05-16T12:00:00.000Z',
      });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await waitFor(() => {
        expect(mockedFetchJson).toHaveBeenCalled();
      });
      // Let the GET resolution settle into React state before flipping visibility.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      act(() => {
        setVisibility('hidden');
      });
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
    });
  });

  describe('failure modes', () => {
    it('silently absorbs a PUT failure (no throw, store unchanged)', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: '2026-05-16T12:00:00.000Z',
        })
        .mockRejectedValueOnce(new Error('network error'));

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(useA11yStore.getState().contrast).toBe('high');
    });

    it('silently absorbs a GET failure (does not throw, store unchanged)', async () => {
      authed();
      mockedFetchJson.mockRejectedValueOnce(new Error('401'));
      useA11yStore.setState({
        ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
        contrast: 'high',
        updatedAt: '2026-05-16T13:00:00.000Z',
      });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await waitFor(() => {
        expect(mockedFetchJson).toHaveBeenCalled();
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Store still has whatever the user had
      expect(useA11yStore.getState().contrast).toBe('high');
    });
  });

  describe('cleanup', () => {
    it('does not PUT after unmount', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: '2026-05-16T12:00:00.000Z',
        })
        .mockResolvedValueOnce({ accepted: true });

      const { unmount } = renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
    });
  });
});
