import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { useA11yStore } from '../components/accessibility/store';
import { useAnimationFrame } from './use-animation-frame';

describe('useAnimationFrame', () => {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCAF = globalThis.cancelAnimationFrame;
  const originalMatchMedia = globalThis.matchMedia;

  let rafQueue: { id: number; callback: FrameRequestCallback }[];
  let nextRafId: number;

  function setupRAF(): {
    requestSpy: ReturnType<typeof vi.fn>;
    cancelSpy: ReturnType<typeof vi.fn>;
  } {
    rafQueue = [];
    nextRafId = 1;
    const requestSpy = vi.fn((callback: FrameRequestCallback) => {
      const id = nextRafId++;
      rafQueue.push({ id, callback });
      return id;
    });
    const cancelSpy = vi.fn((id: number) => {
      const index = rafQueue.findIndex((entry) => entry.id === id);
      if (index !== -1) rafQueue.splice(index, 1);
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      writable: true,
      configurable: true,
      value: requestSpy,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      writable: true,
      configurable: true,
      value: cancelSpy,
    });
    return { requestSpy, cancelSpy };
  }

  function setupMatchMedia(initialMatches: boolean): {
    mockMatchMedia: ReturnType<typeof vi.fn>;
    setMatches: (next: boolean) => void;
  } {
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    let currentMatches = initialMatches;
    const mockMatchMedia = vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return currentMatches;
      },
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((event: string, callback: (e: MediaQueryListEvent) => void) => {
        if (event === 'change') listeners.add(callback);
      }),
      removeEventListener: vi.fn((event: string, callback: (e: MediaQueryListEvent) => void) => {
        if (event === 'change') listeners.delete(callback);
      }),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      configurable: true,
      value: mockMatchMedia,
    });
    return {
      mockMatchMedia,
      setMatches: (next: boolean) => {
        currentMatches = next;
        for (const callback of listeners) callback({ matches: next } as MediaQueryListEvent);
      },
    };
  }

  function tickFrame(timestamp: number): void {
    const entry = rafQueue.shift();
    if (entry) entry.callback(timestamp);
  }

  beforeEach(() => {
    useA11yStore.getState().reset();
    vi.stubEnv('VITE_E2E', '');
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      writable: true,
      configurable: true,
      value: originalRAF,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      writable: true,
      configurable: true,
      value: originalCAF,
    });
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
    useA11yStore.getState().reset();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('invokes callback with timestamp on each animation frame', () => {
    setupRAF();
    setupMatchMedia(false);
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback);
    });

    tickFrame(100);
    tickFrame(200);
    tickFrame(300);

    expect(callback).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenNthCalledWith(1, 100);
    expect(callback).toHaveBeenNthCalledWith(2, 200);
    expect(callback).toHaveBeenNthCalledWith(3, 300);
  });

  it('schedules next frame after each tick (continuous loop)', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(false);

    renderHook(() => {
      useAnimationFrame(vi.fn());
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);

    tickFrame(16);
    expect(requestSpy).toHaveBeenCalledTimes(2);

    tickFrame(32);
    expect(requestSpy).toHaveBeenCalledTimes(3);
  });

  it('does not tick when paused=true', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(false);
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback, { paused: true });
    });

    expect(requestSpy).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not tick when respectMotion=true and prefers-reduced-motion matches', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(true);
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback, { respectMotion: true });
    });

    expect(requestSpy).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not tick when respectMotion=true and the a11y store stopAnimations flag is on', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(false);
    useA11yStore.getState().update({ stopAnimations: true });
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback, { respectMotion: true });
    });

    expect(requestSpy).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('defaults respectMotion to true (reduced motion blocks ticks)', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(true);
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback);
    });

    expect(requestSpy).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('still ticks when respectMotion=false even if reduced-motion sources are on', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(true);
    useA11yStore.getState().update({ stopAnimations: true });
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback, { respectMotion: false });
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);

    tickFrame(50);
    expect(callback).toHaveBeenCalledWith(50);
  });

  it('cancels in-flight rAF when component unmounts', () => {
    const { requestSpy, cancelSpy } = setupRAF();
    setupMatchMedia(false);

    const { unmount } = renderHook(() => {
      useAnimationFrame(vi.fn());
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const scheduledId = requestSpy.mock.results[0]?.value as number;

    unmount();

    expect(cancelSpy).toHaveBeenCalledWith(scheduledId);
  });

  it('uses the latest callback closure without re-subscribing rAF', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(false);

    const first = vi.fn();
    const second = vi.fn();

    const { rerender } = renderHook(
      ({ cb }: { cb: (timestamp: number) => void }) => {
        useAnimationFrame(cb);
      },
      { initialProps: { cb: first } }
    );

    expect(requestSpy).toHaveBeenCalledTimes(1);

    rerender({ cb: second });

    expect(requestSpy).toHaveBeenCalledTimes(1);

    tickFrame(123);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(123);
  });

  it('re-subscribes rAF when paused changes from true to false', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(false);

    const { rerender } = renderHook(
      ({ paused }: { paused: boolean }) => {
        useAnimationFrame(vi.fn(), { paused });
      },
      { initialProps: { paused: true } }
    );

    expect(requestSpy).not.toHaveBeenCalled();

    rerender({ paused: false });

    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('pauses ticks when the a11y store toggles stopAnimations on mid-loop', () => {
    const { requestSpy, cancelSpy } = setupRAF();
    setupMatchMedia(false);
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback);
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);
    tickFrame(10);
    expect(callback).toHaveBeenCalledTimes(1);

    act(() => {
      useA11yStore.getState().update({ stopAnimations: true });
    });

    // The next scheduled frame should be cancelled and no further frames scheduled.
    expect(cancelSpy).toHaveBeenCalled();
    const requestCountAfterToggle = requestSpy.mock.calls.length;
    tickFrame(20);
    expect(requestSpy.mock.calls.length).toBe(requestCountAfterToggle);
  });

  it('resumes ticks when reduced-motion turns off mid-session', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(false);
    useA11yStore.getState().update({ stopAnimations: true });
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback);
    });

    expect(requestSpy).not.toHaveBeenCalled();

    act(() => {
      useA11yStore.getState().update({ stopAnimations: false });
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);
    tickFrame(40);
    expect(callback).toHaveBeenCalledWith(40);
  });

  it('does not crash when window.matchMedia is unavailable', () => {
    const { requestSpy } = setupRAF();
    // @ts-expect-error — intentionally removing for test
    delete globalThis.matchMedia;

    const callback = vi.fn();

    expect(() => {
      renderHook(() => {
        useAnimationFrame(callback);
      });
    }).not.toThrow();

    expect(requestSpy).toHaveBeenCalledTimes(1);

    tickFrame(10);
    expect(callback).toHaveBeenCalledWith(10);
  });

  it('cleans up without cancelling when never started (reduced motion at mount)', () => {
    const { cancelSpy } = setupRAF();
    setupMatchMedia(true); // reduced → loop never starts, rafId stays null
    const callback = vi.fn();

    const { unmount } = renderHook(() => {
      useAnimationFrame(callback, { respectMotion: true });
    });

    // Cleanup calls stop() while rafId is null — the early-return guard.
    expect(() => {
      unmount();
    }).not.toThrow();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('stops the loop when reduced motion turns on mid-run, then restarts when it turns off', () => {
    const { requestSpy, cancelSpy } = setupRAF();
    setupMatchMedia(false);
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback);
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);

    // Turn reduced motion on: the subscriber runs stop() while a frame is queued.
    act(() => {
      useA11yStore.getState().update({ stopAnimations: true });
    });
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    // Turn it back off: the subscriber runs start() again.
    act(() => {
      useA11yStore.getState().update({ stopAnimations: false });
    });
    tickFrame(70);
    expect(callback).toHaveBeenCalledWith(70);
  });
});
