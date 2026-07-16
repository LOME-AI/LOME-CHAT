import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/stores/streaming-activity', () => ({
  useStreamingActivityStore: vi.fn(),
}));

vi.mock('@/stores/decryption-activity', () => ({
  useDecryptionActivityStore: vi.fn(),
}));

vi.mock('@/stores/websocket-inbound-activity', () => ({
  useWebsocketInboundActivityStore: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuthStore: vi.fn(),
}));

vi.mock('@hushbox/ui', () => ({
  useAsyncActivityStore: vi.fn(),
}));

import { useStreamingActivityStore } from '@/stores/streaming-activity';
import { useDecryptionActivityStore } from '@/stores/decryption-activity';
import { useWebsocketInboundActivityStore } from '@/stores/websocket-inbound-activity';
import { useAuthStore } from '@/lib/auth';
import { useAsyncActivityStore } from '@hushbox/ui';
import { useIsSettled, DEBOUNCE_MS } from '@/hooks/ui/use-is-settled.js';

const mockedUseStreamingActivityStore = vi.mocked(useStreamingActivityStore);
const mockedUseDecryptionActivityStore = vi.mocked(useDecryptionActivityStore);
const mockedUseWebsocketInboundActivityStore = vi.mocked(useWebsocketInboundActivityStore);
const mockedUseAuthStore = vi.mocked(useAuthStore);
const mockedUseAsyncActivityStore = vi.mocked(useAsyncActivityStore);

function createWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return Wrapper;
}

describe('useIsSettled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedUseStreamingActivityStore.mockReturnValue(0);
    mockedUseDecryptionActivityStore.mockReturnValue(0);
    mockedUseWebsocketInboundActivityStore.mockReturnValue(0);
    mockedUseAuthStore.mockReturnValue(false);
    mockedUseAsyncActivityStore.mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('debounces for 5 seconds', () => {
    expect(DEBOUNCE_MS).toBe(5000);
  });

  it('returns false initially even when idle (debounce has not fired)', () => {
    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    expect(result.current).toBe(false);
  });

  it('returns true after debounce period when idle', () => {
    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(result.current).toBe(true);
  });

  it('reads each activity count through its store selector', () => {
    // Drive the real selector callbacks (rather than returning a fixed number)
    // so the derived-idle computation runs against actual store slices.
    mockedUseStreamingActivityStore.mockImplementation((selector) =>
      (selector as (s: { activeStreams: number }) => unknown)({ activeStreams: 0 })
    );
    mockedUseDecryptionActivityStore.mockImplementation((selector) =>
      (selector as (s: { pendingDecryptions: number }) => unknown)({ pendingDecryptions: 0 })
    );
    mockedUseWebsocketInboundActivityStore.mockImplementation((selector) =>
      (selector as (s: { pendingInbound: number }) => unknown)({ pendingInbound: 0 })
    );
    mockedUseAuthStore.mockImplementation((selector) =>
      (selector as (s: { isLoading: boolean }) => unknown)({ isLoading: false })
    );
    mockedUseAsyncActivityStore.mockImplementation((selector) =>
      (selector as (s: { activeCount: number }) => unknown)({ activeCount: 0 })
    );

    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(result.current).toBe(true);
  });

  it('returns false when auth is loading', () => {
    mockedUseAuthStore.mockReturnValue(true);

    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBe(false);
  });

  it('returns false when streams are active', () => {
    mockedUseStreamingActivityStore.mockReturnValue(1);

    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBe(false);
  });

  it('returns false when async actions are pending (raw-fetch path)', () => {
    // Auth flows (resend, recovery save, etc.) call `useAsyncAction.run(...)`
    // which increments `useAsyncActivityStore`. settled-expect must wait for
    // those to resolve, not short-circuit while the underlying fetch is in
    // flight.
    mockedUseAsyncActivityStore.mockReturnValue(1);

    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(result.current).toBe(false);
  });

  it('returns true after debounce once async actions complete', () => {
    mockedUseAsyncActivityStore.mockReturnValue(1);
    const { result, rerender } = renderHook(() => useIsSettled(), {
      wrapper: createWrapper(),
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(false);

    mockedUseAsyncActivityStore.mockReturnValue(0);
    rerender();

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(result.current).toBe(true);
  });

  it('transitions from false to true when streams end', () => {
    mockedUseStreamingActivityStore.mockReturnValue(1);

    const { result, rerender } = renderHook(() => useIsSettled(), {
      wrapper: createWrapper(),
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(false);

    mockedUseStreamingActivityStore.mockReturnValue(0);
    rerender();

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(result.current).toBe(true);
  });

  it('transitions from false to true when auth finishes loading', () => {
    mockedUseAuthStore.mockReturnValue(true);

    const { result, rerender } = renderHook(() => useIsSettled(), {
      wrapper: createWrapper(),
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(false);

    mockedUseAuthStore.mockReturnValue(false);
    rerender();

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(result.current).toBe(true);
  });

  it('resets to false when activity starts during debounce', () => {
    const { result, rerender } = renderHook(() => useIsSettled(), {
      wrapper: createWrapper(),
    });

    // Advance partway through debounce
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe(false);

    // Start a stream before debounce completes
    mockedUseStreamingActivityStore.mockReturnValue(1);
    rerender();

    // Complete original debounce window
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current).toBe(false);
  });

  it('returns false when decryptions are pending', () => {
    mockedUseDecryptionActivityStore.mockReturnValue(1);

    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBe(false);
  });

  it('transitions from false to true when decryptions complete', () => {
    mockedUseDecryptionActivityStore.mockReturnValue(1);

    const { result, rerender } = renderHook(() => useIsSettled(), {
      wrapper: createWrapper(),
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(false);

    mockedUseDecryptionActivityStore.mockReturnValue(0);
    rerender();

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(result.current).toBe(true);
  });

  it('returns false when WebSocket inbound events are pending (past debounce)', () => {
    mockedUseWebsocketInboundActivityStore.mockReturnValue(1);

    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    // Past the debounce — if the WS counter wasn't part of isIdle, the
    // debounce would have fired and settled would be true.
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(result.current).toBe(false);
  });

  it('transitions from false to true when WebSocket inbound processing completes', () => {
    mockedUseWebsocketInboundActivityStore.mockReturnValue(1);

    const { result, rerender } = renderHook(() => useIsSettled(), {
      wrapper: createWrapper(),
    });

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(result.current).toBe(false);

    mockedUseWebsocketInboundActivityStore.mockReturnValue(0);
    rerender();

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(result.current).toBe(true);
  });

  it('returns false when both auth loading and streams active', () => {
    mockedUseAuthStore.mockReturnValue(true);
    mockedUseStreamingActivityStore.mockReturnValue(1);

    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBe(false);
  });
});
